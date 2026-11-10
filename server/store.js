import { createClient } from 'redis';

const PREFIX = 'ghost:{coord}';
const sessionKey = (id) => `${PREFIX}:session:${id}`;
const codeKey = (code) => `${PREFIX}:code:${code}`;
const roomKey = (id) => `${PREFIX}:room:${id}`;
const matchKey = (id) => `${PREFIX}:match:${id}`;
const reportKey = (id) => `${PREFIX}:report:${id}`;
const instanceChannel = (id) => `${PREFIX}:instance:${id}`;

const AUTHORIZE_REQUEST = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {2} end
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[2]) end
if count > tonumber(ARGV[1]) then return {0} end
return {1, redis.call('HGETALL', KEYS[1])}
`;

const CREATE_ROOM = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local registeredPeerId = redis.call('HGET', KEYS[3], 'peerId') or ''
if registeredPeerId ~= '' and registeredPeerId ~= ARGV[1] then return -1 end
if redis.call('HGET', KEYS[3], 'status') ~= 'connected' then return -2 end
redis.call('HSET', KEYS[2], 'code', ARGV[2], 'hostSessionId', ARGV[3], 'hostInstanceId', ARGV[4], 'hostPeerId', ARGV[1], 'invitationHash', ARGV[7], 'pendingRequestId', '', 'pendingGuestSessionId', '', 'pendingGuestPeerId', '', 'guestSessionId', '', 'guestPeerId', '', 'authorization', '')
redis.call('EXPIRE', KEYS[2], ARGV[5])
redis.call('SET', KEYS[1], ARGV[6], 'EX', ARGV[5])
redis.call('HSET', KEYS[3], 'peerId', ARGV[1], 'mode', 'private-host', 'roomId', ARGV[6], 'status', 'waiting')
redis.call('EXPIRE', KEYS[3], ARGV[5])
return 1
`;

const REQUEST_JOIN = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
local registeredPeerId = redis.call('HGET', KEYS[3], 'peerId') or ''
if registeredPeerId ~= '' and registeredPeerId ~= ARGV[1] then return {'unregistered'} end
if redis.call('HGET', KEYS[3], 'status') ~= 'connected' then return {'busy'} end
local guest = redis.call('HGET', KEYS[1], 'guestSessionId') or ''
local pending = redis.call('HGET', KEYS[1], 'pendingGuestSessionId') or ''
if guest ~= '' or pending ~= '' then return {'full'} end
local hostSessionId = redis.call('HGET', KEYS[1], 'hostSessionId') or ''
local hostPeerId = redis.call('HGET', KEYS[1], 'hostPeerId') or ''
local host = '${PREFIX}:session:' .. hostSessionId
local hostInstanceId = redis.call('HGET', host, 'instanceId') or ''
if hostInstanceId == '' or redis.call('HGET', host, 'status') ~= 'waiting' then return {'missing'} end
local guestPeerId = redis.call('HGET', KEYS[3], 'peerId') or ''
local code = redis.call('HGET', KEYS[1], 'code') or ''
local roomId = redis.call('GET', KEYS[2]) or ''
local invitationHash = redis.call('HGET', KEYS[1], 'invitationHash') or ''
if ARGV[4] ~= '' then
  if invitationHash == '' or invitationHash ~= ARGV[4] then return {'invalid-invitation'} end
  redis.call('HSET', KEYS[1], 'guestSessionId', ARGV[3], 'guestPeerId', guestPeerId, 'authorization', ARGV[5])
  redis.call('HSET', KEYS[3], 'peerId', guestPeerId, 'roomId', roomId, 'mode', 'private-guest', 'status', 'connecting')
  redis.call('HSET', host, 'status', 'connecting')
  return {'authorized', hostSessionId, hostInstanceId, hostPeerId, guestPeerId, code, roomId}
end
redis.call('HSET', KEYS[1], 'pendingRequestId', ARGV[2], 'pendingGuestSessionId', ARGV[3], 'pendingGuestPeerId', guestPeerId)
redis.call('HSET', KEYS[3], 'peerId', ARGV[1], 'roomId', roomId, 'mode', 'private-guest', 'status', 'joining')
return {'pending', hostSessionId, hostInstanceId, hostPeerId, guestPeerId, code, roomId}
`;

const ACCEPT_JOIN = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if redis.call('HGET', KEYS[1], 'hostSessionId') ~= ARGV[1] then return {'unauthorized'} end
if redis.call('HGET', KEYS[1], 'pendingRequestId') ~= ARGV[2] then return {'expired'} end
local guestSessionId = redis.call('HGET', KEYS[1], 'pendingGuestSessionId') or ''
local guest = '${PREFIX}:session:' .. guestSessionId
local guestInstanceId = redis.call('HGET', guest, 'instanceId') or ''
local guestPeerId = redis.call('HGET', KEYS[1], 'pendingGuestPeerId') or ''
if guestInstanceId == '' or guestPeerId == '' then return {'expired'} end
redis.call('HSET', KEYS[1], 'guestSessionId', guestSessionId, 'guestPeerId', guestPeerId, 'authorization', ARGV[3], 'pendingRequestId', '', 'pendingGuestSessionId', '', 'pendingGuestPeerId', '')
redis.call('HSET', guest, 'mode', 'private-guest', 'roomId', ARGV[4], 'status', 'connecting')
redis.call('HSET', KEYS[2], 'status', 'connecting')
return {'accepted', guestSessionId, guestInstanceId, guestPeerId, redis.call('HGET', KEYS[1], 'hostPeerId') or '', redis.call('HGET', KEYS[1], 'code') or ''}
`;

const DECLINE_JOIN = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if redis.call('HGET', KEYS[1], 'hostSessionId') ~= ARGV[1] then return {'unauthorized'} end
if redis.call('HGET', KEYS[1], 'pendingRequestId') ~= ARGV[2] then return {'expired'} end
local guestSessionId = redis.call('HGET', KEYS[1], 'pendingGuestSessionId') or ''
local guest = '${PREFIX}:session:' .. guestSessionId
local guestInstanceId = redis.call('HGET', guest, 'instanceId') or ''
local code = redis.call('HGET', KEYS[1], 'code') or ''
redis.call('HSET', guest, 'roomId', '', 'mode', 'idle', 'status', 'connected')
redis.call('HSET', KEYS[1], 'pendingRequestId', '', 'pendingGuestSessionId', '', 'pendingGuestPeerId', '')
return {'declined', guestSessionId, guestInstanceId, code}
`;

const SEARCH_MATCH = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
local peerId = redis.call('HGET', KEYS[1], 'peerId') or ''
if peerId ~= '' and peerId ~= ARGV[1] then return {'unregistered'} end
peerId = ARGV[1]
local status = redis.call('HGET', KEYS[1], 'status') or ''
if status == 'matched' then return {'already-matched'} end
if status ~= 'connected' and status ~= 'searching' then return {'busy'} end
local initialQueue = redis.call('ZRANGE', KEYS[2], 0, 999)
for _, queuedSessionId in ipairs(initialQueue) do
  if queuedSessionId ~= ARGV[2] then
    local queued = '${PREFIX}:session:' .. queuedSessionId
    if redis.call('EXISTS', queued) == 0 or redis.call('HGET', queued, 'status') ~= 'searching' or redis.call('HGET', queued, 'peerId') == false then
      redis.call('ZREM', KEYS[2], queuedSessionId)
    end
  end
end
if redis.call('ZCARD', KEYS[2]) >= 1000 and not redis.call('ZSCORE', KEYS[2], ARGV[2]) then return {'full'} end
redis.call('HSET', KEYS[1], 'peerId', peerId, 'mode', 'matchmaking', 'status', 'searching')
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('ZADD', KEYS[2], 'NX', ARGV[5], ARGV[2])
local candidates = redis.call('ZRANGE', KEYS[2], 0, 999)
for _, candidate in ipairs(candidates) do
  if candidate ~= ARGV[2] then
    local other = '${PREFIX}:session:' .. candidate
    local otherPeerId = redis.call('HGET', other, 'peerId') or ''
    local otherStatus = redis.call('HGET', other, 'status') or ''
    local otherInstanceId = redis.call('HGET', other, 'instanceId') or ''
    if otherPeerId ~= '' and otherStatus == 'searching' and otherInstanceId ~= '' then
      redis.call('ZREM', KEYS[2], candidate, ARGV[2])
      redis.call('HSET', other, 'status', 'matched', 'matchId', ARGV[3])
      redis.call('HSET', KEYS[1], 'status', 'matched', 'matchId', ARGV[3])
      redis.call('HSET', KEYS[3], 'sessionA', candidate, 'peerA', otherPeerId, 'instanceA', otherInstanceId, 'sessionB', ARGV[2], 'peerB', peerId, 'instanceB', ARGV[6], 'authorization', ARGV[7])
      redis.call('EXPIRE', KEYS[3], ARGV[4])
      return {'matched', candidate, otherPeerId, otherInstanceId, peerId, ARGV[6]}
    end
    redis.call('ZREM', KEYS[2], candidate)
  end
end
return {'queued', tostring(redis.call('ZCARD', KEYS[2]))}
`;

const CANCEL_SEARCH = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('HGET', KEYS[2], 'status') == 'searching' then
  redis.call('HSET', KEYS[2], 'status', 'connected', 'mode', 'idle')
end
return redis.call('ZCARD', KEYS[1])
`;

const CLOSE_ROOM = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if redis.call('HGET', KEYS[1], 'hostSessionId') ~= ARGV[1] then return {'unauthorized'} end
local guest = redis.call('HGET', KEYS[1], 'guestSessionId') or ''
local pending = redis.call('HGET', KEYS[1], 'pendingGuestSessionId') or ''
local guestInstance = ''
if guest ~= '' then guestInstance = redis.call('HGET', '${PREFIX}:session:' .. guest, 'instanceId') or '' end
local pendingInstance = ''
if pending ~= '' then pendingInstance = redis.call('HGET', '${PREFIX}:session:' .. pending, 'instanceId') or '' end
local code = redis.call('HGET', KEYS[1], 'code') or ''
local roomId = redis.call('GET', KEYS[2]) or ''
redis.call('DEL', KEYS[1], KEYS[2])
if redis.call('EXISTS', KEYS[3]) == 1 then redis.call('HSET', KEYS[3], 'roomId', '', 'mode', 'idle', 'status', 'connected') end
if guest ~= '' and redis.call('EXISTS', '${PREFIX}:session:' .. guest) == 1 then redis.call('HSET', '${PREFIX}:session:' .. guest, 'roomId', '', 'mode', 'idle', 'status', 'connected') end
if pending ~= '' and redis.call('EXISTS', '${PREFIX}:session:' .. pending) == 1 then redis.call('HSET', '${PREFIX}:session:' .. pending, 'roomId', '', 'mode', 'idle', 'status', 'connected') end
return {'closed', guest, guestInstance, pending, pendingInstance, code, roomId}
`;

const RELEASE_MATCH = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
local a = redis.call('HGET', KEYS[1], 'sessionA') or ''
local b = redis.call('HGET', KEYS[1], 'sessionB') or ''
if ARGV[1] ~= a and ARGV[1] ~= b then return {'unauthorized'} end
local other = a == ARGV[1] and b or a
local otherInstance = a == ARGV[1] and (redis.call('HGET', KEYS[1], 'instanceB') or '') or (redis.call('HGET', KEYS[1], 'instanceA') or '')
if redis.call('EXISTS', '${PREFIX}:session:' .. other) == 1 then redis.call('HSET', '${PREFIX}:session:' .. other, 'status', 'connected', 'mode', 'idle', 'matchId', '') end
if redis.call('EXISTS', '${PREFIX}:session:' .. ARGV[1]) == 1 then redis.call('HSET', '${PREFIX}:session:' .. ARGV[1], 'status', 'connected', 'mode', 'idle', 'matchId', '') end
redis.call('DEL', KEYS[1])
return {'released', other, otherInstance}
`;

const SAVE_REPORT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
local a = redis.call('HGET', KEYS[1], 'sessionA') or ''
local b = redis.call('HGET', KEYS[1], 'sessionB') or ''
if ARGV[1] ~= a and ARGV[1] ~= b then return {'unauthorized'} end
if redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4], 'NX') == false then return {'duplicate'} end
local target = a == ARGV[1] and b or a
local report = cjson.decode(ARGV[3])
report.reportedSessionId = target
redis.call('SET', KEYS[3], cjson.encode(report), 'EX', ARGV[4])
redis.call('ZADD', KEYS[4], ARGV[5], ARGV[2])
redis.call('EXPIRE', KEYS[4], tonumber(ARGV[4]) + 86400)
return {'saved', target}
`;

export function createMemoryStore(shared = createMemoryState()) {
  const instanceCallbacks = shared.instances;
  return {
    async attachInstance(instanceId, callback) {
      instanceCallbacks.set(instanceId, callback);
    },
    async createSession(session) {
      shared.sessions.set(session.sessionId, { ...session, peerId: '', mode: 'idle', status: 'connected', roomId: '', matchId: '' });
    },
    async getSession(id) {
      return shared.sessions.get(id) || null;
    },
    async authorizeRequest(id, action, limit, windowMs) {
      const allowed = await this.rateLimit(id, action, limit, windowMs);
      if (!allowed) return { allowed: false, limited: true, session: null };
      return { allowed: true, limited: false, session: await this.getSession(id) };
    },
    async touchSession() {},
    async registerPeer(sessionId, peerId) {
      const session = shared.sessions.get(sessionId);
      if (!session || (session.status !== 'connected' && session.peerId !== peerId)) return false;
      session.peerId = peerId;
      return true;
    },
    async createRoom({ sessionId, instanceId, peerId, roomCode, roomId, invitationHash, ttl }) {
      const session = shared.sessions.get(sessionId);
      if (!session || (session.peerId && session.peerId !== peerId)) return false;
      if (session.status !== 'connected') return false;
      if (shared.codeToRoom.has(roomCode)) return false;
      const room = { roomCode, roomId, hostSessionId: sessionId, hostInstanceId: instanceId, hostPeerId: peerId, invitationHash, pendingRequestId: null, pendingGuestSessionId: null, pendingGuestPeerId: null, guestSessionId: null, guestPeerId: null, authorization: null };
      shared.rooms.set(roomId, room);
      shared.codeToRoom.set(roomCode, roomId);
      session.peerId = peerId;
      session.roomId = roomId;
      session.mode = 'private-host';
      session.status = 'waiting';
      session.expiresAt = Date.now() + ttl * 1000;
      return true;
    },
    async requestJoin({ roomCode, guestSessionId, peerId, requestId, invitationHash = '', authorization = '' }) {
      const roomId = shared.codeToRoom.get(roomCode);
      const room = roomId && shared.rooms.get(roomId);
      const guest = shared.sessions.get(guestSessionId);
      if (!room) return { status: 'missing' };
      if (!guest || (guest.peerId && guest.peerId !== peerId)) return { status: 'unregistered' };
      if (guest.status !== 'connected') return { status: 'busy' };
      if (room.guestSessionId || room.pendingGuestSessionId) return { status: 'full' };
      const host = shared.sessions.get(room.hostSessionId);
      if (!host || host.status !== 'waiting') return { status: 'missing' };
      if (invitationHash) {
        if (!room.invitationHash || room.invitationHash !== invitationHash) return { status: 'invalid-invitation' };
        room.guestSessionId = guestSessionId;
        guest.peerId = peerId;
        room.guestPeerId = guest.peerId;
        room.authorization = authorization;
        guest.roomId = roomId;
        guest.mode = 'private-guest';
        guest.status = 'connecting';
        host.status = 'connecting';
        return { status: 'authorized', roomId, hostSessionId: room.hostSessionId, hostInstanceId: room.hostInstanceId, hostPeerId: room.hostPeerId, guestPeerId: guest.peerId };
      }
      room.pendingRequestId = requestId;
      room.pendingGuestSessionId = guestSessionId;
      room.pendingGuestPeerId = peerId;
      guest.peerId = peerId;
      guest.roomId = roomId;
      guest.mode = 'private-guest';
      guest.status = 'joining';
      return { status: 'pending', roomId, hostSessionId: room.hostSessionId, hostInstanceId: room.hostInstanceId, hostPeerId: room.hostPeerId, guestPeerId: guest.peerId };
    },
    async acceptJoin({ roomCode, hostSessionId, requestId, authorization }) {
      const roomId = shared.codeToRoom.get(roomCode);
      const room = roomId && shared.rooms.get(roomId);
      if (!room) return { status: 'missing' };
      if (room.hostSessionId !== hostSessionId) return { status: 'unauthorized' };
      if (room.pendingRequestId !== requestId) return { status: 'expired' };
      const guest = shared.sessions.get(room.pendingGuestSessionId);
      if (!guest) return { status: 'expired' };
      const host = shared.sessions.get(hostSessionId);
      Object.assign(room, { guestSessionId: guest.sessionId, guestPeerId: room.pendingGuestPeerId, authorization, pendingRequestId: null, pendingGuestSessionId: null, pendingGuestPeerId: null });
      if (host) host.status = 'connecting';
      guest.mode = 'private-guest';
      guest.status = 'connecting';
      return { status: 'accepted', roomId, guestSessionId: guest.sessionId, guestInstanceId: guest.instanceId, guestPeerId: room.guestPeerId, hostPeerId: room.hostPeerId };
    },
    async declineJoin({ roomCode, hostSessionId, requestId }) {
      const room = shared.rooms.get(shared.codeToRoom.get(roomCode));
      if (!room) return { status: 'missing' };
      if (room.hostSessionId !== hostSessionId) return { status: 'unauthorized' };
      if (room.pendingRequestId !== requestId) return { status: 'expired' };
      const guest = shared.sessions.get(room.pendingGuestSessionId);
      const result = { status: 'declined', guestSessionId: guest?.sessionId, guestInstanceId: guest?.instanceId };
      if (guest) { guest.roomId = ''; guest.mode = 'idle'; guest.status = 'connected'; }
      room.pendingRequestId = null;
      room.pendingGuestSessionId = null;
      room.pendingGuestPeerId = null;
      return result;
    },
    async closeRoom({ roomCode, hostSessionId }) {
      const roomId = shared.codeToRoom.get(roomCode);
      const room = roomId && shared.rooms.get(roomId);
      if (!room) return { status: 'missing' };
      if (room.hostSessionId !== hostSessionId) return { status: 'unauthorized' };
      const result = { status: 'closed', roomId, guestSessionId: room.guestSessionId, pendingGuestSessionId: room.pendingGuestSessionId };
      shared.rooms.delete(roomId);
      shared.codeToRoom.delete(roomCode);
      for (const target of [room.guestSessionId, room.pendingGuestSessionId]) {
        const guest = target && shared.sessions.get(target);
        if (guest) { guest.roomId = ''; guest.mode = 'idle'; guest.status = 'connected'; }
      }
      const host = shared.sessions.get(hostSessionId);
      if (host) { host.roomId = ''; host.mode = 'idle'; host.status = 'connected'; }
      return result;
    },
    async search({ sessionId, instanceId, peerId, matchId, authorization, ttl }) {
      const session = shared.sessions.get(sessionId);
      if (!session || (session.peerId && session.peerId !== peerId)) return { status: 'unregistered' };
      if (session.status === 'matched') return { status: 'already-matched' };
      if (session.status !== 'connected' && session.status !== 'searching') return { status: 'busy' };
      if (shared.queue.length >= 1000 && !shared.queue.includes(sessionId)) return { status: 'full' };
      session.mode = 'matchmaking';
      session.peerId = peerId;
      session.status = 'searching';
      const other = shared.queue.map((id) => shared.sessions.get(id)).find((candidate) => candidate && candidate.sessionId !== sessionId && candidate.status === 'searching' && candidate.peerId);
      if (!other) {
        if (!shared.queue.includes(sessionId)) shared.queue.push(sessionId);
        return { status: 'queued', position: shared.queue.length };
      }
      shared.queue = shared.queue.filter((id) => id !== other.sessionId && id !== sessionId);
      session.status = 'matched';
      session.matchId = matchId;
      other.status = 'matched';
      other.matchId = matchId;
      shared.matches.set(matchId, { sessionA: other.sessionId, sessionB: sessionId, instanceA: other.instanceId, instanceB: instanceId });
      return { status: 'matched', matchId, authorization, otherSessionId: other.sessionId, otherInstanceId: other.instanceId, otherPeerId: other.peerId, peerId, role: sessionId.localeCompare(other.sessionId) < 0 ? 'initiator' : 'receiver', otherRole: other.sessionId.localeCompare(sessionId) < 0 ? 'initiator' : 'receiver' };
    },
    async cancelSearch(sessionId) {
      shared.queue = shared.queue.filter((id) => id !== sessionId);
      const session = shared.sessions.get(sessionId);
      if (session?.status === 'searching') { session.status = 'connected'; session.mode = 'idle'; }
      return { status: 'canceled' };
    },
    async releaseMatch({ matchId, sessionId }) {
      const match = shared.matches.get(matchId);
      if (!match) return { status: 'missing' };
      if (match.sessionA !== sessionId && match.sessionB !== sessionId) return { status: 'unauthorized' };
      const otherSessionId = match.sessionA === sessionId ? match.sessionB : match.sessionA;
      const other = shared.sessions.get(otherSessionId);
      const current = shared.sessions.get(sessionId);
      if (other) { other.matchId = ''; other.status = 'connected'; other.mode = 'idle'; }
      if (current) { current.matchId = ''; current.status = 'connected'; current.mode = 'idle'; }
      shared.matches.delete(matchId);
      return { status: 'released', otherSessionId, otherInstanceId: other?.instanceId };
    },
    async submitReport({ report, sessionId, retentionSeconds }) {
      const match = shared.matches.get(report.matchId);
      if (!match) return { status: 'missing' };
      if (match.sessionA !== sessionId && match.sessionB !== sessionId) return { status: 'unauthorized' };
      const onceKey = `${report.matchId}:${sessionId}`;
      if (shared.reportSubmissions.has(onceKey)) return { status: 'duplicate' };
      shared.reportSubmissions.add(onceKey);
      const reportedSessionId = match.sessionA === sessionId ? match.sessionB : match.sessionA;
      shared.reports.set(report.id, { ...report, reportedSessionId, expiresAt: Date.now() + retentionSeconds * 1000 });
      return { status: 'saved' };
    },
    async listReports(limit = 100) {
      const now = Date.now();
      for (const [id, report] of shared.reports) if (report.expiresAt <= now) shared.reports.delete(id);
      return [...shared.reports.values()].sort((left, right) => right.createdAt - left.createdAt).slice(0, limit).map(({ expiresAt, ...report }) => report);
    },
    async deleteReport(id) {
      return shared.reports.delete(id);
    },
    async rateLimit(sessionId, action, limit, windowMs) {
      const key = `${sessionId}:${action}`;
      const now = Date.now();
      const state = shared.rates.get(key);
      if (!state || now - state.startedAt >= windowMs) {
        shared.rates.set(key, { startedAt: now, count: 1 });
        return true;
      }
      state.count += 1;
      return state.count <= limit;
    },
    async removeSession(sessionId) {
      const session = shared.sessions.get(sessionId);
      if (!session) return [];
      const notifications = [];
      for (const [roomId, room] of shared.rooms) {
        if (room.hostSessionId === sessionId) {
          shared.rooms.delete(roomId);
          shared.codeToRoom.delete(room.roomCode);
          for (const target of [room.guestSessionId, room.pendingGuestSessionId]) {
            if (target && target !== sessionId) notifications.push({ sessionId: target, payload: { type: 'room.closed', roomCode: room.roomCode, reason: 'The host left the room.' } });
          }
        } else if (room.guestSessionId === sessionId || room.pendingGuestSessionId === sessionId) {
          room.guestSessionId = null;
          room.guestPeerId = null;
          room.authorization = null;
          room.pendingGuestSessionId = null;
          room.pendingGuestPeerId = null;
          room.pendingRequestId = null;
          const host = shared.sessions.get(room.hostSessionId);
          if (host) host.status = 'waiting';
        }
      }
      shared.queue = shared.queue.filter((id) => id !== sessionId);
      if (session.matchId) {
        const released = await this.releaseMatch({ matchId: session.matchId, sessionId });
        if (released.otherSessionId) notifications.push({ sessionId: released.otherSessionId, payload: { type: 'match.ended', matchId: session.matchId } });
      }
      shared.sessions.delete(sessionId);
      return notifications;
    },
    async deliver(sessionId, payload) {
      const session = shared.sessions.get(sessionId);
      if (session) instanceCallbacks.get(session.instanceId)?.(sessionId, payload);
    },
    async close() {},
  };
}

export function createMemoryState() {
  return { sessions: new Map(), rooms: new Map(), codeToRoom: new Map(), queue: [], matches: new Map(), rates: new Map(), instances: new Map(), reports: new Map(), reportSubmissions: new Set() };
}

export function createRedisStore(redisUrl) {
  const client = createClient({ url: redisUrl });
  const subscriber = client.duplicate();
  let instanceId;
  let onInstanceEvent = () => {};

  client.on('error', (error) => console.error('[GhostChat] Redis command client error', error.message));
  subscriber.on('error', (error) => console.error('[GhostChat] Redis subscriber error', error.message));

  return {
    async attachInstance(id, callback) {
      const initializationStartedAt = performance.now();
      instanceId = id;
      onInstanceEvent = callback;
      await Promise.all([client.connect(), subscriber.connect()]);
      await subscriber.subscribe(instanceChannel(id), (message) => {
        try {
          const event = JSON.parse(message);
          if (event && event.sessionId && event.payload) onInstanceEvent(event.sessionId, event.payload);
        } catch (error) {
          console.error('[GhostChat] invalid Redis event', error.message);
        }
      });
      console.info('[GhostChat timing] redis.instance.ready', JSON.stringify({ durationMs: performance.now() - initializationStartedAt }));
    },
    async createSession(session) {
      await client.hSet(sessionKey(session.sessionId), { instanceId: session.instanceId, peerId: '', mode: 'idle', status: 'connected', roomId: '', matchId: '' });
      await client.expire(sessionKey(session.sessionId), 90);
    },
    async getSession(id) {
      const values = await client.hGetAll(sessionKey(id));
      return Object.keys(values).length ? { sessionId: id, ...values } : null;
    },
    async authorizeRequest(id, action, limit, windowMs) {
      const rateKey = `${PREFIX}:rate:${id}:${action}`;
      const result = await client.eval(AUTHORIZE_REQUEST, {
        keys: [sessionKey(id), rateKey],
        arguments: [String(limit), String(windowMs)],
      });
      const status = Number(result[0]);
      if (status !== 1) return { allowed: false, limited: status === 0, session: null };
      const fields = result[1];
      const session = { sessionId: id };
      for (let index = 0; index < fields.length; index += 2) session[fields[index]] = fields[index + 1];
      return { allowed: true, limited: false, session };
    },
    async touchSession(id) {
      await client.eval(`
        redis.call('EXPIRE', KEYS[1], 90)
        local roomId = redis.call('HGET', KEYS[1], 'roomId') or ''
        if roomId ~= '' then
          local room = '${PREFIX}:room:' .. roomId
          redis.call('EXPIRE', room, 900)
          local code = redis.call('HGET', room, 'code') or ''
          if code ~= '' then redis.call('EXPIRE', '${PREFIX}:code:' .. code, 900) end
        end
        local matchId = redis.call('HGET', KEYS[1], 'matchId') or ''
        if matchId ~= '' then redis.call('EXPIRE', '${PREFIX}:match:' .. matchId, 900) end
        return 1
      `, { keys: [sessionKey(id)], arguments: [] });
    },
    async registerPeer(id, peerId) {
      const result = await client.eval(`if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end; local status = redis.call('HGET', KEYS[1], 'status') or ''; local current = redis.call('HGET', KEYS[1], 'peerId') or ''; if status ~= 'connected' and current ~= ARGV[1] then return 0 end; redis.call('HSET', KEYS[1], 'peerId', ARGV[1]); return 1`, { keys: [sessionKey(id)], arguments: [peerId] });
      return Number(result) === 1;
    },
    async createRoom({ sessionId, instanceId: ownerInstance, peerId, roomCode, roomId, invitationHash, ttl }) {
      return Number(await client.eval(CREATE_ROOM, {
        keys: [codeKey(roomCode), roomKey(roomId), sessionKey(sessionId)],
        arguments: [peerId, roomCode, sessionId, ownerInstance, String(ttl), roomId, invitationHash],
      })) === 1;
    },
    async requestJoin({ roomCode, guestSessionId, peerId, requestId, invitationHash = '', authorization = '' }) {
      const roomId = await client.get(codeKey(roomCode));
      if (!roomId) return { status: 'missing' };
      const result = await client.eval(REQUEST_JOIN, {
        keys: [roomKey(roomId), codeKey(roomCode), sessionKey(guestSessionId)],
        arguments: [peerId, requestId, guestSessionId, invitationHash, authorization],
      });
      const [status, hostSessionId, hostInstanceId, hostPeerId, guestPeerId, code, resolvedRoomId] = result.map(String);
      return { status, hostSessionId, hostInstanceId, hostPeerId, guestPeerId, roomCode: code, roomId: resolvedRoomId };
    },
    async acceptJoin({ roomCode, hostSessionId, requestId, authorization }) {
      const roomId = await client.get(codeKey(roomCode));
      if (!roomId) return { status: 'missing' };
      const result = await client.eval(ACCEPT_JOIN, {
        keys: [roomKey(roomId), sessionKey(hostSessionId)],
        arguments: [hostSessionId, requestId, authorization, roomId],
      });
      const [status, guestSessionId, guestInstanceId, guestPeerId, hostPeerId] = result.map(String);
      return { status, roomId, guestSessionId, guestInstanceId, guestPeerId, hostPeerId };
    },
    async declineJoin({ roomCode, hostSessionId, requestId }) {
      const roomId = await client.get(codeKey(roomCode));
      if (!roomId) return { status: 'missing' };
      const result = await client.eval(DECLINE_JOIN, {
        keys: [roomKey(roomId)],
        arguments: [hostSessionId, requestId],
      });
      const [status, guestSessionId, guestInstanceId] = result.map(String);
      return { status, guestSessionId, guestInstanceId };
    },
    async closeRoom({ roomCode, hostSessionId }) {
      const roomId = await client.get(codeKey(roomCode));
      if (!roomId) return { status: 'missing' };
      const result = await client.eval(CLOSE_ROOM, {
        keys: [roomKey(roomId), codeKey(roomCode), sessionKey(hostSessionId)],
        arguments: [hostSessionId],
      });
      const [status, guestSessionId, guestInstanceId, pendingGuestSessionId, pendingGuestInstanceId] = result.map(String);
      return { status, roomId, guestSessionId, guestInstanceId, pendingGuestSessionId, pendingGuestInstanceId };
    },
    async search({ sessionId, instanceId: ownerInstance, peerId, matchId, authorization, ttl }) {
      const result = await client.eval(SEARCH_MATCH, {
        keys: [sessionKey(sessionId), `${PREFIX}:queue`, matchKey(matchId)],
        arguments: [peerId, sessionId, matchId, String(ttl), String(Date.now()), ownerInstance, authorization],
      });
      const [status, otherSessionId, otherPeerId, otherInstanceId, currentPeerId] = result.map(String);
      if (status !== 'matched') return { status, position: Number(otherSessionId) || undefined };
      const role = sessionId.localeCompare(otherSessionId) < 0 ? 'initiator' : 'receiver';
      return { status, matchId, authorization, otherSessionId, otherPeerId, otherInstanceId, peerId: currentPeerId, role, otherRole: role === 'initiator' ? 'receiver' : 'initiator' };
    },
    async cancelSearch(sessionId) {
      await client.eval(CANCEL_SEARCH, { keys: [`${PREFIX}:queue`, sessionKey(sessionId)], arguments: [sessionId] });
      return { status: 'canceled' };
    },
    async releaseMatch({ matchId, sessionId }) {
      const result = await client.eval(RELEASE_MATCH, { keys: [matchKey(matchId)], arguments: [sessionId] });
      const [status, otherSessionId, otherInstanceId] = result.map(String);
      return { status, otherSessionId, otherInstanceId };
    },
    async submitReport({ report, sessionId, retentionSeconds }) {
      const onceKey = `${PREFIX}:report-once:${report.matchId}:${sessionId}`;
      const result = await client.eval(SAVE_REPORT, {
        keys: [matchKey(report.matchId), onceKey, reportKey(report.id), `${PREFIX}:reports`],
        arguments: [sessionId, report.id, JSON.stringify(report), String(retentionSeconds), String(report.createdAt)],
      });
      const [status, reportedSessionId] = result.map(String);
      return { status, reportedSessionId };
    },
    async listReports(limit = 100) {
      const ids = await client.zRange(`${PREFIX}:reports`, 0, Math.max(0, limit - 1), { REV: true });
      if (ids.length === 0) return [];
      const values = await client.mGet(ids.map(reportKey));
      const reports = [];
      for (let index = 0; index < ids.length; index += 1) {
        if (values[index]) reports.push(JSON.parse(values[index]));
        else await client.zRem(`${PREFIX}:reports`, ids[index]);
      }
      return reports;
    },
    async deleteReport(id) {
      const deleted = await client.del(reportKey(id));
      await client.zRem(`${PREFIX}:reports`, id);
      return deleted > 0;
    },
    async rateLimit(sessionId, action, limit, windowMs) {
      const key = `${PREFIX}:rate:${sessionId}:${action}`;
      const count = await client.incr(key);
      if (count === 1) await client.pExpire(key, windowMs);
      return count <= limit;
    },
    async removeSession(sessionId) {
      const session = await this.getSession(sessionId);
      if (!session) return [];
      const notifications = [];
      await this.cancelSearch(sessionId);
      if (session.roomId) {
        const room = await client.hGetAll(roomKey(session.roomId));
        if (room.hostSessionId === sessionId) {
          const closed = await this.closeRoom({ roomCode: room.code, hostSessionId: sessionId });
          for (const target of [[closed.guestSessionId, closed.guestInstanceId], [closed.pendingGuestSessionId, closed.pendingGuestInstanceId]]) {
            if (target[0] && target[1]) notifications.push({ sessionId: target[0], instanceId: target[1], payload: { type: 'room.closed', roomCode: room.code, reason: 'The host left the room.' } });
          }
        } else {
          await client.eval(`local host = redis.call('HGET', KEYS[1], 'hostSessionId') or ''; if redis.call('HGET', KEYS[1], 'guestSessionId') == ARGV[1] then redis.call('HSET', KEYS[1], 'guestSessionId', '', 'guestPeerId', '', 'authorization', ''); redis.call('HSET', '${PREFIX}:session:' .. host, 'status', 'waiting') end; if redis.call('HGET', KEYS[1], 'pendingGuestSessionId') == ARGV[1] then redis.call('HSET', KEYS[1], 'pendingGuestSessionId', '', 'pendingGuestPeerId', '', 'pendingRequestId', '') end; return 1`, { keys: [roomKey(session.roomId)], arguments: [sessionId] });
        }
      }
      if (session.matchId) {
        const released = await this.releaseMatch({ matchId: session.matchId, sessionId });
        if (released.otherSessionId && released.otherInstanceId) notifications.push({ sessionId: released.otherSessionId, instanceId: released.otherInstanceId, payload: { type: 'match.ended', matchId: session.matchId } });
      }
      await client.del(sessionKey(sessionId));
      return notifications;
    },
    async deliver(sessionId, payload) {
      const session = await this.getSession(sessionId);
      if (session?.instanceId) await client.publish(instanceChannel(session.instanceId), JSON.stringify({ sessionId, payload }));
    },
    async close() {
      await Promise.allSettled([subscriber.quit(), client.quit()]);
    },
  };
}
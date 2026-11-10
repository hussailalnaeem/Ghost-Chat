import crypto from 'node:crypto';
import { createMemoryStore, createRedisStore } from './store.js';

const ROOM_TTL_SECONDS = 15 * 60;
const MATCH_TTL_SECONDS = 3 * 60;
const REPORT_RETENTION_SECONDS = 14 * 24 * 60 * 60;
const REPORT_REASONS = new Set(['harassment', 'spam', 'threats', 'inappropriate', 'other']);

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function normalizeCode(value) {
  return typeof value === 'string' && /^[A-Za-z]{4}$/.test(value) ? value.toUpperCase() : null;
}

function validPeerId(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 160 && /^[A-Za-z0-9_-]+$/.test(value);
}

function allowedOrigin(origin, request, configuredOrigins) {
  if (!origin) return true;
  try {
    const parsedOrigin = new URL(origin).origin;
    const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || (request.socket?.encrypted ? 'https' : 'http');
    const host = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0].trim();
    const requestOrigin = host ? `${protocol}://${host}` : '';
    return parsedOrigin === requestOrigin || configuredOrigins.has(parsedOrigin);
  } catch {
    return false;
  }
}

function send(socket, payload) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function response(type, requestId, fields = {}) {
  return { type, requestId, ...fields };
}

export function createCoordinatorService({ redisUrl = process.env.REDIS_URL, store: providedStore, requireRedis = false, reportAdminToken = process.env.REPORT_ADMIN_TOKEN || '', allowedOrigins = process.env.ALLOWED_ORIGINS || '' } = {}) {
  const instanceId = crypto.randomUUID();
  const store = providedStore || (redisUrl ? createRedisStore(redisUrl) : createMemoryStore());
  const configuredOrigins = new Set(String(allowedOrigins).split(',').map((item) => item.trim()).filter(Boolean));
  const sockets = new Map();
  const ready = store.attachInstance(instanceId, (sessionId, payload) => {
    const socket = sockets.get(sessionId);
    if (socket) send(socket, payload);
  });

  async function deliver(sessionId, payload, explicitInstanceId) {
    if (explicitInstanceId && explicitInstanceId === instanceId) {
      const socket = sockets.get(sessionId);
      if (socket) send(socket, payload);
      return;
    }
    await store.deliver(sessionId, payload);
  }

  async function handleMessage(socket, sessionId, requestId, message, sendResponse) {
    const requestReceivedAt = Date.now();
    const requestStartedAt = performance.now();
    const storeOperations = [];
    const measureStore = async (name, operation) => {
      const startedAt = performance.now();
      try {
        return await operation();
      } finally {
        storeOperations.push({ name, durationMs: performance.now() - startedAt });
      }
    };
    const reply = (payload) => sendResponse({
      ...payload,
      serverTiming: {
        receivedAt: requestReceivedAt,
        completedAt: Date.now(),
        durationMs: performance.now() - requestStartedAt,
        storeOperations,
      },
    });
    const fail = (reason) => reply(response('error', requestId, { message: reason }));
    const authorization = await measureStore('request.authorize', () => store.authorizeRequest(
      sessionId,
      message.type,
      message.type.startsWith('room.') || message.type.startsWith('match.') ? 30 : 90,
      60_000,
    ));
    if (!authorization.allowed) {
      return fail(authorization.limited ? 'Too many requests. Please wait a moment.' : 'Session expired. Return home and try again.');
    }

    const session = authorization.session;
    if (!session) return fail('Session expired. Return home and try again.');
    if (message.sessionId && message.sessionId !== sessionId) return fail('Unauthorized session.');

    switch (message.type) {
      case 'peer.register': {
        if (!validPeerId(message.peerId)) return fail('Invalid PeerJS identity.');
        if (session.peerId && session.peerId !== message.peerId) return fail('A PeerJS identity is already registered for this session.');
        if (!await measureStore('peer.register', () => store.registerPeer(sessionId, message.peerId))) return fail('Session expired. Return home and try again.');
        reply(response('peer.registered', requestId, { peerId: message.peerId }));
        return;
      }

      case 'room.create': {
        if (!validPeerId(message.peerId) || (session.peerId && session.peerId !== message.peerId)) return fail('Register your PeerJS identity before creating a room.');
        if (session.status !== 'connected') return fail('End your current chat before creating another room.');
        const invitationToken = randomToken();
        const invitationHash = hashToken(invitationToken);
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const roomCode = Array.from({ length: 4 }, () => String.fromCharCode(65 + crypto.randomInt(26))).join('');
          const roomId = crypto.randomUUID();
          const created = await measureStore('room.create', () => store.createRoom({ sessionId, instanceId, peerId: message.peerId, roomCode, roomId, invitationHash, ttl: ROOM_TTL_SECONDS }));
          if (created) {
            reply(response('room.created', requestId, { roomCode, roomId, hostPeerId: session.peerId, invitationToken }));
            return;
          }
        }
        return fail('Could not allocate a room. Please try again.');
      }

      case 'room.join.request': {
        const roomCode = normalizeCode(message.roomCode);
        if (!roomCode) return fail('Enter a valid four-letter room code.');
        if (!validPeerId(message.peerId) || (session.peerId && session.peerId !== message.peerId)) return fail('Register your PeerJS identity before joining a room.');
        if (session.status !== 'connected') return fail('End your current chat before joining another room.');
        const suppliedToken = typeof message.invitationToken === 'string' ? message.invitationToken : '';
        if (suppliedToken && !/^[A-Za-z0-9_-]{32}$/.test(suppliedToken)) return fail('This invitation link is invalid or expired.');
        const joinRequestId = crypto.randomUUID();
        const authorization = suppliedToken ? randomToken() : '';
        const result = await measureStore('room.join.request', () => store.requestJoin({
          roomCode,
          guestSessionId: sessionId,
          peerId: message.peerId,
          requestId: joinRequestId,
          invitationHash: suppliedToken ? hashToken(suppliedToken) : '',
          authorization,
        }));
        if (result.status === 'missing') return fail('Room not found.');
        if (result.status === 'full') return fail('Room is full.');
        if (result.status === 'busy') return fail('End your current chat before joining another room.');
        if (result.status === 'invalid-invitation') return fail('This invitation link is invalid or expired.');
        if (result.status === 'authorized') {
          await deliver(result.hostSessionId, {
            type: 'room.join.authorized',
            eventId: crypto.randomUUID(),
            role: 'host',
            roomCode,
            roomId: result.roomId,
            hostPeerId: result.hostPeerId,
            guestPeerId: result.guestPeerId,
            authorization,
          }, result.hostInstanceId);
          reply(response('room.join.authorized', requestId, {
            role: 'guest',
            roomCode,
            roomId: result.roomId,
            hostPeerId: result.hostPeerId,
            guestPeerId: result.guestPeerId,
            authorization,
          }));
          return;
        }
        if (result.status !== 'pending') return fail('Your PeerJS identity is not registered.');
        await deliver(result.hostSessionId, {
          type: 'room.join.pending',
          eventId: crypto.randomUUID(),
          joinRequestId,
          roomCode,
          guestPeerId: result.guestPeerId,
        }, result.hostInstanceId);
        reply(response('room.join.received', requestId, { joinRequestId, roomCode }));
        return;
      }

      case 'room.join.accept': {
        const roomCode = normalizeCode(message.roomCode);
        const joinRequestId = String(message.joinRequestId || '');
        if (!roomCode || !joinRequestId) return fail('Join request is no longer available.');
        const authorization = randomToken();
        const result = await measureStore('room.join.accept', () => store.acceptJoin({ roomCode, hostSessionId: sessionId, requestId: joinRequestId, authorization }));
        if (result.status === 'unauthorized') return fail('You are not authorized to approve this room request.');
        if (result.status !== 'accepted') return fail('Join request expired.');
        await deliver(result.guestSessionId, {
          type: 'room.join.authorized',
          eventId: crypto.randomUUID(),
          role: 'guest',
          roomCode,
          roomId: result.roomId,
          hostPeerId: result.hostPeerId,
          guestPeerId: result.guestPeerId,
          authorization,
        }, result.guestInstanceId);
        reply(response('room.join.accepted', requestId, { joinRequestId, roomCode, roomId: result.roomId, guestPeerId: result.guestPeerId, authorization }));
        return;
      }

      case 'room.join.decline': {
        const roomCode = normalizeCode(message.roomCode);
        const joinRequestId = String(message.joinRequestId || '');
        if (!roomCode || !joinRequestId) return fail('Join request is no longer available.');
        const result = await measureStore('room.join.decline', () => store.declineJoin({ roomCode, hostSessionId: sessionId, requestId: joinRequestId }));
        if (result.status === 'unauthorized') return fail('You are not authorized to decline this room request.');
        if (result.status !== 'declined') return fail('Join request expired.');
        if (result.guestSessionId && result.guestInstanceId) {
          await deliver(result.guestSessionId, { type: 'room.join.declined', eventId: crypto.randomUUID(), roomCode, reason: 'Join request declined.' }, result.guestInstanceId);
        }
        reply(response('room.join.declined', requestId, { joinRequestId, roomCode }));
        return;
      }

      case 'room.close': {
        const roomCode = normalizeCode(message.roomCode);
        if (!roomCode) return fail('Invalid room code.');
        const result = await measureStore('room.close', () => store.closeRoom({ roomCode, hostSessionId: sessionId }));
        if (result.status === 'unauthorized') return fail('You are not authorized to close this room.');
        for (const target of [result.guestSessionId, result.pendingGuestSessionId]) {
          if (target) await deliver(target, { type: 'room.closed', eventId: crypto.randomUUID(), roomCode, reason: 'The host ended the room.' });
        }
        reply(response('room.closed', requestId, { roomCode }));
        return;
      }

      case 'match.search': {
        if (!validPeerId(message.peerId) || (session.peerId && session.peerId !== message.peerId)) return fail('Register your PeerJS identity before searching.');
        const matchId = crypto.randomUUID();
        const authorization = randomToken();
        const result = await measureStore('match.search', () => store.search({ sessionId, instanceId, peerId: message.peerId, matchId, authorization, ttl: MATCH_TTL_SECONDS }));
        if (result.status === 'unregistered') return fail('Register your PeerJS identity before searching.');
        if (result.status === 'already-matched') return fail('This session already has an active match.');
        if (result.status === 'busy') return fail('End your current room before searching for a Ghost.');
        if (result.status === 'full') return fail('The search queue is full. Please try again shortly.');
        if (result.status !== 'matched') {
          reply(response('match.queued', requestId, { position: result.position || 1 }));
          return;
        }
        const role = result.role;
        const current = {
          type: 'match.found',
          requestId,
          eventId: crypto.randomUUID(),
          matchId,
          role,
          remotePeerId: result.otherPeerId,
          authorization,
        };
        await deliver(result.otherSessionId, {
          type: 'match.found',
          eventId: crypto.randomUUID(),
          matchId,
          role: result.otherRole,
          remotePeerId: result.peerId,
          authorization,
        }, result.otherInstanceId);
        reply(current);
        return;
      }

      case 'match.cancel': {
        const result = await measureStore('match.cancel', () => store.cancelSearch(sessionId));
        reply(response('match.canceled', requestId, result));
        return;
      }

      case 'match.release': {
        const matchId = String(message.matchId || '');
        if (!matchId) return fail('Invalid match.');
        const result = await measureStore('match.release', () => store.releaseMatch({ matchId, sessionId }));
        if (result.status === 'unauthorized') return fail('You are not authorized to end this match.');
        if (result.otherSessionId) {
          await deliver(result.otherSessionId, { type: 'match.ended', eventId: crypto.randomUUID(), matchId }, result.otherInstanceId);
        }
        reply(response('match.released', requestId, { matchId }));
        return;
      }

      case 'report.submit': {
        if (!reportAdminToken) return fail('Reporting is not configured for this service.');
        const matchId = String(message.matchId || '');
        const reason = String(message.reason || '');
        if (!matchId || !REPORT_REASONS.has(reason)) return fail('Select a valid report reason.');
        const report = {
          id: crypto.randomUUID(),
          matchId,
          reporterSessionId: sessionId,
          reason,
          createdAt: Date.now(),
        };
        const result = await measureStore('report.submit', () => store.submitReport({ report, sessionId, retentionSeconds: REPORT_RETENTION_SECONDS }));
        if (result.status === 'missing') return fail('This chat is no longer available to report.');
        if (result.status === 'unauthorized') return fail('You are not a participant in this chat.');
        if (result.status === 'duplicate') return fail('You have already reported this chat.');
        reply(response('report.submitted', requestId, { reportId: report.id }));
        return;
      }

      default:
        reply(response('error', requestId, { message: 'Unknown coordinator operation.' }));
    }
  }

  function attach(socket, request) {
    if (!allowedOrigin(request.headers.origin, request, configuredOrigins)) {
      socket.close(1008, 'Origin not allowed');
      return;
    }
    if (requireRedis && !redisUrl) {
      send(socket, { type: 'error', message: 'The connection service is not configured. Please try again later.' });
      socket.close(1011, 'Coordinator not configured');
      return;
    }

    const sessionId = crypto.randomUUID();
    const connectionAcceptedAt = Date.now();
    const sessionStartedAt = performance.now();
    let active = true;
    let lastPong = Date.now();
    const completed = new Map();
    const inflight = new Set();
    sockets.set(sessionId, socket);

    const start = async () => {
      await ready;
      if (!active) return;
      await store.createSession({ sessionId, instanceId });
      send(socket, {
        type: 'session.ack',
        sessionId,
        serverTiming: {
          acceptedAt: connectionAcceptedAt,
          acknowledgedAt: Date.now(),
          sessionCreateDurationMs: performance.now() - sessionStartedAt,
        },
      });
    };

    start().catch((error) => {
      console.error('[GhostChat] coordinator initialization failed', error.message);
      send(socket, { type: 'error', message: 'The connection service is unavailable. Please try again.' });
      socket.close(1011, 'Coordinator unavailable');
    });

    socket.on('pong', () => { lastPong = Date.now(); });
    const heartbeat = setInterval(() => {
      if (!active) return;
      if (Date.now() - lastPong > 65_000) {
        socket.terminate();
        return;
      }
      socket.ping();
      store.touchSession(sessionId).catch((error) => console.error('[GhostChat] session refresh failed', error.message));
    }, 25_000);

    socket.on('message', (raw) => {
      void (async () => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          send(socket, { type: 'error', message: 'Invalid JSON payload.' });
          return;
        }
        const requestId = typeof message.requestId === 'string' && message.requestId.length <= 100 ? message.requestId : '';
        if (!requestId || typeof message.type !== 'string') {
          send(socket, { type: 'error', requestId: requestId || undefined, message: 'A request ID and message type are required.' });
          return;
        }
        if (completed.has(requestId)) {
          send(socket, completed.get(requestId));
          return;
        }
        if (inflight.has(requestId)) return;
        inflight.add(requestId);
        let captured = null;
        const reply = (payload) => {
          captured = payload;
          send(socket, payload);
        };
        try {
          await handleMessage(socket, sessionId, requestId, message, reply);
          if (captured) {
            completed.set(requestId, captured);
            if (completed.size > 200) completed.delete(completed.keys().next().value);
          }
        } catch (error) {
          console.error('[GhostChat] request failed', message.type, error.message);
          const failure = response('error', requestId, { message: 'The request could not be completed. Please try again.' });
          send(socket, failure);
          completed.set(requestId, failure);
        } finally {
          inflight.delete(requestId);
        }
      })();
    });

    socket.on('close', () => {
      active = false;
      clearInterval(heartbeat);
      if (sockets.get(sessionId) === socket) sockets.delete(sessionId);
      void store.removeSession(sessionId)
        .then((notifications) => Promise.all(notifications.map(({ sessionId: targetId, instanceId: targetInstance, payload }) => deliver(targetId, payload, targetInstance))))
        .catch((error) => console.error('[GhostChat] session cleanup failed', error.message));
    });
  }

  return { attach, ready, close: () => store.close(), instanceId };
}
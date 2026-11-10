import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const preferredPort = Number(process.env.PORT || 8080);
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || 'http://localhost:8000,http://127.0.0.1:8000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
let serverPort = preferredPort;
let server;

const rooms = new Map();
const matchQueue = [];
const users = new Map();
const socketSessions = new Map();

function buildSessionId() {
  return crypto.randomUUID();
}

function isAllowedOrigin(origin) {
  if (!origin) {
    return true;
  }

  try {
    const actualOrigin = new URL(origin).origin;
    return allowedOrigins.length === 0 || allowedOrigins.includes(actualOrigin) || allowedOrigins.includes(origin);
  } catch (error) {
    return false;
  }
}

function send(socket, payload) {
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify(payload));
  }
}

function getOrCreateUser(sessionId, socket) {
  if (!users.has(sessionId)) {
    users.set(sessionId, {
      sessionId,
      socket,
      peerId: null,
      roomCode: null,
      searchQueued: false,
      mode: null,
    });
  } else {
    const user = users.get(sessionId);
    user.socket = socket;
  }

  return users.get(sessionId);
}

function removeUser(sessionId) {
  const user = users.get(sessionId);
  if (!user) return;

  if (user.roomCode && rooms.has(user.roomCode)) {
    const room = rooms.get(user.roomCode);
    if (room.hostSessionId === sessionId) {
      rooms.delete(user.roomCode);
      const guest = users.get(room.approvedGuestSessionId);
      if (guest && guest.socket) {
        send(guest.socket, { type: 'room.closed', roomCode: room.code, reason: 'Host closed the room.' });
      }
    }
  }

  const queueIndex = matchQueue.findIndex((entry) => entry.sessionId === sessionId);
  if (queueIndex >= 0) {
    matchQueue.splice(queueIndex, 1);
  }

  users.delete(sessionId);
}

function nextRoomCode() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';

  for (let i = 0; i < 4; i += 1) {
    code += alphabet[crypto.randomInt(0, alphabet.length)];
  }

  return code;
}

function allocateRoomCode() {
  let attempts = 0;
  while (attempts < 50) {
    const code = nextRoomCode();
    if (!rooms.has(code)) {
      return code;
    }
    attempts += 1;
  }

  throw new Error('Room code allocation exhausted.');
}

function pairQueue() {
  while (matchQueue.length >= 2) {
    const [first, second] = matchQueue.splice(0, 2);
    const firstUser = users.get(first.sessionId);
    const secondUser = users.get(second.sessionId);

    if (!firstUser || !secondUser || !firstUser.socket || !secondUser.socket) {
      continue;
    }

    send(firstUser.socket, {
      type: 'match.found',
      peerId: secondUser.peerId,
      sessionId: secondUser.sessionId,
      mode: 'matchmaking',
    });

    send(secondUser.socket, {
      type: 'match.found',
      peerId: firstUser.peerId,
      sessionId: firstUser.sessionId,
      mode: 'matchmaking',
    });
  }
}

export function createCoordinatorServer(port) {
  const candidate = new WebSocketServer({ port });

  candidate.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Set PORT to a free port or free the current listener.`);
      throw error;
    }
    console.error('WebSocket server error', error);
  });

  candidate.on('connection', (socket, request) => {
    const origin = request && request.headers && request.headers.origin;
    if (!isAllowedOrigin(origin)) {
      socket.close(1008, 'Origin not allowed');
      return;
    }

    const sessionId = buildSessionId();
    socketSessions.set(socket, sessionId);
    const user = getOrCreateUser(sessionId, socket);
    user.peerId = user.peerId || null;
    user.mode = user.mode || null;
    send(socket, { type: 'session.ack', sessionId });

    socket.on('message', (raw) => {
      let message;

      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        send(socket, { type: 'error', message: 'Invalid JSON payload.' });
        return;
      }

      const { type, sessionId: clientSessionId, ...payload } = message;
      const authenticatedSessionId = socketSessions.get(socket);

      if (!type) {
        send(socket, { type: 'error', message: 'Missing message type.' });
        return;
      }

      if (type === 'session.hello') {
        const knownUser = users.get(authenticatedSessionId) || getOrCreateUser(authenticatedSessionId, socket);
        knownUser.peerId = payload.peerId || knownUser.peerId;
        knownUser.mode = payload.mode || knownUser.mode;
        send(socket, { type: 'session.ack', sessionId: authenticatedSessionId });
        return;
      }

      if (!authenticatedSessionId) {
        send(socket, { type: 'error', message: 'Session not initialized.' });
        return;
      }

      if (clientSessionId && clientSessionId !== authenticatedSessionId) {
        send(socket, { type: 'error', message: 'Unauthorized session.' });
        return;
      }

      const activeUser = getOrCreateUser(authenticatedSessionId, socket);

      switch (type) {
        case 'peer.register': {
          activeUser.peerId = payload.peerId || activeUser.peerId;
          send(socket, { type: 'peer.registered', peerId: activeUser.peerId });
          break;
        }

        case 'room.create': {
          const roomCode = allocateRoomCode();
          rooms.set(roomCode, {
            code: roomCode,
            hostSessionId: authenticatedSessionId,
            hostPeerId: payload.hostPeerId,
            pendingRequests: new Map(),
            approvedGuestSessionId: null,
            createdAt: Date.now(),
          });

          activeUser.roomCode = roomCode;
          activeUser.mode = 'private-host';
          send(socket, { type: 'room.created', roomCode, hostPeerId: payload.hostPeerId });
          break;
        }

        case 'room.join.request': {
          const roomCode = String(payload.roomCode || '').toUpperCase();
          const room = rooms.get(roomCode);

          if (!room) {
            send(socket, { type: 'room.join.rejected', reason: 'Room not found.' });
            return;
          }

          const requestId = `${authenticatedSessionId}-${Date.now()}`;
          room.pendingRequests.set(requestId, {
            requestId,
            guestSessionId: authenticatedSessionId,
            guestPeerId: payload.guestPeerId,
            createdAt: Date.now(),
            roomCode,
          });

          const host = users.get(room.hostSessionId);
          if (host && host.socket) {
            send(host.socket, {
              type: 'room.join.pending',
              requestId,
              guestSessionId: authenticatedSessionId,
              guestPeerId: payload.guestPeerId,
              roomCode,
            });
          }

          send(socket, { type: 'room.join.received', requestId, roomCode });
          break;
        }

        case 'room.join.accept': {
          const room = rooms.get(String(payload.roomCode || '').toUpperCase());
          if (!room || room.hostSessionId !== authenticatedSessionId) {
            send(socket, { type: 'room.join.error', reason: 'Host not authorized for this room.' });
            return;
          }

          const request = room.pendingRequests.get(payload.requestId);
          if (!request) {
            send(socket, { type: 'room.join.error', reason: 'Request no longer active.' });
            return;
          }

          room.pendingRequests.delete(payload.requestId);
          room.approvedGuestSessionId = request.guestSessionId;

          const guest = users.get(request.guestSessionId);
          if (guest && guest.socket) {
            send(guest.socket, {
              type: 'room.join.authorized',
              roomCode: room.code,
              hostPeerId: room.hostPeerId,
              requestId: payload.requestId,
            });
          }

          send(socket, { type: 'room.join.accepted', guestSessionId: request.guestSessionId, roomCode: room.code });
          break;
        }

        case 'room.join.decline': {
          const room = rooms.get(String(payload.roomCode || '').toUpperCase());
          if (!room || room.hostSessionId !== authenticatedSessionId) {
            send(socket, { type: 'room.join.error', reason: 'Host not authorized for this room.' });
            return;
          }

          const request = room.pendingRequests.get(payload.requestId);
          if (!request) {
            send(socket, { type: 'room.join.error', reason: 'Request no longer active.' });
            return;
          }

          room.pendingRequests.delete(payload.requestId);

          const guest = users.get(request.guestSessionId);
          if (guest && guest.socket) {
            send(guest.socket, {
              type: 'room.join.declined',
              roomCode: room.code,
              reason: 'Host declined the request.',
            });
          }

          send(socket, { type: 'room.join.declined', guestSessionId: request.guestSessionId, roomCode: room.code });
          break;
        }

        case 'match.search': {
          const peerId = payload.peerId || null;
          if (!peerId) {
            send(socket, { type: 'error', message: 'Peer id required for matchmaking.' });
            return;
          }

          activeUser.peerId = peerId;
          activeUser.mode = 'matchmaking';
          activeUser.searchQueued = true;

          const existing = matchQueue.find((entry) => entry.sessionId === authenticatedSessionId);
          if (!existing) {
            matchQueue.push({ sessionId: authenticatedSessionId, peerId });
          }

          send(socket, { type: 'match.queued', position: matchQueue.length });
          pairQueue();
          break;
        }

        case 'match.cancel': {
          const queueIndex = matchQueue.findIndex((entry) => entry.sessionId === authenticatedSessionId);
          if (queueIndex >= 0) {
            matchQueue.splice(queueIndex, 1);
          }
          activeUser.searchQueued = false;
          send(socket, { type: 'match.canceled' });
          break;
        }

        case 'room.close': {
          const roomCode = String(payload.roomCode || '').toUpperCase();
          const room = rooms.get(roomCode);

          if (!room) {
            send(socket, { type: 'room.closed', roomCode });
            return;
          }

          if (room.hostSessionId === authenticatedSessionId) {
            rooms.delete(room.code);
            const guest = users.get(room.approvedGuestSessionId);
            if (guest && guest.socket) {
              send(guest.socket, { type: 'room.closed', roomCode: room.code, reason: 'Host ended the room.' });
            }
          }

          send(socket, { type: 'room.closed', roomCode: room.code });
          break;
        }

        default:
          send(socket, { type: 'error', message: `Unknown message type: ${type}` });
          break;
      }
    });

    socket.on('close', () => {
      const userId = socketSessions.get(socket);
      if (userId) {
        removeUser(userId);
        socketSessions.delete(socket);
      }
    });
  });

  server = candidate;
  console.log(`GhostChat coordination server listening on ws://localhost:${port}`);
  return candidate;
}

export function startServer(port = serverPort) {
  return createCoordinatorServer(port);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer(serverPort);
}

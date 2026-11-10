import { WebSocketServer } from 'ws';

const preferredPort = Number(process.env.PORT || 8080);
let serverPort = preferredPort;
let server;

function startServer(port) {
  const candidate = new WebSocketServer({ port });

  candidate.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      candidate.close();
      startServer(port + 1);
      return;
    }
    console.error('WebSocket server error', error);
  });

  candidate.on('connection', (socket) => {
    socket.on('message', (raw) => {
      let message;

      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        send(socket, { type: 'error', message: 'Invalid JSON payload.' });
        return;
      }

      const { type, sessionId, ...payload } = message;

      if (!type) {
        send(socket, { type: 'error', message: 'Missing message type.' });
        return;
      }

      if (type === 'session.hello') {
        const user = getOrCreateUser(sessionId || `guest-${Date.now()}`, socket);
        user.peerId = payload.peerId || user.peerId;
        user.mode = payload.mode || user.mode;
        send(socket, { type: 'session.ack', sessionId: user.sessionId });
        return;
      }

      if (!sessionId) {
        send(socket, { type: 'error', message: 'Session id required.' });
        return;
      }

      const user = getOrCreateUser(sessionId, socket);

      switch (type) {
        case 'peer.register': {
          user.peerId = payload.peerId || user.peerId;
          send(socket, { type: 'peer.registered', peerId: user.peerId });
          break;
        }

        case 'room.create': {
          const roomCode = allocateRoomCode();
          rooms.set(roomCode, {
            code: roomCode,
            hostSessionId: sessionId,
            hostPeerId: payload.hostPeerId,
            pendingRequests: new Map(),
            approvedGuestSessionId: null,
            createdAt: Date.now(),
          });

          user.roomCode = roomCode;
          user.mode = 'private-host';
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

          const requestId = `${sessionId}-${Date.now()}`;
          room.pendingRequests.set(requestId, {
            requestId,
            guestSessionId: sessionId,
            guestPeerId: payload.guestPeerId,
            createdAt: Date.now(),
            roomCode,
          });

          const host = users.get(room.hostSessionId);
          if (host && host.socket) {
            send(host.socket, {
              type: 'room.join.pending',
              requestId,
              guestSessionId: sessionId,
              guestPeerId: payload.guestPeerId,
              roomCode,
            });
          }

          send(socket, { type: 'room.join.received', requestId, roomCode });
          break;
        }

        case 'room.join.accept': {
          const room = rooms.get(String(payload.roomCode || '').toUpperCase());
          if (!room || room.hostSessionId !== sessionId) {
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
          if (!room || room.hostSessionId !== sessionId) {
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

          user.peerId = peerId;
          user.mode = 'matchmaking';
          user.searchQueued = true;

          const existing = matchQueue.find((entry) => entry.sessionId === sessionId);
          if (!existing) {
            matchQueue.push({ sessionId, peerId });
          }

          send(socket, { type: 'match.queued', position: matchQueue.length });
          pairQueue();
          break;
        }

        case 'match.cancel': {
          const queueIndex = matchQueue.findIndex((entry) => entry.sessionId === sessionId);
          if (queueIndex >= 0) {
            matchQueue.splice(queueIndex, 1);
          }
          user.searchQueued = false;
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

          if (room.hostSessionId === sessionId) {
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
      const userId = [...users.entries()].find(([, entry]) => entry.socket === socket)?.[0];
      if (userId) {
        removeUser(userId);
      }
    });
  });

  server = candidate;
  console.log(`GhostChat coordination server listening on ws://localhost:${port}`);
}

const rooms = new Map();
const matchQueue = [];
const users = new Map();

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
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function allocateRoomCode() {
  let code = nextRoomCode();
  while (rooms.has(code)) {
    code = nextRoomCode();
  }
  return code;
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

startServer(serverPort);

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createCoordinatorServer } from '../server/index.js';

function connectAndAwaitAck(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('Timed out waiting for coordinator session ack.'));
    }, 5000);

    socket.on('message', (raw) => {
      const payload = JSON.parse(raw.toString());
      if (payload?.type === 'session.ack') {
        clearTimeout(timeout);
        resolve({ socket, payload });
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function request(socket, type, fields = {}) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${type} response.`));
    }, 5000);

    function onMessage(raw) {
      const payload = JSON.parse(raw.toString());
      if (payload?.requestId !== requestId) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(payload);
    }

    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type, requestId, ...fields }));
  });
}

test('coordinator binds room authority to the accepting socket session', async () => {
  const server = createCoordinatorServer(0);
  const url = `ws://localhost:${server.address().port}`;
  const [clientAConnect, clientBConnect] = await Promise.all([connectAndAwaitAck(url), connectAndAwaitAck(url)]);
  const { socket: clientA, payload: ackA } = clientAConnect;
  const { socket: clientB, payload: ackB } = clientBConnect;
  const peerA = `ghost-a-${crypto.randomUUID()}`;
  const peerB = `ghost-b-${crypto.randomUUID()}`;

  try {
    assert.ok(ackA.sessionId);
    assert.ok(ackB.sessionId);
    assert.notEqual(ackA.sessionId, ackB.sessionId);
    await Promise.all([
      request(clientA, 'peer.register', { peerId: peerA }),
      request(clientB, 'peer.register', { peerId: peerB }),
    ]);

    const spoofedCreate = await request(clientB, 'room.create', { sessionId: ackA.sessionId, peerId: peerA });
    assert.equal(spoofedCreate.type, 'error');
    assert.equal(spoofedCreate.message, 'Unauthorized session.');

    const created = await request(clientA, 'room.create', { peerId: peerA });
    assert.equal(created.type, 'room.created');
    assert.match(created.roomCode, /^[A-Z]{4}$/);

    const spoofedClose = await request(clientB, 'room.close', { sessionId: ackA.sessionId, roomCode: created.roomCode });
    assert.equal(spoofedClose.type, 'error');
    assert.equal(spoofedClose.message, 'Unauthorized session.');

    const closed = await request(clientA, 'room.close', { roomCode: created.roomCode });
    assert.equal(closed.type, 'room.closed');
  } finally {
    clientA.close();
    clientB.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createCoordinatorServer } from '../server/index.js';

const redisUrl = process.env.REDIS_URL;

function receive(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for Redis-backed coordinator event.'));
    }, 8000);
    function onMessage(raw) {
      const payload = JSON.parse(raw.toString());
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(payload);
    }
    socket.on('message', onMessage);
  });
}

async function connect(port) {
  const socket = new WebSocket(`ws://localhost:${port}`);
  const ack = await receive(socket, (payload) => payload.type === 'session.ack');
  return { socket, sessionId: ack.sessionId };
}

function request(socket, type, fields = {}) {
  const requestId = crypto.randomUUID();
  const result = receive(socket, (payload) => payload.requestId === requestId);
  socket.send(JSON.stringify({ type, requestId, ...fields }));
  return result;
}

test('Redis Pub/Sub routes matchmaking across independent coordinator instances', { skip: !redisUrl && 'REDIS_URL is not configured in this environment.' }, async () => {
  const options = { redisUrl, requireRedis: true };
  const firstServer = createCoordinatorServer(0, options);
  const secondServer = createCoordinatorServer(0, options);
  await Promise.all([
    new Promise((resolve) => firstServer.once('listening', resolve)),
    new Promise((resolve) => secondServer.once('listening', resolve)),
  ]);
  let first;
  let second;

  try {
    [first, second] = await Promise.all([connect(firstServer.address().port), connect(secondServer.address().port)]);
    const firstPeerId = `redis-a-${crypto.randomUUID()}`;
    const secondPeerId = `redis-b-${crypto.randomUUID()}`;
    await Promise.all([
      request(first.socket, 'peer.register', { peerId: firstPeerId }),
      request(second.socket, 'peer.register', { peerId: secondPeerId }),
    ]);
    assert.equal((await request(first.socket, 'match.search', { peerId: firstPeerId })).type, 'match.queued');
    const routed = receive(first.socket, (payload) => payload.type === 'match.found');
    const assigned = await request(second.socket, 'match.search', { peerId: secondPeerId });
    const delivered = await routed;
    assert.equal(assigned.type, 'match.found');
    assert.equal(assigned.matchId, delivered.matchId);
    assert.equal(assigned.remotePeerId, firstPeerId);
    assert.equal(delivered.remotePeerId, secondPeerId);
    assert.notEqual(assigned.role, delivered.role);
  } finally {
    first?.socket.close();
    second?.socket.close();
    await Promise.all([
      new Promise((resolve) => firstServer.close(resolve)),
      new Promise((resolve) => secondServer.close(resolve)),
    ]);
  }
});
import assert from 'node:assert/strict';
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
      try {
        const payload = JSON.parse(raw.toString());
        if (payload && payload.type === 'session.ack') {
          clearTimeout(timeout);
          resolve({ socket, payload });
        }
      } catch (error) {
        // ignore malformed packets until the ack arrives
      }
    });

    socket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test('coordinator rejects client session impersonation', async () => {
  const server = createCoordinatorServer(0);
  const port = server.address().port;

  const clientAConnect = connectAndAwaitAck(`ws://localhost:${port}`);
  const clientBConnect = connectAndAwaitAck(`ws://localhost:${port}`);

  try {
    const { socket: clientA, payload: ackA } = await clientAConnect;
    const { socket: clientB, payload: ackB } = await clientBConnect;

    assert.ok(ackA.sessionId);
    assert.ok(ackB.sessionId);

    const unauthorized = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for unauthorized session rejection.')), 5000);
      clientB.on('message', (raw) => {
        try {
          const payload = JSON.parse(raw.toString());
          if (payload && payload.type === 'error' && payload.message === 'Unauthorized session.') {
            clearTimeout(timeout);
            resolve(payload);
          }
        } catch (error) {
          // ignore malformed packets
        }
      });
      clientB.on('error', reject);
    });

    clientB.send(JSON.stringify({ type: 'room.create', sessionId: ackA.sessionId, hostPeerId: 'spoofed-peer' }));

    const errorPayload = await unauthorized;
    assert.equal(errorPayload.message, 'Unauthorized session.');

    const validRoom = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for room creation success.')), 5000);
      clientB.on('message', (raw) => {
        try {
          const payload = JSON.parse(raw.toString());
          if (payload && payload.type === 'room.created') {
            clearTimeout(timeout);
            resolve(payload);
          }
        } catch (error) {
          // ignore malformed packets
        }
      });
      clientB.on('error', reject);
    });

    clientB.send(JSON.stringify({ type: 'room.create', hostPeerId: 'real-peer' }));

    const created = await validRoom;
    assert.ok(created.roomCode);
    assert.equal(created.hostPeerId, 'real-peer');
  } finally {
    clientAConnect.then(({ socket }) => socket.close());
    clientBConnect.then(({ socket }) => socket.close());
    server.close();
  }
});

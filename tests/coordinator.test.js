import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createCoordinatorServer, createMemoryState, createMemoryStore } from '../server/index.js';

const timeoutMs = 5000;

function receive(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for coordinator event.'));
    }, timeoutMs);
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

async function connect(url) {
  const socket = new WebSocket(url);
  const ack = await receive(socket, (payload) => payload.type === 'session.ack');
  return { socket, sessionId: ack.sessionId };
}

function request(socket, type, fields = {}, requestId = crypto.randomUUID()) {
  const response = receive(socket, (payload) => payload.requestId === requestId);
  socket.send(JSON.stringify({ type, requestId, ...fields }));
  return response;
}

async function register(socket, peerId) {
  const result = await request(socket, 'peer.register', { peerId });
  assert.equal(result.type, 'peer.registered');
}

async function startPair() {
  const state = createMemoryState();
  const options = { store: createMemoryStore(state) };
  const first = createCoordinatorServer(0, options);
  const second = createCoordinatorServer(0, options);
  await Promise.all([
    new Promise((resolve) => first.once('listening', resolve)),
    new Promise((resolve) => second.once('listening', resolve)),
  ]);
  return {
    first,
    second,
    async close() {
      await Promise.all([
        new Promise((resolve) => first.close(resolve)),
        new Promise((resolve) => second.close(resolve)),
      ]);
    },
  };
}

test('private room approval routes across coordinator instances and preserves registered peers', async () => {
  const servers = await startPair();
  const host = await connect(`ws://localhost:${servers.first.address().port}`);
  const guest = await connect(`ws://localhost:${servers.second.address().port}`);
  const hostPeerId = `ghost-host-${crypto.randomUUID()}`;
  const guestPeerId = `ghost-guest-${crypto.randomUUID()}`;

  try {
    await register(host.socket, hostPeerId);
    await register(guest.socket, guestPeerId);
    const createRequestId = crypto.randomUUID();
    const create = await request(host.socket, 'room.create', { peerId: hostPeerId }, createRequestId);
    const duplicate = await request(host.socket, 'room.create', { peerId: hostPeerId }, createRequestId);
    assert.deepEqual(duplicate, create);
    assert.match(create.roomCode, /^[A-Z]{4}$/);

    const pending = receive(host.socket, (payload) => payload.type === 'room.join.pending');
    const join = await request(guest.socket, 'room.join.request', { roomCode: create.roomCode, peerId: guestPeerId });
    assert.equal(join.type, 'room.join.received');
    const approval = await pending;
    assert.equal(approval.guestPeerId, guestPeerId);

    const authorized = receive(guest.socket, (payload) => payload.type === 'room.join.authorized');
    const accepted = await request(host.socket, 'room.join.accept', { roomCode: create.roomCode, joinRequestId: approval.joinRequestId });
    const guestAuthorization = await authorized;
    assert.equal(accepted.type, 'room.join.accepted');
    assert.equal(accepted.guestPeerId, guestPeerId);
    assert.equal(guestAuthorization.hostPeerId, hostPeerId);
    assert.equal(guestAuthorization.authorization, accepted.authorization);
    assert.equal(guestAuthorization.roomId, accepted.roomId);
  } finally {
    host.socket.close();
    guest.socket.close();
    await servers.close();
  }
});

test('matchmaking reserves each peer once and assigns exactly one initiator across instances', async () => {
  const servers = await startPair();
  const first = await connect(`ws://localhost:${servers.first.address().port}`);
  const second = await connect(`ws://localhost:${servers.second.address().port}`);
  const firstPeerId = `ghost-first-${crypto.randomUUID()}`;
  const secondPeerId = `ghost-second-${crypto.randomUUID()}`;

  try {
    await register(first.socket, firstPeerId);
    await register(second.socket, secondPeerId);
    const firstSearch = await request(first.socket, 'match.search', { peerId: firstPeerId });
    assert.equal(firstSearch.type, 'match.queued');
    const firstMatch = receive(first.socket, (payload) => payload.type === 'match.found');
    const secondMatch = await request(second.socket, 'match.search', { peerId: secondPeerId });
    const deliveredMatch = await firstMatch;

    assert.equal(secondMatch.type, 'match.found');
    assert.equal(secondMatch.matchId, deliveredMatch.matchId);
    assert.equal(secondMatch.authorization, deliveredMatch.authorization);
    assert.deepEqual(new Set([secondMatch.role, deliveredMatch.role]), new Set(['initiator', 'receiver']));
    assert.equal(secondMatch.remotePeerId, firstPeerId);
    assert.equal(deliveredMatch.remotePeerId, secondPeerId);

    const ended = receive(first.socket, (payload) => payload.type === 'match.ended');
    const released = await request(second.socket, 'match.release', { matchId: secondMatch.matchId });
    assert.equal(released.type, 'match.released');
    assert.equal((await ended).matchId, secondMatch.matchId);
  } finally {
    first.socket.close();
    second.socket.close();
    await servers.close();
  }
});

test('cancel removes a searcher before a later participant can match', async () => {
  const servers = await startPair();
  const canceled = await connect(`ws://localhost:${servers.first.address().port}`);
  const waiting = await connect(`ws://localhost:${servers.second.address().port}`);
  const arriving = await connect(`ws://localhost:${servers.first.address().port}`);
  const peerIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].map((id) => `ghost-${id}`);

  try {
    await Promise.all([register(canceled.socket, peerIds[0]), register(waiting.socket, peerIds[1]), register(arriving.socket, peerIds[2])]);
    assert.equal((await request(canceled.socket, 'match.search', { peerId: peerIds[0] })).type, 'match.queued');
    assert.equal((await request(canceled.socket, 'match.cancel')).type, 'match.canceled');
    assert.equal((await request(waiting.socket, 'match.search', { peerId: peerIds[1] })).type, 'match.queued');

    const waitingMatch = receive(waiting.socket, (payload) => payload.type === 'match.found');
    const arrivingMatch = await request(arriving.socket, 'match.search', { peerId: peerIds[2] });
    assert.equal(arrivingMatch.type, 'match.found');
    assert.equal(arrivingMatch.remotePeerId, peerIds[1]);
    assert.equal((await waitingMatch).remotePeerId, peerIds[2]);
  } finally {
    canceled.socket.close();
    waiting.socket.close();
    arriving.socket.close();
    await servers.close();
  }
});

test('secure invitation authorizes entry without exposing room ownership to a forged token', async () => {
  const servers = await startPair();
  const host = await connect(`ws://localhost:${servers.first.address().port}`);
  const guest = await connect(`ws://localhost:${servers.second.address().port}`);
  const third = await connect(`ws://localhost:${servers.second.address().port}`);
  const hostPeerId = `ghost-invite-host-${crypto.randomUUID()}`;
  const guestPeerId = `ghost-invite-guest-${crypto.randomUUID()}`;
  const thirdPeerId = `ghost-invite-third-${crypto.randomUUID()}`;

  try {
    await register(host.socket, hostPeerId);
    await register(guest.socket, guestPeerId);
    await register(third.socket, thirdPeerId);
    const room = await request(host.socket, 'room.create', { peerId: hostPeerId });
    assert.match(room.invitationToken, /^[A-Za-z0-9_-]{32}$/);

    const invalid = await request(guest.socket, 'room.join.request', {
      roomCode: room.roomCode,
      peerId: guestPeerId,
      invitationToken: 'x'.repeat(32),
    });
    assert.equal(invalid.type, 'error');
    assert.equal(invalid.message, 'This invitation link is invalid or expired.');

    const hostAuthorization = receive(host.socket, (payload) => payload.type === 'room.join.authorized' && payload.role === 'host');
    const joined = await request(guest.socket, 'room.join.request', {
      roomCode: room.roomCode,
      peerId: guestPeerId,
      invitationToken: room.invitationToken,
    });
    const hostEvent = await hostAuthorization;
    assert.equal(joined.type, 'room.join.authorized');
    assert.equal(joined.role, 'guest');
    assert.equal(hostEvent.guestPeerId, guestPeerId);
    assert.equal(hostEvent.authorization, joined.authorization);
    assert.notEqual(joined.authorization, room.invitationToken);

    const full = await request(third.socket, 'room.join.request', { roomCode: room.roomCode, peerId: thirdPeerId });
    assert.equal(full.type, 'error');
    assert.equal(full.message, 'Room is full.');
  } finally {
    host.socket.close();
    guest.socket.close();
    third.socket.close();
    await servers.close();
  }
});

test('reports are match-bound, deduplicated, and store no transcript', async () => {
  const state = createMemoryState();
  const options = { store: createMemoryStore(state), reportAdminToken: 'test-moderator-token' };
  const firstServer = createCoordinatorServer(0, options);
  const secondServer = createCoordinatorServer(0, options);
  await Promise.all([
    new Promise((resolve) => firstServer.once('listening', resolve)),
    new Promise((resolve) => secondServer.once('listening', resolve)),
  ]);
  const reporter = await connect(`ws://localhost:${firstServer.address().port}`);
  const partner = await connect(`ws://localhost:${secondServer.address().port}`);
  const outsider = await connect(`ws://localhost:${secondServer.address().port}`);
  const peerIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].map((id) => `ghost-report-${id}`);

  try {
    await Promise.all([
      register(reporter.socket, peerIds[0]),
      register(partner.socket, peerIds[1]),
      register(outsider.socket, peerIds[2]),
    ]);
    await request(reporter.socket, 'match.search', { peerId: peerIds[0] });
    const reporterMatch = receive(reporter.socket, (payload) => payload.type === 'match.found');
    const partnerMatch = await request(partner.socket, 'match.search', { peerId: peerIds[1] });
    const match = await reporterMatch;

    const unauthorized = await request(outsider.socket, 'report.submit', { matchId: match.matchId, reason: 'spam' });
    assert.equal(unauthorized.type, 'error');
    assert.equal(unauthorized.message, 'You are not a participant in this chat.');

    const submitted = await request(reporter.socket, 'report.submit', { matchId: partnerMatch.matchId, reason: 'harassment' });
    assert.equal(submitted.type, 'report.submitted');
    const duplicate = await request(reporter.socket, 'report.submit', { matchId: match.matchId, reason: 'spam' });
    assert.equal(duplicate.type, 'error');
    assert.equal(duplicate.message, 'You have already reported this chat.');

    const stored = [...state.reports.values()][0];
    assert.equal(stored.reportedSessionId, partner.sessionId);
    assert.equal(stored.reason, 'harassment');
    assert.equal('messages' in stored, false);
    assert.equal('transcript' in stored, false);
  } finally {
    reporter.socket.close();
    partner.socket.close();
    outsider.socket.close();
    await Promise.all([
      new Promise((resolve) => firstServer.close(resolve)),
      new Promise((resolve) => secondServer.close(resolve)),
    ]);
  }
});

test('room approval, queue cancellation, and match release cannot affect another session', async () => {
  const servers = await startPair();
  const owner = await connect(`ws://localhost:${servers.first.address().port}`);
  const outsider = await connect(`ws://localhost:${servers.second.address().port}`);
  const guest = await connect(`ws://localhost:${servers.second.address().port}`);
  const matcher = await connect(`ws://localhost:${servers.first.address().port}`);
  const peerIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].map((id) => `ghost-auth-${id}`);

  try {
    await Promise.all([
      register(owner.socket, peerIds[0]),
      register(outsider.socket, peerIds[1]),
      register(guest.socket, peerIds[2]),
      register(matcher.socket, peerIds[3]),
    ]);
    const room = await request(owner.socket, 'room.create', { peerId: peerIds[0] });
    const joinPending = receive(owner.socket, (payload) => payload.type === 'room.join.pending');
    await request(guest.socket, 'room.join.request', { roomCode: room.roomCode, peerId: peerIds[2] });
    const pending = await joinPending;
    const unauthorizedApproval = await request(outsider.socket, 'room.join.accept', {
      roomCode: room.roomCode,
      joinRequestId: pending.joinRequestId,
    });
    assert.equal(unauthorizedApproval.type, 'error');
    assert.equal(unauthorizedApproval.message, 'You are not authorized to approve this room request.');
    await request(owner.socket, 'room.close', { roomCode: room.roomCode });

    assert.equal((await request(owner.socket, 'match.search', { peerId: peerIds[0] })).type, 'match.queued');
    assert.equal((await request(outsider.socket, 'match.cancel')).type, 'match.canceled');
    const ownerMatch = receive(owner.socket, (payload) => payload.type === 'match.found');
    const match = await request(matcher.socket, 'match.search', { peerId: peerIds[3] });
    const ownerAssignment = await ownerMatch;
    const unauthorizedRelease = await request(outsider.socket, 'match.release', { matchId: match.matchId });
    assert.equal(unauthorizedRelease.type, 'error');
    assert.equal(unauthorizedRelease.message, 'You are not authorized to end this match.');

    const released = await request(owner.socket, 'match.release', { matchId: ownerAssignment.matchId });
    assert.equal(released.type, 'match.released');
  } finally {
    owner.socket.close();
    outsider.socket.close();
    guest.socket.close();
    matcher.socket.close();
    await servers.close();
  }
});
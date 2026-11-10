import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_ALPHABET, ROOM_LENGTH, buildInvitationUrl, createRoomCode, formatRoomCode, normalizeRoomInput, parseInvitationCode, validateRoomCode } from '../js/room-utils.js';

test('room codes are generated with the right size and alphabet', () => {
  const code = createRoomCode();
  assert.equal(code.length, ROOM_LENGTH);
  for (const ch of code) {
    assert.ok(ROOM_ALPHABET.includes(ch));
  }
});

test('normalization strips non-letters and uppercases inputs', () => {
  assert.equal(normalizeRoomInput(' abcd-1234 '), 'ABCD');
  assert.equal(normalizeRoomInput('abCd-efGh'), 'ABCDEFGH');
});

test('validation rejects invalid or wrong-length codes', () => {
  assert.equal(validateRoomCode('ABCD'), null);
  assert.equal(validateRoomCode('AB'), 'Room code must be 4 letters.');
  assert.equal(validateRoomCode('AB1D'), 'Room code must be 4 letters.');
  assert.equal(validateRoomCode(''), 'Enter a valid room code.');
});

test('formatting preserves four-letter codes without spacing', () => {
  assert.equal(formatRoomCode('ABCD'), 'ABCD');
  assert.equal(formatRoomCode('abCd'), 'ABCD');
  assert.equal(formatRoomCode('ABCD1234'), 'ABCD');
});

test('invitation parsing supports hash and query entries', () => {
  assert.equal(parseInvitationCode('#join=ABCD'), 'ABCD');
  assert.equal(parseInvitationCode('?room=abcd'), 'ABCD');
  assert.equal(parseInvitationCode(''), null);
});

test('invitation links round-trip cleanly', () => {
  const url = buildInvitationUrl('ABCD', 'https://ghostchat.example/');
  assert.ok(url.startsWith('https://ghostchat.example/#join='));
  assert.match(url, /#join=/);
});

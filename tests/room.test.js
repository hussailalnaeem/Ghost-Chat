import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_ALPHABET, ROOM_LENGTH, buildInvitationUrl, createRoomCode, formatRoomCode, normalizeRoomInput, parseInvitationCode, validateRoomCode } from '../js/room-utils.js';
import { parseInvitation } from '../js/room-utils.js';

test('room codes are generated with the right size and alphabet', () => {
  const code = createRoomCode();
  assert.equal(code.length, ROOM_LENGTH);
  for (const ch of code) {
    assert.ok(ROOM_ALPHABET.includes(ch));
  }
});

test('normalization strips non-letters and uppercases inputs', () => {
  assert.equal(normalizeRoomInput(' abcd '), 'ABCD');
  assert.equal(normalizeRoomInput('abCd-efGh'), 'ABCD-EFGH');
});

test('validation rejects invalid or wrong-length codes', () => {
  assert.equal(validateRoomCode('ABCD'), null);
  assert.equal(validateRoomCode('AB'), 'Room code must be 4 letters.');
  assert.equal(validateRoomCode('AB1D'), 'Only uppercase letters A-Z are valid.');
  assert.equal(validateRoomCode('A@CD'), 'Only uppercase letters A-Z are valid.');
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

test('secure invitation links preserve code and token independently', () => {
  const url = buildInvitationUrl('ABCD', 'https://ghostchat.example/', 'secret-token');
  assert.equal(parseInvitation(url.slice(url.indexOf('#')))?.code, 'ABCD');
  assert.equal(parseInvitation(url.slice(url.indexOf('#')))?.token, 'secret-token');
});

test('invitation parsing does not truncate invalid room codes before validation', () => {
  const parsed = parseInvitation('#join=ABCDE&t=secret-token');
  assert.equal(parsed?.code, 'ABCDE');
  assert.notEqual(validateRoomCode(parsed?.code), null);
});

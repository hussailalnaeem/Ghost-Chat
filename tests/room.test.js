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

test('normalization strips spaces and dashes and uppercases inputs', () => {
  assert.equal(normalizeRoomInput(' abcd-efgh-jklm '), 'ABCD-EFGH-JKLM'.replace(/-/g, ''));
  assert.equal(normalizeRoomInput('abCd-efGh'), 'ABCD-EFGH'.replace(/-/g, ''));
});

test('validation rejects invalid or wrong-length codes', () => {
  assert.equal(validateRoomCode('ABCD-EFGH-JKLM'), null);
  assert.equal(validateRoomCode('ABCD'), 'Room code must be 12 characters.');
  assert.equal(validateRoomCode('ABCD-!!!!-JKLM'), 'Only letters and numbers from the allowed room set are valid.');
  assert.equal(validateRoomCode(''), 'Enter a valid room code.');
});

test('grouped formatting preserves 12-character codes', () => {
  assert.equal(formatRoomCode('ABCD1234EFGH'), 'ABCD-1234-EFGH');
  assert.equal(formatRoomCode('ABCD-EFGH-JKLM'), 'ABCD-EFGH-JKLM');
});

test('invitation parsing supports hash and query entries', () => {
  assert.equal(parseInvitationCode('#join=ABCD-EFGH-JKLM'), 'ABCD-EFGH-JKLM');
  assert.equal(parseInvitationCode('?room=abcd-efgh-jklm'), 'ABCD-EFGH-JKLM');
  assert.equal(parseInvitationCode(''), null);
});

test('invitation links round-trip cleanly', () => {
  const url = buildInvitationUrl('ABCD-EFGH-JKLM', 'https://ghostchat.example/');
  assert.ok(url.startsWith('https://ghostchat.example/#join='));
  assert.match(url, /#join=/);
});

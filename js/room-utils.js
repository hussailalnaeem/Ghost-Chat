export const ROOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const ROOM_LENGTH = 4;
export const ROOM_RE = /^[A-Z]{4}$/;

export function normalizeRoomInput(value) {
  return String(value ?? '').trim().toUpperCase();
}

export function formatRoomCode(value) {
  return normalizeRoomInput(value).slice(0, ROOM_LENGTH);
}

export function validateRoomCode(value) {
  const normalized = normalizeRoomInput(value);
  if (!normalized) {
    return 'Enter a valid room code.';
  }
  if (normalized.length !== ROOM_LENGTH) {
    return 'Room code must be 4 letters.';
  }
  if (!ROOM_RE.test(normalized)) {
    return 'Only uppercase letters A-Z are valid.';
  }
  return null;
}

export function createRoomCode() {
  let code = '';
  const limit = Math.floor(256 / ROOM_ALPHABET.length) * ROOM_ALPHABET.length;

  while (code.length < ROOM_LENGTH) {
    const bytes = new Uint8Array(ROOM_LENGTH - code.length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < limit) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
      if (code.length === ROOM_LENGTH) break;
    }
  }

  return code;
}

export function buildInvitationUrl(code, baseUrl = globalThis.location?.origin ? `${globalThis.location.origin}${globalThis.location.pathname}` : 'https://ghostchat.invalid/', invitationToken = '') {
  const value = formatRoomCode(code);
  const token = invitationToken ? `&t=${encodeURIComponent(invitationToken)}` : '';
  return `${baseUrl}#join=${encodeURIComponent(value)}${token}`;
}

export function parseInvitation(hashOrSearch = globalThis.location?.hash || '') {
  const raw = String(hashOrSearch || '');
  const fragment = raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : raw.replace(/^\?/, '');
  const params = new URLSearchParams(fragment);
  const candidate = params.get('join') || params.get('room');
  if (!candidate) return null;
  return { code: normalizeRoomInput(candidate), token: params.get('t') || '' };
}

export function parseInvitationCode(hashOrSearch = globalThis.location?.hash || '') {
  return parseInvitation(hashOrSearch)?.code || null;
}

export function buildPeerId(roomCode) {
  return `gc-v2-${normalizeRoomInput(roomCode)}-${crypto.randomUUID()}`;
}

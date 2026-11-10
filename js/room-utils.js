export const ROOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const ROOM_LENGTH = 4;
export const ROOM_RE = /^[A-Z]{4}$/;

export function normalizeRoomInput(value) {
  return String(value ?? '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
}

export function formatRoomCode(value) {
  const normalized = normalizeRoomInput(value);
  return normalized.slice(0, ROOM_LENGTH).toUpperCase();
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
  const bytes = new Uint8Array(ROOM_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';

  for (const byte of bytes) {
    const index = byte % ROOM_ALPHABET.length;
    code += ROOM_ALPHABET[index];
  }

  return code;
}

export function buildInvitationUrl(code, baseUrl = globalThis.location?.origin ? `${globalThis.location.origin}${globalThis.location.pathname}` : 'http://localhost') {
  const value = formatRoomCode(code);
  return `${baseUrl}#join=${encodeURIComponent(value)}`;
}

export function parseInvitationCode(hashOrSearch = globalThis.location?.hash || '') {
  const raw = String(hashOrSearch || '');
  const match = raw.match(/[#?][^#?]*?(?:join|room)=(.*)/i) || raw.match(/(?:join|room)=(.*)/i);
  if (!match) return null;
  const candidate = decodeURIComponent(match[1].split('&')[0]);
  return formatRoomCode(candidate);
}

export function buildPeerId(roomCode) {
  return `gc-v2-${normalizeRoomInput(roomCode)}-${crypto.randomUUID()}`;
}

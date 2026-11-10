export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_LENGTH = 12;
export const ROOM_RE = /^[A-HJ-NP-Z2-9]{12}$/i;

export function normalizeRoomInput(value) {
  return String(value ?? '')
    .replace(/[\s-]+/g, '')
    .toUpperCase();
}

export function formatRoomCode(value) {
  const normalized = normalizeRoomInput(value);
  if (!normalized) return '';
  return normalized.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

export function validateRoomCode(value) {
  const normalized = normalizeRoomInput(value);
  if (!normalized) {
    return 'Enter a valid room code.';
  }
  if (normalized.length !== ROOM_LENGTH) {
    return 'Room code must be 12 characters.';
  }
  if (!ROOM_RE.test(normalized)) {
    return 'Only letters and numbers from the allowed room set are valid.';
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
  const normalized = normalizeRoomInput(candidate);
  return formatRoomCode(normalized);
}

export function buildPeerId(roomCode) {
  return `gc-v1-${normalizeRoomInput(roomCode)}`;
}

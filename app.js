import {
  ROOM_LENGTH,
  buildInvitationUrl,
  buildPeerId,
  createRoomCode,
  formatRoomCode,
  normalizeRoomInput,
  parseInvitationCode,
  validateRoomCode,
} from './js/room-utils.js';

const PEER_OPTS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  },
};

const MAX_MSG_LEN = 2000;
const SEND_THROTTLE_MS = 150;
const CONNECT_TIMEOUT_MS = 15000;
const ALLOWED_TYPES = new Set(['hello', 'welcome', 'message', 'end', 'reject']);

const state = {
  screen: 'HOME',
  peer: null,
  conn: null,
  roomCode: '',
  sessionId: crypto.randomUUID(),
  isHost: false,
  lastSendAt: 0,
  connectTimer: null,
  messages: [],
  pendingAction: 'home',
};

const refs = {};

function $id(id) {
  return document.getElementById(id);
}

function setScreen(screen) {
  state.screen = screen;
  render();
}

function resetSessionState() {
  state.isHost = false;
  state.roomCode = '';
  state.messages = [];
  if (state.conn && state.conn.close) {
    try {
      state.conn.close();
    } catch (error) {
      console.warn('[GhostChat] Session close warning:', error);
    }
  }
  state.conn = null;
  if (state.peer) {
    try {
      state.peer.destroy();
    } catch (error) {
      console.warn('[GhostChat] Peer destroy warning:', error);
    }
  }
  state.peer = null;
  clearTimeout(state.connectTimer);
  state.connectTimer = null;
  state.sessionId = crypto.randomUUID();
}

function showToast(text, tone = 'info') {
  const toast = refs.toast;
  if (!toast) return;

  toast.textContent = text;
  toast.dataset.tone = tone;
  toast.classList.remove('show');
  void toast.offsetWidth;
  toast.classList.add('show');

  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 1800);
}

function render() {
  const screens = document.querySelectorAll('[data-state]');
  screens.forEach((screen) => {
    screen.hidden = screen.dataset.state !== state.screen;
  });

  const statusDot = refs.statusDot;
  if (statusDot) {
    statusDot.classList.remove('connected', 'waiting', 'error');
    if (state.screen === 'CONNECTED') {
      statusDot.classList.add('connected');
    } else if (['WAITING', 'JOINING', 'HANDSHAKING', 'CREATING'].includes(state.screen)) {
      statusDot.classList.add('waiting');
    } else if (['ERROR', 'CONNECTION_LOST'].includes(state.screen)) {
      statusDot.classList.add('error');
    }
  }

  const sendButton = refs.sendBtn;
  if (sendButton) {
    const value = refs.msgInput.value || '';
    const trimmed = value.trim();
    const throttleActive = Date.now() - state.lastSendAt < SEND_THROTTLE_MS;
    sendButton.disabled = state.screen !== 'CONNECTED' || !trimmed || trimmed.length > MAX_MSG_LEN || throttleActive;
  }

  if (refs.roomCodeValue) {
    refs.roomCodeValue.textContent = formatRoomCode(state.roomCode || '');
  }
}

function setError(message) {
  refs.errorMessage.textContent = message;
  setScreen('ERROR');
}

function beginCreateFlow() {
  resetSessionState();
  state.pendingAction = 'create';
  state.isHost = true;
  state.roomCode = createRoomCode();
  setScreen('CREATING');
  state.peer = new Peer(buildPeerId(state.roomCode), PEER_OPTS);
  bindHostPeer();
}

function bindHostPeer() {
  if (!state.peer) return;

  state.peer.on('open', () => {
    state.isHost = true;
    refs.roomCodeValue.textContent = formatRoomCode(state.roomCode);
    setScreen('WAITING');
    showToast('Room ready');
  });

  state.peer.on('error', (err) => {
    if (err && err.type === 'unavailable-id') {
      state.roomCode = createRoomCode();
      if (state.peer) {
        try {
          state.peer.destroy();
        } catch (error) {
          console.warn('[GhostChat] retry destroy warning', error);
        }
      }
      state.peer = new Peer(buildPeerId(state.roomCode), PEER_OPTS);
      bindHostPeer();
      return;
    }
    handlePeerError(err);
  });

  state.peer.on('connection', (incoming) => {
    if (state.conn && state.conn.open) {
      incoming.on('open', () => {
        try {
          incoming.send({ type: 'reject', reason: 'room-full', v: 1 });
        } catch (error) {
          console.warn('[GhostChat] reject not sent', error);
        }
        incoming.close();
      });
      return;
    }

    state.conn = incoming;
    incoming.on('open', () => {
      state.sessionId = crypto.randomUUID();
      setScreen('HANDSHAKING');
      showToast('Guest connected');
    });
    incoming.on('close', () => {
      if (state.screen !== 'HOME' && state.screen !== 'ERROR') {
        setScreen('CONNECTION_LOST');
      }
    });
    incoming.on('data', handleIncomingData);
  });

  state.peer.on('disconnected', () => {
    if (!state.isHost || state.screen === 'HOME') return;
    try {
      state.peer.reconnect();
    } catch (error) {
      console.warn('[GhostChat] reconnect warning', error);
    }
  });
}

function handlePeerError(err) {
  console.warn('[GhostChat peer error]', err);

  const type = err && err.type;
  let message = 'Something went wrong: ' + ((err && (err.message || err.type)) || 'unknown error');

  if (type === 'peer-unavailable') {
    message = 'Room not found. Check the code or ask the other person to create a new room.';
  } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(type)) {
    message = 'Cannot reach the connection service. Check your internet and try again.';
  } else if (type === 'webrtc') {
    message = 'Could not establish a direct connection. Some networks block peer-to-peer chat.';
  } else if (type === 'browser-incompatible') {
    message = 'Your browser does not support WebRTC. Try Chrome, Firefox, or Safari.';
  } else if (type === 'unavailable-id') {
    message = 'This room is already in use. Creating a new one…';
  }

  setError(message);
}

function submitJoin(rawValue) {
  const code = normalizeRoomInput(rawValue ?? refs.joinCodeInput.value);
  const error = validateRoomCode(code);
  if (error) {
    refs.joinError.textContent = error;
    return;
  }

  refs.joinError.textContent = '';
  state.roomCode = code;
  startGuestConnection(code);
}

function startGuestConnection(code) {
  resetSessionState();
  state.pendingAction = 'join';
  state.isHost = false;
  state.roomCode = code;
  setScreen('JOINING');

  const guestId = `gc-guest-${crypto.randomUUID()}`;
  state.peer = new Peer(guestId, PEER_OPTS);

  state.peer.on('open', () => {
    const hostId = buildPeerId(code);
    state.conn = state.peer.connect(hostId, { reliable: true, metadata: { v: 1 } });

    state.conn.on('data', handleIncomingData);
    state.conn.on('open', () => {
      setScreen('HANDSHAKING');
      state.conn.send({ type: 'hello', v: 1, roomCode: code });
      state.connectTimer = setTimeout(() => {
        if (state.screen === 'HANDSHAKING') {
          setError('Connection timed out. The room may be unavailable or the host left.');
        }
      }, CONNECT_TIMEOUT_MS);
    });

    state.conn.on('error', (err) => {
      handlePeerError(err);
    });

    state.conn.on('close', () => {
      if (state.screen !== 'HOME' && state.screen !== 'ERROR' && state.screen !== 'ENDED') {
        setScreen('CONNECTION_LOST');
      }
    });
  });

  state.peer.on('error', (err) => {
    handlePeerError(err);
  });
}

function handleIncomingData(raw) {
  let payload;
  try {
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    return;
  }

  if (!payload || typeof payload !== 'object') return;
  if (!ALLOWED_TYPES.has(payload.type)) return;

  if (payload.type === 'hello') {
    if (state.isHost && state.conn) {
      state.conn.send({ type: 'welcome', v: 1, roomCode: state.roomCode });
      setScreen('CONNECTED');
      refs.statusLabel.textContent = 'Connected';
      refs.msgInput.value = '';
      refs.msgInput.focus();
    }
    return;
  }

  if (payload.type === 'welcome') {
    if (!state.isHost) {
      clearTimeout(state.connectTimer);
      state.connectTimer = null;
      setScreen('CONNECTED');
      refs.statusLabel.textContent = 'Connected';
      refs.msgInput.focus();
      showToast('Connected');
    }
    return;
  }

  if (payload.type === 'reject') {
    const reason = payload.reason || 'room-full';
    const message = reason === 'room-full' ? 'Room is full.' : 'This room is unavailable.';
    setError(message);
    return;
  }

  if (payload.type === 'end') {
    setScreen('CONNECTION_LOST');
    return;
  }

  if (payload.type === 'message') {
    if (typeof payload.text !== 'string') return;
    const text = payload.text.trim();
    if (!text || text.length > MAX_MSG_LEN) return;
    const ts = typeof payload.ts === 'number' && Number.isFinite(payload.ts) ? payload.ts : Date.now();
    appendMessage({ text, ts, self: false });
  }
}

function appendMessage({ text, ts, self }) {
  const el = document.createElement('div');
  el.className = 'msg ' + (self ? 'self' : 'peer');

  const body = document.createElement('div');
  body.textContent = text;

  const time = document.createElement('time');
  time.dateTime = new Date(ts).toISOString();
  time.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  el.appendChild(body);
  el.appendChild(time);
  refs.chatMessages.appendChild(el);
  refs.chatMessages.scrollTop = refs.chatMessages.scrollHeight;
}

function sendMessage() {
  const value = refs.msgInput.value || '';
  const text = value.trim();
  if (!text || text.length > MAX_MSG_LEN) return;
  if (!state.conn || !state.conn.open || state.screen !== 'CONNECTED') return;
  if (Date.now() - state.lastSendAt < SEND_THROTTLE_MS) return;

  state.lastSendAt = Date.now();
  const payload = { type: 'message', text, ts: Date.now(), id: crypto.randomUUID() };

  try {
    state.conn.send(payload);
    appendMessage({ text, ts: payload.ts, self: true });
    refs.msgInput.value = '';
    refs.msgInput.focus();
    render();
  } catch (error) {
    console.warn('[GhostChat] send failed', error);
    setScreen('CONNECTION_LOST');
  }
}

async function copyText(value, successText) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      showToast(successText);
      return;
    }

    const helper = document.createElement('textarea');
    helper.value = value;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.top = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    const copied = document.execCommand('copy');
    helper.remove();
    if (copied) {
      showToast(successText);
    } else {
      showToast('Could not copy automatically.', 'error');
    }
  } catch (error) {
    console.warn('[GhostChat] copy failed', error);
    showToast('Could not copy automatically.', 'error');
  }
}

function handleShare() {
  const url = buildInvitationUrl(state.roomCode);
  if (navigator.share) {
    navigator.share({ title: 'GhostChat', text: 'Join my GhostChat room', url }).catch(() => {
      copyText(url, 'Invitation link copied');
    });
    return;
  }

  copyText(url, 'Invitation link copied');
}

function openHome() {
  if (state.peer) {
    try {
      state.peer.destroy();
    } catch (error) {
      console.warn('[GhostChat] home destroy warning', error);
    }
  }

  state.peer = null;
  state.conn = null;
  state.roomCode = '';
  refs.joinCodeInput.value = '';
  refs.joinError.textContent = '';
  refs.msgInput.value = '';
  refs.chatMessages.innerHTML = '';
  setScreen('HOME');
}

function finishSession() {
  if (state.conn && state.conn.open) {
    try {
      state.conn.send({ type: 'end' });
    } catch (error) {
      console.warn('[GhostChat] end send warning', error);
    }
  }

  if (state.peer) {
    try {
      state.peer.destroy();
    } catch (error) {
      console.warn('[GhostChat] finish destroy warning', error);
    }
  }

  state.peer = null;
  state.conn = null;
  state.roomCode = '';
  refs.msgInput.value = '';
  refs.chatMessages.innerHTML = '';
  setScreen('ENDED');
}

function parseInvitationFromLocation() {
  const candidate = parseInvitationCode(window.location.hash || window.location.search);
  if (!candidate) return;

  const validationError = validateRoomCode(candidate);
  if (validationError) {
    setError('This invitation link is invalid.');
    return;
  }

  submitJoin(candidate);
}

function bindEvents() {
  refs.createRoomBtn.addEventListener('click', beginCreateFlow);
  refs.joinBtn.addEventListener('click', () => submitJoin(refs.joinCodeInput.value));
  refs.joinCodeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitJoin(refs.joinCodeInput.value);
    }
  });

  refs.copyCodeBtn.addEventListener('click', () => copyText(formatRoomCode(state.roomCode), 'Room code copied'));
  refs.copyLinkBtn.addEventListener('click', () => copyText(buildInvitationUrl(state.roomCode), 'Invitation link copied'));
  refs.shareLinkBtn.addEventListener('click', handleShare);
  refs.waitingLeaveBtn.addEventListener('click', finishSession);
  refs.cancelJoinBtn.addEventListener('click', openHome);
  refs.endChatBtn.addEventListener('click', finishSession);
  refs.newChatFromLostBtn.addEventListener('click', beginCreateFlow);
  refs.homeFromLostBtn.addEventListener('click', openHome);
  refs.startNewChatBtn.addEventListener('click', beginCreateFlow);
  refs.homeFromEndedBtn.addEventListener('click', openHome);
  refs.homeFromErrorBtn.addEventListener('click', openHome);
  refs.retryBtn.addEventListener('click', () => {
    if (state.pendingAction === 'create') {
      beginCreateFlow();
      return;
    }
    if (state.roomCode) {
      startGuestConnection(state.roomCode);
      return;
    }
    openHome();
  });

  refs.msgInput.addEventListener('input', render);
  refs.msgInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  refs.sendBtn.addEventListener('click', sendMessage);

  refs.privacyBtn.addEventListener('click', () => {
    showToast('No signup, no chat history stored by GhostChat.', 'info');
  });

  window.addEventListener('beforeunload', () => {
    if (state.conn && state.conn.open) {
      try {
        state.conn.send({ type: 'end' });
      } catch (error) {
        console.warn('[GhostChat] unload message failed', error);
      }
    }

    if (state.peer) {
      try {
        state.peer.destroy();
      } catch (error) {
        console.warn('[GhostChat] unload destroy failed', error);
      }
    }
  });

  window.addEventListener('hashchange', () => {
    if (state.screen === 'HOME') {
      parseInvitationFromLocation();
    }
  });
}

function boot() {
  refs.createRoomBtn = $id('createRoomBtn');
  refs.joinCodeInput = $id('joinCodeInput');
  refs.joinBtn = $id('joinBtn');
  refs.joinError = $id('joinError');
  refs.roomCodeValue = $id('roomCodeValue');
  refs.copyCodeBtn = $id('copyCodeBtn');
  refs.copyLinkBtn = $id('copyLinkBtn');
  refs.shareLinkBtn = $id('shareLinkBtn');
  refs.waitingLeaveBtn = $id('waitingLeaveBtn');
  refs.cancelJoinBtn = $id('cancelJoinBtn');
  refs.msgInput = $id('msgInput');
  refs.sendBtn = $id('sendBtn');
  refs.chatMessages = $id('chatMessages');
  refs.endChatBtn = $id('endChatBtn');
  refs.statusDot = $id('statusDot');
  refs.statusLabel = $id('statusLabel');
  refs.newChatFromLostBtn = $id('newChatFromLostBtn');
  refs.homeFromLostBtn = $id('homeFromLostBtn');
  refs.startNewChatBtn = $id('startNewChatBtn');
  refs.homeFromEndedBtn = $id('homeFromEndedBtn');
  refs.errorMessage = $id('errorMessage');
  refs.retryBtn = $id('retryBtn');
  refs.homeFromErrorBtn = $id('homeFromErrorBtn');
  refs.privacyBtn = $id('privacyBtn');
  refs.toast = $id('toast');

  bindEvents();
  render();
  parseInvitationFromLocation();
}

boot();

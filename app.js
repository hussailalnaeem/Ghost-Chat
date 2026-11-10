import {
  buildInvitationUrl,
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
const state = {
  screen: 'HOME',
  socket: null,
  peer: null,
  conn: null,
  roomCode: '',
  sessionId: crypto.randomUUID(),
  isHost: false,
  lastSendAt: 0,
  pendingAction: 'home',
  pendingJoinRequestId: null,
  pendingJoinRoomCode: '',
  coordinatorReady: false,
};

const refs = {};

function $id(id) {
  return document.getElementById(id);
}

function setScreen(screen) {
  state.screen = screen;
  render();
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
    } else if (['WAITING', 'JOINING', 'HANDSHAKING', 'CREATING', 'SEARCHING'].includes(state.screen)) {
      statusDot.classList.add('waiting');
    } else if (['ERROR', 'CONNECTION_LOST'].includes(state.screen)) {
      statusDot.classList.add('error');
    }
  }

  if (refs.roomCodeValue) {
    refs.roomCodeValue.textContent = formatRoomCode(state.roomCode || '');
  }

  const sendButton = refs.sendBtn;
  if (sendButton) {
    const hasText = (refs.msgInput.value || '').trim().length > 0;
    const textTooLong = (refs.msgInput.value || '').trim().length > MAX_MSG_LEN;
    const throttleActive = Date.now() - state.lastSendAt < SEND_THROTTLE_MS;
    sendButton.disabled = state.screen !== 'CONNECTED' || !hasText || textTooLong || throttleActive;
  }
}

function resetRuntime() {
  if (state.conn && state.conn.close) {
    try {
      state.conn.close();
    } catch (error) {
      console.warn('[GhostChat] connection close warning', error);
    }
  }
  state.conn = null;

  if (state.peer) {
    try {
      state.peer.destroy();
    } catch (error) {
      console.warn('[GhostChat] peer destroy warning', error);
    }
  }
  state.peer = null;
  state.roomCode = '';
  state.pendingJoinRequestId = null;
  state.pendingJoinRoomCode = '';
  refs.msgInput.value = '';
  refs.chatMessages.innerHTML = '';
}

function setError(message) {
  if (refs.errorMessage) {
    refs.errorMessage.textContent = message;
  }
  setScreen('ERROR');
}

function ensureCoordinator() {
  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const candidatePorts = [8080, 8081, 8082, 8083];

  const tryConnect = (index) => {
    if (index >= candidatePorts.length) {
      showToast('Connection service unavailable.', 'error');
      return;
    }

    const port = candidatePorts[index];
    const socket = new WebSocket(`${protocol}://${location.hostname}:${port}`);
    state.socket = socket;

    socket.addEventListener('open', () => {
      state.coordinatorReady = true;
      sendCoordinator({ type: 'session.hello', sessionId: state.sessionId });
    });

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleCoordinatorMessage(payload);
      } catch (error) {
        console.warn('[GhostChat] invalid coordinator payload', error);
      }
    });

    socket.addEventListener('close', () => {
      state.coordinatorReady = false;
      if (state.socket === socket) {
        state.socket = null;
      }
      tryConnect(index + 1);
    });

    socket.addEventListener('error', () => {
      if (state.socket === socket) {
        state.socket = null;
      }
      tryConnect(index + 1);
    });
  };

  tryConnect(0);
}

function sendCoordinator(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  state.socket.send(JSON.stringify({ ...payload, sessionId: payload.sessionId || state.sessionId }));
}

function openHome() {
  if (refs.approvalModal) {
    refs.approvalModal.hidden = true;
  }
  resetRuntime();
  refs.joinCodeInput.value = '';
  refs.joinError.textContent = '';
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    sendCoordinator({ type: 'match.cancel', sessionId: state.sessionId });
  }
  setScreen('HOME');
}

function finishSession() {
  const roomCodeToClose = state.pendingJoinRoomCode || state.roomCode;

  if (state.conn && state.conn.open) {
    try {
      state.conn.send({ type: 'end' });
    } catch (error) {
      console.warn('[GhostChat] end message failed', error);
    }
  }

  if (state.peer) {
    try {
      state.peer.destroy();
    } catch (error) {
      console.warn('[GhostChat] peer destroy failed', error);
    }
  }

  state.peer = null;
  state.conn = null;
  state.roomCode = '';
  state.pendingJoinRoomCode = '';
  refs.msgInput.value = '';
  refs.chatMessages.innerHTML = '';
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    sendCoordinator({ type: 'room.close', sessionId: state.sessionId, roomCode: roomCodeToClose });
  }
  setScreen('ENDED');
}

function bindPeerConnection(conn) {
  state.conn = conn;

  conn.on('open', () => {
    setScreen('CONNECTED');
    refs.statusLabel.textContent = 'Connected';
    refs.msgInput.focus();
    showToast('Connected');
  });

  conn.on('data', (payload) => {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'message') {
        const text = String(data.text || '').trim();
        if (text && text.length <= MAX_MSG_LEN) {
          appendMessage({ text, ts: Number(data.ts) || Date.now(), self: false });
        }
        return;
      }

      if (data.type === 'end') {
        setScreen('CONNECTION_LOST');
      }
    } catch (error) {
      console.warn('[GhostChat] incoming data parse failed', error);
    }
  });

  conn.on('close', () => {
    if (state.screen !== 'HOME' && state.screen !== 'ERROR' && state.screen !== 'ENDED') {
      setScreen('CONNECTION_LOST');
    }
  });

  conn.on('error', (error) => {
    console.warn('[GhostChat] connection error', error);
    setError('A direct connection error occurred.');
  });
}

function createPeer({ idPrefix, onReady, onConnection }) {
  const peer = new Peer(`${idPrefix}-${crypto.randomUUID()}`, PEER_OPTS);
  peer.on('open', () => {
    state.peer = peer;
    if (onReady) {
      onReady(peer.id);
    }
  });

  peer.on('connection', (conn) => {
    if (onConnection) {
      onConnection(conn);
    }
  });

  peer.on('error', (error) => {
    console.warn('[GhostChat] peer error', error);
    setError('PeerJS connection failed. Please try again.');
  });

  return peer;
}

function beginPrivateRoomCreation() {
  resetRuntime();
  state.pendingAction = 'create';
  state.isHost = true;
  state.roomCode = createRoomCode();
  setScreen('CREATING');
  ensureCoordinator();

  createPeer({
    idPrefix: 'ghost-room',
    onReady: (peerId) => {
      sendCoordinator({ type: 'room.create', sessionId: state.sessionId, hostPeerId: peerId, roomCode: state.roomCode });
    },
    onConnection: (conn) => {
      bindPeerConnection(conn);
    },
  });
}

function beginSearchMatching() {
  resetRuntime();
  state.pendingAction = 'search';
  state.isHost = false;
  setScreen('SEARCHING');
  ensureCoordinator();

  createPeer({
    idPrefix: 'ghost-match',
    onReady: (peerId) => {
      sendCoordinator({ type: 'match.search', sessionId: state.sessionId, peerId });
    },
    onConnection: (conn) => {
      bindPeerConnection(conn);
    },
  });
}

function beginGuestJoin(rawInput) {
  const rawCode = normalizeRoomInput(rawInput ?? refs.joinCodeInput.value);
  const validationError = validateRoomCode(rawCode);
  if (validationError) {
    refs.joinError.textContent = validationError;
    return;
  }

  refs.joinError.textContent = '';
  resetRuntime();
  state.pendingAction = 'join';
  state.roomCode = rawCode;
  state.pendingJoinRoomCode = rawCode;
  setScreen('JOINING');
  ensureCoordinator();

  createPeer({
    idPrefix: 'ghost-join',
    onReady: (peerId) => {
      sendCoordinator({ type: 'room.join.request', sessionId: state.sessionId, roomCode: rawCode, guestPeerId: peerId });
    },
    onConnection: (conn) => {
      bindPeerConnection(conn);
    },
  });
}

function handleCoordinatorMessage(payload) {
  if (!payload || typeof payload !== 'object') return;

  if (payload.type === 'session.ack') {
    state.coordinatorReady = true;
    return;
  }

  if (payload.type === 'room.created') {
    state.roomCode = payload.roomCode || state.roomCode;
    refs.roomCodeValue.textContent = formatRoomCode(state.roomCode);
    setScreen('WAITING');
    showToast('Room created');
    return;
  }

  if (payload.type === 'room.join.received') {
    showToast('Waiting for host approval…');
    return;
  }

  if (payload.type === 'room.join.pending') {
    refs.approvalTitle.textContent = 'Someone wants to join';
    refs.approvalMessage.textContent = `Guest ${payload.guestSessionId.slice(-6)} wants to join room ${payload.roomCode}.`;
    state.pendingJoinRequestId = payload.requestId;
    state.pendingJoinRoomCode = payload.roomCode;
    refs.approvalModal.hidden = false;
    return;
  }

  if (payload.type === 'room.join.authorized') {
    state.roomCode = payload.roomCode || state.roomCode;
    if (state.peer && state.peer.destroy) {
      state.peer.destroy();
    }
    createPeer({
      idPrefix: 'ghost-connect',
      onReady: () => {
        if (state.peer && payload.hostPeerId) {
          const connection = state.peer.connect(payload.hostPeerId, { reliable: true });
          bindPeerConnection(connection);
        }
      },
      onConnection: (conn) => {
        bindPeerConnection(conn);
      },
    });
    return;
  }

  if (payload.type === 'room.join.declined') {
    refs.approvalModal.hidden = true;
    setError('The host declined your request.');
    return;
  }

  if (payload.type === 'match.queued') {
    showToast('Searching for a Ghost…');
    return;
  }

  if (payload.type === 'match.found') {
    setScreen('HANDSHAKING');
    const targetPeerId = payload.peerId;
    if (!targetPeerId) {
      return;
    }

    if (state.peer && state.peer.destroy) {
      state.peer.destroy();
    }

    createPeer({
      idPrefix: 'ghost-match-connect',
      onReady: () => {
        const connection = state.peer.connect(targetPeerId, { reliable: true });
        bindPeerConnection(connection);
      },
      onConnection: (conn) => {
        bindPeerConnection(conn);
      },
    });
    return;
  }

  if (payload.type === 'room.closed') {
    showToast(payload.reason || 'Room closed.', 'error');
    setScreen('CONNECTION_LOST');
    return;
  }

  if (payload.type === 'error') {
    showToast(payload.message || 'Something went wrong.', 'error');
    if (state.screen === 'JOINING' || state.screen === 'SEARCHING') {
      setError(payload.message || 'Unable to reach the coordinator.');
    }
  }
}

function acceptJoinRequest() {
  if (!state.pendingJoinRequestId || !state.pendingJoinRoomCode) {
    refs.approvalModal.hidden = true;
    return;
  }

  sendCoordinator({
    type: 'room.join.accept',
    sessionId: state.sessionId,
    roomCode: state.pendingJoinRoomCode,
    requestId: state.pendingJoinRequestId,
  });

  refs.approvalModal.hidden = true;
  state.pendingJoinRequestId = null;
  state.pendingJoinRoomCode = '';
}

function declineJoinRequest() {
  if (!state.pendingJoinRequestId || !state.pendingJoinRoomCode) {
    refs.approvalModal.hidden = true;
    return;
  }

  sendCoordinator({
    type: 'room.join.decline',
    sessionId: state.sessionId,
    roomCode: state.pendingJoinRoomCode,
    requestId: state.pendingJoinRequestId,
  });

  refs.approvalModal.hidden = true;
  state.pendingJoinRequestId = null;
  state.pendingJoinRoomCode = '';
}

function copyRoomCode() {
  copyText(formatRoomCode(state.roomCode), 'Room code copied');
}

function copyInviteLink() {
  copyText(buildInvitationUrl(state.roomCode), 'Invitation link copied');
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
      showToast('Copy not available in this browser.', 'error');
    }
  } catch (error) {
    console.warn('[GhostChat] copy failed', error);
    showToast('Copy not available in this browser.', 'error');
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

function appendMessage({ text, ts, self }) {
  const wrapper = document.createElement('div');
  wrapper.className = `msg ${self ? 'self' : 'peer'}`;

  const body = document.createElement('div');
  body.textContent = text;

  const time = document.createElement('time');
  time.dateTime = new Date(ts).toISOString();
  time.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  wrapper.appendChild(body);
  wrapper.appendChild(time);
  refs.chatMessages.appendChild(wrapper);
  refs.chatMessages.scrollTop = refs.chatMessages.scrollHeight;
}

function sendMessage() {
  const text = (refs.msgInput.value || '').trim();
  if (!text || text.length > MAX_MSG_LEN) return;
  if (!state.conn || !state.conn.open || state.screen !== 'CONNECTED') return;
  if (Date.now() - state.lastSendAt < SEND_THROTTLE_MS) return;

  const payload = { type: 'message', text, ts: Date.now() };
  state.lastSendAt = Date.now();

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

function parseInvitationFromLocation() {
  const candidate = parseInvitationCode(window.location.hash || window.location.search);
  if (!candidate) return;

  const validationError = validateRoomCode(candidate);
  if (validationError) {
    setError('This invitation link is invalid.');
    return;
  }

  beginGuestJoin(candidate);
}

function bindEvents() {
  refs.findGhostBtn.addEventListener('click', beginSearchMatching);
  refs.createRoomBtn.addEventListener('click', beginPrivateRoomCreation);
  refs.joinBtn.addEventListener('click', () => beginGuestJoin(refs.joinCodeInput.value));
  refs.joinCodeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      beginGuestJoin(refs.joinCodeInput.value);
    }
  });

  refs.copyCodeBtn.addEventListener('click', copyRoomCode);
  refs.copyLinkBtn.addEventListener('click', copyInviteLink);
  refs.shareLinkBtn.addEventListener('click', handleShare);
  refs.waitingLeaveBtn.addEventListener('click', finishSession);
  refs.cancelJoinBtn.addEventListener('click', openHome);
  refs.cancelSearchBtn.addEventListener('click', () => {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      sendCoordinator({ type: 'match.cancel', sessionId: state.sessionId });
    }
    openHome();
  });
  refs.endChatBtn.addEventListener('click', finishSession);
  refs.newChatFromLostBtn.addEventListener('click', beginPrivateRoomCreation);
  refs.homeFromLostBtn.addEventListener('click', openHome);
  refs.startNewChatBtn.addEventListener('click', beginPrivateRoomCreation);
  refs.homeFromEndedBtn.addEventListener('click', openHome);
  refs.homeFromErrorBtn.addEventListener('click', openHome);
  refs.retryBtn.addEventListener('click', () => {
    if (state.pendingAction === 'create') {
      beginPrivateRoomCreation();
      return;
    }
    if (state.pendingAction === 'search') {
      beginSearchMatching();
      return;
    }
    if (state.roomCode) {
      beginGuestJoin(state.roomCode);
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

  refs.acceptJoinBtn.addEventListener('click', acceptJoinRequest);
  refs.declineJoinBtn.addEventListener('click', declineJoinRequest);

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
  refs.findGhostBtn = $id('findGhostBtn');
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
  refs.cancelSearchBtn = $id('cancelSearchBtn');
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
  refs.approvalModal = $id('approvalModal');
  refs.approvalTitle = $id('approvalTitle');
  refs.approvalMessage = $id('approvalMessage');
  refs.acceptJoinBtn = $id('acceptJoinBtn');
  refs.declineJoinBtn = $id('declineJoinBtn');

  bindEvents();
  ensureCoordinator();
  render();
  parseInvitationFromLocation();
}

boot();

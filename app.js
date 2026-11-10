import {
  buildInvitationUrl,
  formatRoomCode,
  normalizeRoomInput,
  parseInvitation,
  validateRoomCode,
} from './js/room-utils.js';
import { CoordinatorClient, getCoordinatorUrl } from './js/coordinator-client.js';

const PEER_OPTS = {
  debug: 0,
  host: '0.peerjs.com',
  port: 443,
  path: '/',
  secure: true,
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
  coordinator: null,
  peer: null,
  peerId: '',
  conn: null,
  roomCode: '',
  roomId: '',
  invitationToken: '',
  mode: 'idle',
  lastMode: 'idle',
  matchId: '',
  expectedPeerId: '',
  authorization: '',
  connectionContext: null,
  pendingConnections: [],
  handshakeSent: false,
  handshakeReceived: false,
  lastSendAt: 0,
  pendingAction: 'home',
  pendingJoinRequestId: null,
  pendingJoinRoomCode: '',
  reportSubmitted: false,
  remoteTyping: false,
  lastTypingAt: 0,
  typingTimer: null,
  remoteTypingTimer: null,
  generation: 0,
  starting: false,
  peerTimer: null,
  requestTimer: null,
  connectionTimer: null,
  seenEvents: new Set(),
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
  toast._timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function render() {
  document.querySelectorAll('[data-state]').forEach((screen) => {
    screen.hidden = screen.dataset.state !== state.screen;
  });
  if (refs.statusDot) {
    refs.statusDot.classList.remove('connected', 'waiting', 'error');
    if (state.screen === 'CONNECTED') refs.statusDot.classList.add('connected');
    else if (['WAITING', 'JOINING', 'HANDSHAKING', 'CREATING', 'SEARCHING'].includes(state.screen)) refs.statusDot.classList.add('waiting');
    else if (['ERROR', 'CONNECTION_LOST'].includes(state.screen)) refs.statusDot.classList.add('error');
  }
  if (refs.roomCodeValue) refs.roomCodeValue.textContent = formatRoomCode(state.roomCode || '');
  if (refs.sendBtn) {
    const text = (refs.msgInput.value || '').trim();
    refs.sendBtn.disabled = state.screen !== 'CONNECTED' || !text || text.length > MAX_MSG_LEN || Date.now() - state.lastSendAt < SEND_THROTTLE_MS;
  }
  if (refs.nextGhostBtn) refs.nextGhostBtn.hidden = state.screen !== 'CONNECTED' || state.mode !== 'matchmaking';
  if (refs.reportBtn) {
    refs.reportBtn.hidden = state.screen !== 'CONNECTED' || state.mode !== 'matchmaking';
    refs.reportBtn.disabled = state.reportSubmitted;
    refs.reportBtn.textContent = state.reportSubmitted ? 'Reported' : 'Report';
  }
  if (refs.typingIndicator) refs.typingIndicator.hidden = state.screen !== 'CONNECTED' || !state.remoteTyping;
  if (refs.newChatFromLostBtn) refs.newChatFromLostBtn.textContent = state.lastMode === 'matchmaking' ? 'Find Another Ghost' : 'Start New Chat';
  if (refs.lostMessage) refs.lostMessage.textContent = state.lastMode === 'matchmaking'
    ? 'The other Ghost has left. You can find another Ghost or return home.'
    : 'The conversation ended unexpectedly. Start a new room or return home.';
}

function clearTimers() {
  clearTimeout(state.peerTimer);
  clearTimeout(state.requestTimer);
  clearTimeout(state.connectionTimer);
  clearTimeout(state.typingTimer);
  clearTimeout(state.remoteTypingTimer);
  state.peerTimer = null;
  state.requestTimer = null;
  state.connectionTimer = null;
  state.typingTimer = null;
  state.remoteTypingTimer = null;
}

function clearConversation() {
  if (state.conn) {
    try { state.conn.close(); } catch (error) { console.warn('[GhostChat] connection close warning', error); }
  }
  state.conn = null;
  for (const pending of state.pendingConnections) {
    clearTimeout(pending.timer);
    pending.connection.close();
  }
  state.pendingConnections = [];
  if (state.peer) {
    try { state.peer.destroy(); } catch (error) { console.warn('[GhostChat] peer destroy warning', error); }
  }
  state.peer = null;
  state.peerId = '';
  state.expectedPeerId = '';
  state.authorization = '';
  state.connectionContext = null;
  state.handshakeSent = false;
  state.handshakeReceived = false;
  state.matchId = '';
  state.pendingJoinRequestId = null;
  state.pendingJoinRoomCode = '';
  refs.msgInput.value = '';
  refs.chatMessages.replaceChildren();
  state.reportSubmitted = false;
  state.remoteTyping = false;
  if (refs.reportModal) refs.reportModal.hidden = true;
  clearTimers();
  render();
}

async function releaseCoordinatorState() {
  const coordinator = state.coordinator;
  if (!coordinator?.sessionId) return;
  try {
    if (state.mode === 'private-host' && state.roomCode) {
      await coordinator.request('room.close', { roomCode: state.roomCode }, 1800);
    } else if (state.mode === 'matchmaking' && state.matchId) {
      await coordinator.request('match.release', { matchId: state.matchId }, 1800);
    } else if (state.mode === 'matchmaking') {
      await coordinator.request('match.cancel', {}, 1800);
    }
  } catch (error) {
    console.warn('[GhostChat] coordinator cleanup deferred to disconnect', error.message);
  }
}

async function disposeCurrentFlow() {
  await releaseCoordinatorState();
  if (state.coordinator) state.coordinator.close();
  state.coordinator = null;
  clearConversation();
  state.mode = 'idle';
  state.roomCode = '';
  state.roomId = '';
  state.invitationToken = '';
}

function setError(message) {
  state.lastMode = state.mode;
  clearConversation();
  if (state.coordinator) state.coordinator.close();
  state.coordinator = null;
  state.mode = 'idle';
  refs.errorMessage.textContent = message || 'GhostChat could not reach its connection service. Please try again.';
  setScreen('ERROR');
}

function rememberEvent(payload) {
  if (!payload?.eventId) return true;
  if (state.seenEvents.has(payload.eventId)) return false;
  state.seenEvents.add(payload.eventId);
  if (state.seenEvents.size > 300) state.seenEvents.delete(state.seenEvents.values().next().value);
  return true;
}

function getCoordinator() {
  if (state.coordinator) return state.coordinator;
  const coordinator = new CoordinatorClient(getCoordinatorUrl());
  coordinator.on('room.join.pending', handleJoinPending);
  coordinator.on('room.join.authorized', handleJoinAuthorized);
  coordinator.on('room.join.declined', handleJoinDeclined);
  coordinator.on('room.closed', handleRoomClosed);
  coordinator.on('match.found', handleMatchFound);
  coordinator.on('match.ended', handleMatchEnded);
  coordinator.on('disconnect', () => {
    if (state.screen === 'CONNECTED') showToast('Coordination disconnected; your direct chat is still active.', 'error');
    else if (!['HOME', 'ENDED', 'ERROR'].includes(state.screen)) setError('The connection service disconnected. Please try again.');
  });
  state.coordinator = coordinator;
  return coordinator;
}

function createReadyPeer(generation) {
  return new Promise((resolve, reject) => {
    if (typeof window.Peer !== 'function') {
      reject(new Error('PeerJS did not load. Check your connection and try again.'));
      return;
    }
    const peer = new window.Peer(`ghost-${crypto.randomUUID()}`, PEER_OPTS);
    state.peer = peer;
    let opened = false;
    const timer = setTimeout(() => {
      if (!opened) reject(new Error('PeerJS timed out while preparing a direct connection.'));
    }, 15_000);

    peer.on('open', (peerId) => {
      if (generation !== state.generation) {
        peer.destroy();
        return;
      }
      opened = true;
      clearTimeout(timer);
      state.peerId = peerId;
      resolve(peerId);
    });
    peer.on('connection', handleIncomingConnection);
    peer.on('error', (error) => {
      console.warn('[GhostChat] PeerJS error', error);
      if (!opened) {
        clearTimeout(timer);
        reject(new Error('PeerJS could not establish a signaling connection. Please try again.'));
      } else if (state.peer === peer) {
        void failConnection('The direct connection failed. Please try again.');
      }
    });
  });
}

async function prepareFreshFlow(action, mode) {
  if (state.starting) return null;
  state.starting = true;
  const generation = ++state.generation;
  await disposeCurrentFlow();
  if (generation !== state.generation) return null;
  state.pendingAction = action;
  state.mode = mode;
  state.lastMode = mode;
  state.starting = false;
  return generation;
}

async function beginPrivateRoomCreation() {
  if (!['HOME', 'ERROR', 'ENDED', 'CONNECTION_LOST'].includes(state.screen)) return;
  state.pendingAction = 'create';
  setScreen('CREATING');
  const generation = await prepareFreshFlow('create', 'private-host');
  if (!generation) return;
  setScreen('CREATING');
  try {
    const coordinator = getCoordinator();
    await coordinator.connect();
    const peerId = await createReadyPeer(generation);
    await coordinator.request('peer.register', { peerId });
    const result = await coordinator.request('room.create', { peerId });
    if (generation !== state.generation) return;
    state.roomCode = result.roomCode;
    state.roomId = result.roomId;
    state.invitationToken = result.invitationToken;
    setScreen('WAITING');
    showToast('Room created');
  } catch (error) {
    if (generation === state.generation) setError(error.message);
  }
}

async function beginSearchMatching() {
  if (!['HOME', 'ERROR', 'ENDED', 'CONNECTION_LOST'].includes(state.screen)) return;
  state.pendingAction = 'search';
  setScreen('SEARCHING');
  const generation = await prepareFreshFlow('search', 'matchmaking');
  if (!generation) return;
  setScreen('SEARCHING');
  try {
    const coordinator = getCoordinator();
    await coordinator.connect();
    const peerId = await createReadyPeer(generation);
    await coordinator.request('peer.register', { peerId });
    const result = await coordinator.request('match.search', { peerId });
    if (generation !== state.generation) return;
    if (result.type === 'match.found') handleMatchFound(result);
    else showToast('Searching for a Ghost…');
  } catch (error) {
    if (generation === state.generation) setError(error.message);
  }
}

async function beginGuestJoin(rawInput, invitationToken = '') {
  if (!['HOME', 'ERROR', 'ENDED', 'CONNECTION_LOST'].includes(state.screen)) return;
  const rawCode = normalizeRoomInput(rawInput ?? refs.joinCodeInput.value);
  const validationError = validateRoomCode(rawCode);
  if (validationError) {
    refs.joinError.textContent = validationError;
    return;
  }

  refs.joinError.textContent = '';
  state.pendingAction = 'join';
  const generation = await prepareFreshFlow('join', 'private-guest');
  if (!generation) return;
  state.roomCode = rawCode;
  state.pendingJoinRoomCode = rawCode;
  setScreen('JOINING');
  try {
    const coordinator = getCoordinator();
    await coordinator.connect();
    const peerId = await createReadyPeer(generation);
    await coordinator.request('peer.register', { peerId });
    const result = await coordinator.request('room.join.request', { roomCode: rawCode, peerId, invitationToken });
    if (generation !== state.generation) return;
    if (result.type === 'room.join.authorized') {
      handleJoinAuthorized(result);
      return;
    }
    state.pendingJoinRequestId = result.joinRequestId;
    showToast('Waiting for host approval…');
    state.requestTimer = setTimeout(() => {
      if (generation === state.generation && state.screen === 'JOINING') setError('Request expired. Please try again.');
    }, 30_000);
  } catch (error) {
    if (generation === state.generation) setError(error.message);
  }
}

function handleJoinPending(payload) {
  if (!rememberEvent(payload)) return;
  if (state.mode !== 'private-host' || state.screen !== 'WAITING' || payload.roomCode !== state.roomCode) {
    const coordinator = state.coordinator;
    if (coordinator) void coordinator.request('room.join.decline', { roomCode: payload.roomCode, joinRequestId: payload.joinRequestId }).catch(() => {});
    return;
  }
  refs.approvalTitle.textContent = 'Someone wants to join';
  refs.approvalMessage.textContent = 'Another Ghost entered your room code.';
  state.pendingJoinRequestId = payload.joinRequestId;
  state.pendingJoinRoomCode = payload.roomCode;
  refs.approvalModal.hidden = false;
}

async function acceptJoinRequest() {
  const joinRequestId = state.pendingJoinRequestId;
  const roomCode = state.pendingJoinRoomCode;
  if (!joinRequestId || !roomCode || !state.coordinator) {
    refs.approvalModal.hidden = true;
    return;
  }
  refs.acceptJoinBtn.disabled = true;
  try {
    const result = await state.coordinator.request('room.join.accept', { roomCode, joinRequestId });
    state.expectedPeerId = result.guestPeerId;
    state.authorization = result.authorization;
    state.connectionContext = { type: 'room', id: result.roomId };
    claimPendingConnections();
    state.pendingJoinRequestId = null;
    state.pendingJoinRoomCode = '';
    refs.approvalModal.hidden = true;
    setScreen('HANDSHAKING');
    startConnectionTimeout('The guest could not connect. The room is still available.');
  } catch (error) {
    refs.approvalModal.hidden = true;
    showToast(error.message, 'error');
  } finally {
    refs.acceptJoinBtn.disabled = false;
  }
}

async function declineJoinRequest() {
  const joinRequestId = state.pendingJoinRequestId;
  const roomCode = state.pendingJoinRoomCode;
  refs.approvalModal.hidden = true;
  state.pendingJoinRequestId = null;
  state.pendingJoinRoomCode = '';
  if (!joinRequestId || !roomCode || !state.coordinator) return;
  try {
    await state.coordinator.request('room.join.decline', { roomCode, joinRequestId });
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function handleJoinAuthorized(payload) {
  if (!rememberEvent(payload)) return;
  if (payload.role === 'host') {
    if (state.mode !== 'private-host' || payload.roomCode !== state.roomCode) return;
    state.expectedPeerId = payload.guestPeerId;
    state.authorization = payload.authorization;
    state.connectionContext = { type: 'room', id: payload.roomId };
    setScreen('HANDSHAKING');
    startConnectionTimeout('The guest could not connect. The room is still available.');
    claimPendingConnections();
    return;
  }
  if (state.mode !== 'private-guest' || state.screen !== 'JOINING' || payload.roomCode !== state.roomCode) return;
  clearTimeout(state.requestTimer);
  state.requestTimer = null;
  state.roomId = payload.roomId;
  state.expectedPeerId = payload.hostPeerId;
  state.authorization = payload.authorization;
  state.connectionContext = { type: 'room', id: payload.roomId };
  claimPendingConnections();
  setScreen('HANDSHAKING');
  startConnectionTimeout('The host could not be reached. Please try again.');
  const connection = state.peer.connect(payload.hostPeerId, {
    reliable: true,
    metadata: { contextId: payload.roomId, authorization: payload.authorization },
  });
  bindPeerConnection(connection);
}

function handleJoinDeclined(payload) {
  if (!rememberEvent(payload) || state.mode !== 'private-guest') return;
  clearTimeout(state.requestTimer);
  setError(payload.reason || 'Join request declined.');
}

function handleRoomClosed(payload) {
  if (!rememberEvent(payload) || state.screen === 'ENDED' || state.screen === 'HOME') return;
  state.lastMode = state.mode;
  clearConversation();
  state.mode = 'idle';
  setScreen('CONNECTION_LOST');
  showToast(payload.reason || 'Room closed.', 'error');
}

function handleMatchFound(payload) {
  if (!rememberEvent(payload) || state.mode !== 'matchmaking' || !payload.matchId) return;
  if (state.screen === 'HOME' || state.screen === 'ENDED' || state.screen === 'ERROR') return;
  if (state.matchId && state.matchId !== payload.matchId) return;
  state.matchId = payload.matchId;
  state.expectedPeerId = payload.remotePeerId;
  state.authorization = payload.authorization;
  state.connectionContext = { type: 'match', id: payload.matchId };
  claimPendingConnections();
  setScreen('HANDSHAKING');
  startConnectionTimeout('The match could not connect. Search again to find another Ghost.');
  if (payload.role === 'initiator') {
    const connection = state.peer.connect(payload.remotePeerId, {
      reliable: true,
      metadata: { contextId: payload.matchId, authorization: payload.authorization },
    });
    bindPeerConnection(connection);
  }
}

function handleMatchEnded(payload) {
  if (!rememberEvent(payload) || payload.matchId !== state.matchId) return;
  state.lastMode = 'matchmaking';
  clearConversation();
  state.mode = 'idle';
  setScreen('CONNECTION_LOST');
}

function startConnectionTimeout(message) {
  clearTimeout(state.connectionTimer);
  const generation = state.generation;
  state.connectionTimer = setTimeout(() => {
    if (generation === state.generation && state.screen === 'HANDSHAKING') void failConnection(message);
  }, 15_000);
}

function handleIncomingConnection(connection) {
  if (state.conn) {
    connection.close();
    return;
  }
  if (!state.expectedPeerId) {
    const canArriveEarly = (state.mode === 'private-host' && state.screen === 'WAITING')
      || (state.mode === 'matchmaking' && ['SEARCHING', 'HANDSHAKING'].includes(state.screen));
    if (!canArriveEarly) {
      connection.close();
      return;
    }
    const pending = { connection, timer: setTimeout(() => {
      connection.close();
      state.pendingConnections = state.pendingConnections.filter((item) => item.connection !== connection);
    }, 5000) };
    state.pendingConnections.push(pending);
    return;
  }
  if (connection.peer !== state.expectedPeerId) {
    connection.close();
    return;
  }
  bindPeerConnection(connection);
}

function claimPendingConnections() {
  if (!state.expectedPeerId) return;
  for (const pending of state.pendingConnections) {
    clearTimeout(pending.timer);
    if (pending.connection.peer === state.expectedPeerId && !state.conn) bindPeerConnection(pending.connection);
    else pending.connection.close();
  }
  state.pendingConnections = [];
}

function bindPeerConnection(connection) {
  if (!connection || state.conn) {
    if (connection && connection !== state.conn) connection.close();
    return;
  }
  const metadata = connection.metadata || {};
  if (connection.peer !== state.expectedPeerId || metadata.contextId !== state.connectionContext?.id || metadata.authorization !== state.authorization) {
    connection.close();
    return;
  }
  state.conn = connection;
  connection.on('open', () => {
    if (state.conn !== connection || !state.peer) return;
    connection.send({
      type: 'handshake',
      contextId: state.connectionContext.id,
      authorization: state.authorization,
      peerId: state.peer.id,
    });
    state.handshakeSent = true;
    if (state.handshakeReceived) markConnected();
  });
  connection.on('data', handlePeerData);
  connection.on('close', () => {
    if (state.conn !== connection) return;
    state.conn = null;
    if (!['HOME', 'ERROR', 'ENDED', 'CONNECTION_LOST'].includes(state.screen)) showConnectionLost();
  });
  connection.on('error', (error) => {
    console.warn('[GhostChat] data connection error', error);
    void failConnection('The direct connection failed. Please try again.');
  });
}

function handlePeerData(payload) {
  let data = payload;
  try {
    if (typeof payload === 'string') data = JSON.parse(payload);
  } catch {
    return;
  }
  if (!data || typeof data !== 'object') return;
  if (data.type === 'handshake') {
    const valid = data.contextId === state.connectionContext?.id
      && data.authorization === state.authorization
      && data.peerId === state.expectedPeerId;
    if (!valid) {
      void failConnection('The other peer could not be authenticated.');
      return;
    }
    state.handshakeReceived = true;
    if (state.handshakeSent) markConnected();
    return;
  }
  if (state.screen !== 'CONNECTED') return;
  if (data.type === 'message') {
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (text && text.length <= MAX_MSG_LEN) appendMessage({ text, ts: data.ts, self: false });
  } else if (data.type === 'typing' && typeof data.active === 'boolean') {
    state.remoteTyping = data.active;
    clearTimeout(state.remoteTypingTimer);
    if (data.active) {
      state.remoteTypingTimer = setTimeout(() => {
        state.remoteTyping = false;
        render();
      }, 2500);
    }
    render();
  } else if (data.type === 'end') {
    showConnectionLost();
  }
}

function markConnected() {
  if (state.screen !== 'HANDSHAKING' || !state.handshakeSent || !state.handshakeReceived) return;
  clearTimeout(state.connectionTimer);
  state.connectionTimer = null;
  setScreen('CONNECTED');
  refs.statusLabel.textContent = 'Connected';
  refs.msgInput.focus();
  showToast('Connected');
}

async function failConnection(message) {
  if (state.screen === 'ERROR' || state.screen === 'ENDED') return;
  const mode = state.mode;
  const matchId = state.matchId;
  if (mode === 'matchmaking' && matchId && state.coordinator) {
    try { await state.coordinator.request('match.release', { matchId }, 1500); } catch { /* socket cleanup releases stale matches */ }
  }
  state.lastMode = mode;
  clearConversation();
  state.mode = 'idle';
  if (message) {
    refs.errorMessage.textContent = message;
    setScreen('ERROR');
  } else {
    setScreen('CONNECTION_LOST');
  }
}

function showConnectionLost() {
  const matchId = state.matchId;
  if (state.coordinator && matchId) {
    void state.coordinator.request('match.release', { matchId }, 1500).catch(() => {});
  }
  state.lastMode = state.mode;
  clearConversation();
  state.mode = 'idle';
  setScreen('CONNECTION_LOST');
}

async function openHome() {
  state.generation += 1;
  state.starting = false;
  refs.approvalModal.hidden = true;
  setScreen('HOME');
  await disposeCurrentFlow();
  refs.joinCodeInput.value = '';
  refs.joinError.textContent = '';
  state.pendingAction = 'home';
  setScreen('HOME');
}

async function finishSession() {
  state.generation += 1;
  state.starting = false;
  const mode = state.mode;
  state.lastMode = mode;
  if (state.conn?.open) {
    try { state.conn.send({ type: 'end' }); } catch (error) { console.warn('[GhostChat] end message failed', error); }
  }
  await releaseCoordinatorState();
  if (state.coordinator) state.coordinator.close();
  state.coordinator = null;
  clearConversation();
  state.mode = 'idle';
  state.roomCode = '';
  state.roomId = '';
  setScreen('ENDED');
}

async function nextGhost() {
  if (state.mode !== 'matchmaking' || state.screen !== 'CONNECTED') return;
  const matchId = state.matchId;
  const coordinator = state.coordinator;
  if (state.conn?.open) {
    try { state.conn.send({ type: 'end' }); } catch { /* release continues server-side */ }
  }
  if (coordinator && matchId) {
    try { await coordinator.request('match.release', { matchId }, 1800); } catch { /* closing the session clears stale state */ }
  }
  state.matchId = '';
  clearConversation();
  state.mode = 'idle';
  setScreen('HOME');
  await beginSearchMatching();
}

function openReportModal() {
  if (state.screen !== 'CONNECTED' || state.mode !== 'matchmaking' || state.reportSubmitted) return;
  refs.reportError.textContent = '';
  refs.reportModal.hidden = false;
  refs.reportReason.focus();
}

async function submitReport() {
  if (state.screen !== 'CONNECTED' || state.mode !== 'matchmaking' || !state.matchId || !state.coordinator) return;
  refs.submitReportBtn.disabled = true;
  refs.reportError.textContent = '';
  try {
    await state.coordinator.request('report.submit', {
      matchId: state.matchId,
      reason: refs.reportReason.value,
    });
    state.reportSubmitted = true;
    refs.reportModal.hidden = true;
    showToast('Report submitted');
    render();
  } catch (error) {
    refs.reportError.textContent = error.message || 'The report could not be submitted.';
  } finally {
    refs.submitReportBtn.disabled = false;
  }
}

function copyRoomCode() {
  void copyText(formatRoomCode(state.roomCode), 'Room code copied');
}

function copyInviteLink() {
  void copyText(buildInvitationUrl(state.roomCode, undefined, state.invitationToken), 'Invitation link copied');
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
    showToast(copied ? successText : 'Copy not available in this browser.', copied ? 'info' : 'error');
  } catch (error) {
    console.warn('[GhostChat] copy failed', error);
    showToast('Copy not available in this browser.', 'error');
  }
}

function handleShare() {
  const url = buildInvitationUrl(state.roomCode, undefined, state.invitationToken);
  if (navigator.share) {
    navigator.share({ title: 'GhostChat', text: 'Join my GhostChat room', url }).catch(() => copyText(url, 'Invitation link copied'));
  } else {
    void copyText(url, 'Invitation link copied');
  }
}

function appendMessage({ text, ts, self }) {
  const wrapper = document.createElement('div');
  wrapper.className = `msg ${self ? 'self' : 'peer'}`;
  const body = document.createElement('div');
  body.textContent = text;
  const time = document.createElement('time');
  const timestamp = Number(ts);
  const date = Number.isFinite(timestamp) && timestamp > 0 && timestamp < 8.64e15 ? new Date(timestamp) : new Date();
  time.dateTime = date.toISOString();
  time.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  wrapper.append(body, time);
  refs.chatMessages.appendChild(wrapper);
  refs.chatMessages.scrollTop = refs.chatMessages.scrollHeight;
}

function sendMessage() {
  const text = (refs.msgInput.value || '').trim();
  if (!text || text.length > MAX_MSG_LEN || !state.conn?.open || state.screen !== 'CONNECTED') return;
  if (Date.now() - state.lastSendAt < SEND_THROTTLE_MS) return;
  const payload = { type: 'message', text, ts: Date.now() };
  state.lastSendAt = payload.ts;
  try {
    sendTyping(false);
    state.conn.send(payload);
    appendMessage({ ...payload, self: true });
    refs.msgInput.value = '';
    refs.msgInput.focus();
    render();
  } catch (error) {
    console.warn('[GhostChat] send failed', error);
    showConnectionLost();
  }
}

function sendTyping(active) {
  if (!state.conn?.open || state.screen !== 'CONNECTED') return;
  try { state.conn.send({ type: 'typing', active }); } catch { /* a close event handles connection cleanup */ }
}

function handleComposerInput() {
  render();
  const active = Boolean((refs.msgInput.value || '').trim());
  if (!active) {
    clearTimeout(state.typingTimer);
    state.typingTimer = null;
    sendTyping(false);
    return;
  }
  if (Date.now() - state.lastTypingAt >= 900) {
    sendTyping(true);
    state.lastTypingAt = Date.now();
  }
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(() => sendTyping(false), 1800);
}

function parseInvitationFromLocation() {
  const invitation = parseInvitation(window.location.hash || window.location.search);
  if (!invitation) return;
  const validationError = validateRoomCode(invitation.code);
  if (validationError) {
    setError('This invitation link is invalid.');
    return;
  }
  void beginGuestJoin(invitation.code, invitation.token);
}

function bindEvents() {
  refs.findGhostBtn.addEventListener('click', () => void beginSearchMatching());
  refs.createRoomBtn.addEventListener('click', () => void beginPrivateRoomCreation());
  refs.joinBtn.addEventListener('click', () => void beginGuestJoin(refs.joinCodeInput.value));
  refs.joinCodeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void beginGuestJoin(refs.joinCodeInput.value);
    }
  });
  refs.copyCodeBtn.addEventListener('click', copyRoomCode);
  refs.copyLinkBtn.addEventListener('click', copyInviteLink);
  refs.shareLinkBtn.addEventListener('click', handleShare);
  refs.waitingLeaveBtn.addEventListener('click', () => void finishSession());
  refs.cancelJoinBtn.addEventListener('click', () => void openHome());
  refs.cancelSearchBtn.addEventListener('click', () => void openHome());
  refs.endChatBtn.addEventListener('click', () => void finishSession());
  refs.nextGhostBtn.addEventListener('click', () => void nextGhost());
  refs.reportBtn.addEventListener('click', openReportModal);
  refs.submitReportBtn.addEventListener('click', () => void submitReport());
  refs.cancelReportBtn.addEventListener('click', () => { refs.reportModal.hidden = true; });
  refs.newChatFromLostBtn.addEventListener('click', () => {
    if (state.lastMode === 'matchmaking') void beginSearchMatching();
    else void beginPrivateRoomCreation();
  });
  refs.homeFromLostBtn.addEventListener('click', () => void openHome());
  refs.startNewChatBtn.addEventListener('click', () => void beginPrivateRoomCreation());
  refs.homeFromEndedBtn.addEventListener('click', () => void openHome());
  refs.homeFromErrorBtn.addEventListener('click', () => void openHome());
  refs.retryBtn.addEventListener('click', () => {
    if (state.pendingAction === 'create') void beginPrivateRoomCreation();
    else if (state.pendingAction === 'search') void beginSearchMatching();
    else if (state.pendingAction === 'join') void beginGuestJoin(state.roomCode || refs.joinCodeInput.value);
    else void openHome();
  });
  refs.msgInput.addEventListener('input', handleComposerInput);
  refs.msgInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  refs.sendBtn.addEventListener('click', sendMessage);
  refs.privacyBtn.addEventListener('click', () => showToast('No signup, no chat history stored by GhostChat.', 'info'));
  refs.acceptJoinBtn.addEventListener('click', () => void acceptJoinRequest());
  refs.declineJoinBtn.addEventListener('click', () => void declineJoinRequest());
  window.addEventListener('beforeunload', () => {
    if (state.conn?.open) {
      try { state.conn.send({ type: 'end' }); } catch { /* socket close handles cleanup */ }
    }
    state.coordinator?.close();
    state.peer?.destroy();
  });
  window.addEventListener('hashchange', () => {
    if (state.screen === 'HOME') parseInvitationFromLocation();
  });
}

function boot() {
  const ids = [
    'findGhostBtn', 'createRoomBtn', 'joinCodeInput', 'joinBtn', 'joinError', 'roomCodeValue',
    'copyCodeBtn', 'copyLinkBtn', 'shareLinkBtn', 'waitingLeaveBtn', 'cancelJoinBtn', 'cancelSearchBtn',
    'msgInput', 'sendBtn', 'chatMessages', 'typingIndicator', 'endChatBtn', 'nextGhostBtn', 'reportBtn', 'statusDot', 'statusLabel',
    'newChatFromLostBtn', 'homeFromLostBtn', 'startNewChatBtn', 'homeFromEndedBtn', 'errorMessage',
    'retryBtn', 'homeFromErrorBtn', 'privacyBtn', 'toast', 'approvalModal', 'approvalTitle',
    'approvalMessage', 'acceptJoinBtn', 'declineJoinBtn', 'lostMessage', 'reportModal', 'reportReason',
    'reportError', 'submitReportBtn', 'cancelReportBtn',
  ];
  for (const id of ids) refs[id] = $id(id);
  bindEvents();
  render();
  parseInvitationFromLocation();
}

boot();
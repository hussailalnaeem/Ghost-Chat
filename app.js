(() => {
  'use strict';

  const PEER_OPTS = {
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    },
  };
  const ROOM_RE = /^[a-z0-9-]{3,32}$/;
  const MAX_MSG_LEN = 2000;
  const CONNECT_TIMEOUT_MS = 15000;
  const SEND_THROTTLE_MS = 150;
  const ALLOWED_TYPES = new Set(['hello', 'message', 'bye']);

  let state = 'LANDING';
  let peer = null;
  let conn = null;
  let isHost = false;
  let roomId = '';
  let lastSendAt = 0;
  let connectTimer = null;
  let copyTimer = null;
  let guestStarted = false;
  let intentionalClose = false;
  const $ = (id) => document.getElementById(id);
  const sections = Array.from(document.querySelectorAll('[data-state]'));

  function render() {
    sections.forEach((section) => {
      section.hidden = section.dataset.state !== state;
    });

    const dot = $('statusDot');
    if (dot) {
      dot.classList.remove('connected', 'connecting', 'disconnected');
      if (state === 'CONNECTED') {
        dot.classList.add('connected');
      } else if (state === 'CLAIMING_ID' || state === 'GUEST_CONNECTING' || state === 'HOST_WAITING') {
        dot.classList.add('connecting');
      } else if (state === 'PEER_LEFT' || state === 'ERROR') {
        dot.classList.add('disconnected');
      }
      dot.setAttribute('aria-label', state === 'CONNECTED' ? 'Connected' : 'Disconnected');
    }

    const sendButton = $('sendBtn');
    if (sendButton) {
      const inputValue = $('msgInput').value;
      const trimmed = String(inputValue || '').trim();
      const throttleActive = Date.now() - lastSendAt < SEND_THROTTLE_MS;
      sendButton.disabled = state !== 'CONNECTED' || trimmed.length === 0 || trimmed.length > MAX_MSG_LEN || throttleActive;
    }
  }

  function setState(next) {
    state = next;
    render();
  }

  function generateRoom() {
    const value = crypto.getRandomValues(new Uint32Array(1))[0];
    return value.toString(36).padStart(8, '0').slice(-8);
  }

  function normalizeRoom(raw) {
    return String(raw || '').trim().toLowerCase();
  }

  function validateRoom(code) {
    if (!code) {
      return 'Room code is required.';
    }
    if (code.length < 3) {
      return 'Room code must be at least 3 characters.';
    }
    if (code.length > 32) {
      return 'Room code is too long (max 32).';
    }
    if (!ROOM_RE.test(code)) {
      return 'Only lowercase letters, numbers, and dashes are allowed.';
    }
    return null;
  }

  function readRoomFromUrl() {
    return new URLSearchParams(location.search).get('room');
  }

  function writeRoomToUrl(code) {
    history.replaceState(null, '', '?room=' + encodeURIComponent(code));
  }

  function showLandingError(message) {
    const errorEl = $('landingError');
    if (!errorEl) return;
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  function init() {
    if (typeof Peer !== 'function') {
      showLandingError('PeerJS failed to load. Refresh and try again.');
      setState('LANDING');
      return;
    }

    let rawRoom = readRoomFromUrl();
    if (rawRoom === null) {
      rawRoom = generateRoom();
      const generatedError = validateRoom(rawRoom);
      if (generatedError) {
        showLandingError(generatedError);
        setState('LANDING');
        return;
      }
      writeRoomToUrl(rawRoom);
    }

    const normalized = normalizeRoom(rawRoom);
    const validationError = validateRoom(normalized);
    if (validationError) {
      $('roomInput').value = normalized;
      showLandingError(validationError);
      setState('LANDING');
      return;
    }

    roomId = normalized;
    $('roomInput').value = roomId;
    $('connectedRoom').textContent = roomId;
    startPeer();
  }

  function startPeer() {
    clearTimeout(connectTimer);
    connectTimer = null;
    guestStarted = false;
    intentionalClose = false;
    peer = new Peer(roomId, PEER_OPTS);
    setState('CLAIMING_ID');

    peer.on('open', () => {
      isHost = true;
      $('roomDisplay').textContent = roomId;
      setState('HOST_WAITING');
    });
    peer.on('error', handlePeerError);
    peer.on('connection', handleIncoming);
    peer.on('disconnected', () => {
      if (!peer || intentionalClose) return;
      try {
        peer.reconnect();
      } catch (error) {
        console.warn('[GhostChat reconnect failed]', error);
      }
    });
    peer.on('close', cleanup);
  }

  function handlePeerError(err) {
    console.warn('[GhostChat peer error]', err);

    if (err && err.type === 'unavailable-id') {
      becomeGuest();
      return;
    }

    const type = err && err.type;
    let message;

    if (type === 'peer-unavailable') {
      message = 'That room has no host. Ask them to open the link and stay on the page.';
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(type)) {
      message = "Can't reach the connection service. Check your internet and try again.";
    } else if (type === 'webrtc') {
      message = "Couldn't establish a direct connection. Some networks block P2P chat.";
    } else if (type === 'browser-incompatible') {
      message = "Your browser doesn't support WebRTC. Try Chrome, Firefox, or Safari.";
    } else {
      message = 'Something went wrong: ' + ((err && (err.message || err.type)) || 'unknown error');
    }

    $('errorMsg').textContent = message;
    setState('ERROR');
  }

  function becomeGuest() {
    isHost = false;
    guestStarted = true;
    setState('GUEST_CONNECTING');

    let outgoing;
    try {
      outgoing = peer.connect(roomId, { reliable: true, metadata: { v: 1 } });
    } catch (error) {
      $('errorMsg').textContent = 'Could not connect to the host. Please try again.';
      setState('ERROR');
      return;
    }

    conn = outgoing;
    connectTimer = setTimeout(() => {
      if (state !== 'GUEST_CONNECTING') return;
      closeConn();
      $('errorMsg').textContent = 'Timed out connecting to host. They may have left.';
      setState('ERROR');
    }, CONNECT_TIMEOUT_MS);

    outgoing.on('open', () => {
      clearTimeout(connectTimer);
      connectTimer = null;
      attachConn();
      setState('CONNECTED');
      sendHello();
    });
    outgoing.on('error', handlePeerError);
  }

  function handleIncoming(incoming) {
    if (conn && conn.open) {
      incoming.on('open', () => {
        try {
          incoming.send({ type: 'bye' });
        } catch (error) {
          console.warn('[GhostChat] Rejected connection could not send bye.', error);
        }
        incoming.close();
      });
      return;
    }

    conn = incoming;
    incoming.on('open', () => {
      attachConn();
      setState('CONNECTED');
      sendHello();
    });
  }

  function attachConn() {
    if (!conn) return;
    conn.on('data', onData);
    conn.on('close', () => {
      if (state !== 'ERROR' && state !== 'LANDING') {
        setState('PEER_LEFT');
      }
    });
    conn.on('error', () => {
      if (state !== 'ERROR' && state !== 'LANDING') {
        setState('PEER_LEFT');
      }
    });
  }

  function onData(raw) {
    let data;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      return;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    if (!ALLOWED_TYPES.has(data.type)) return;

    if (data.type === 'hello') {
      return;
    }

    if (data.type === 'bye') {
      setState('PEER_LEFT');
      return;
    }

    if (typeof data.text !== 'string') return;
    const text = data.text;
    if (text.length === 0 || text.length > MAX_MSG_LEN) return;

    const ts = typeof data.ts === 'number' && Number.isFinite(data.ts) ? data.ts : Date.now();
    appendMessage({ text, ts, self: false });
  }

  function sendMessage(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || trimmed.length > MAX_MSG_LEN) return;
    if (Date.now() - lastSendAt < SEND_THROTTLE_MS) return;
    if (!conn || !conn.open || state !== 'CONNECTED') return;

    lastSendAt = Date.now();
    const payload = {
      type: 'message',
      text: trimmed,
      ts: Date.now(),
      id: crypto.randomUUID(),
    };

    try {
      conn.send(payload);
    } catch (error) {
      setState('PEER_LEFT');
      return;
    }

    appendMessage({ text: trimmed, ts: payload.ts, self: true });
    $('msgInput').value = '';
    $('msgInput').focus();
    render();
    setTimeout(() => render(), SEND_THROTTLE_MS);
  }

  function sendHello() {
    if (conn && conn.open) {
      conn.send({ type: 'hello', v: 1 });
    }
  }

  function appendMessage({ text, ts, self }) {
    const messages = $('messages');
    const sentinel = $('sentinel');
    const wasNearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 100;
    const el = document.createElement('div');
    el.className = 'msg ' + (self ? 'self' : 'peer');

    const body = document.createElement('span');
    body.textContent = text;

    const time = document.createElement('time');
    time.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    el.appendChild(body);
    el.appendChild(time);
    messages.insertBefore(el, sentinel);

    if (wasNearBottom) {
      sentinel.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }

  function joinRoom() {
    const code = normalizeRoom($('roomInput').value);
    $('roomInput').value = code;
    const validationError = validateRoom(code);
    showLandingError(validationError);
    if (validationError) {
      return;
    }
    location.href = '?room=' + encodeURIComponent(code);
  }

  function closeConn() {
    clearTimeout(connectTimer);
    connectTimer = null;
    if (conn) {
      try {
        conn.close();
      } catch (error) {
        console.warn('[GhostChat] Close error', error);
      }
    }
    conn = null;
  }

  function leaveToHome() {
    intentionalClose = true;
    guestStarted = false;
    closeConn();
    if (peer) {
      peer.destroy();
      peer = null;
    }
    roomId = '';
    isHost = false;
    history.replaceState(null, '', location.pathname);
    $('roomInput').value = '';
    showLandingError('');
    setState('LANDING');
  }

  function cleanup() {
    clearTimeout(connectTimer);
    connectTimer = null;
    if (intentionalClose || state === 'LANDING' || state === 'PEER_LEFT') {
      return;
    }
    setState('PEER_LEFT');
  }

  function copyRoomLink() {
    const button = $('copyBtn');
    const url = location.href;

    const finishCopy = () => {
      button.textContent = 'Copied!';
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        button.textContent = 'Copy link';
      }, 1500);
    };

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(url).then(finishCopy).catch(() => {
        const helper = document.createElement('textarea');
        helper.value = url;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.top = '-9999px';
        document.body.appendChild(helper);
        helper.select();
        try {
          document.execCommand('copy');
        } catch (error) {
          window.prompt('Copy this link:', url);
        }
        helper.remove();
        finishCopy();
      });
      return;
    }

    const helper = document.createElement('textarea');
    helper.value = url;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.top = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    try {
      document.execCommand('copy');
    } catch (error) {
      window.prompt('Copy this link:', url);
    }
    helper.remove();
    finishCopy();
  }

  $('joinBtn').addEventListener('click', joinRoom);
  $('roomInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      joinRoom();
    }
  });

  $('sendBtn').addEventListener('click', () => {
    sendMessage($('msgInput').value);
  });

  $('msgInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage($('msgInput').value);
    }
  });
  $('msgInput').addEventListener('input', render);

  $('copyBtn').addEventListener('click', copyRoomLink);
  $('leaveBtn').addEventListener('click', leaveToHome);
  $('newChatBtn').addEventListener('click', leaveToHome);
  $('homeBtn').addEventListener('click', leaveToHome);
  $('cancelBtn').addEventListener('click', leaveToHome);
  $('retryBtn').addEventListener('click', () => {
    location.reload();
  });

  window.addEventListener('beforeunload', () => {
    if (conn && conn.open) {
      try {
        conn.send({ type: 'bye' });
      } catch (error) {
        console.warn('[GhostChat] Closing connection failed.', error);
      }
    }
    if (peer) {
      peer.destroy();
    }
  });

  render();
  init();
})();

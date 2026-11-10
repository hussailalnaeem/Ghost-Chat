import { recordTiming } from './timing.js';

export function getCoordinatorUrl(location = window.location) {
  const url = new URL('/api/ws', location.origin);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export class CoordinatorClient {
  constructor(url, WebSocketConstructor = WebSocket) {
    this.url = url;
    this.WebSocketConstructor = WebSocketConstructor;
    this.socket = null;
    this.connectPromise = null;
    this.sessionId = null;
    this.pending = new Map();
    this.listeners = new Map();
    this.closedByClient = false;
  }

  connect() {
    if (this.socket?.readyState === this.WebSocketConstructor.OPEN && this.sessionId) {
      return Promise.resolve(this.sessionId);
    }
    if (this.connectPromise) return this.connectPromise;

    this.closedByClient = false;
    const connectStartedAt = performance.now();
    recordTiming('coordinator.websocket.start', { url: this.url });
    let socket;
    try {
      socket = new this.WebSocketConstructor(this.url);
    } catch (error) {
      return Promise.reject(error);
    }
    this.socket = socket;

    let settled = false;
    let timeout;
    const connection = new Promise((resolve, reject) => {
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      timeout = setTimeout(() => {
        fail(new Error('GhostChat could not reach its connection service. Please try again.'));
        socket.close();
      }, 8000);

      socket.addEventListener('open', () => {
        recordTiming('coordinator.websocket.open', { durationMs: performance.now() - connectStartedAt });
      });

      socket.addEventListener('message', (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (payload?.type === 'session.ack' && payload.sessionId && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.sessionId = payload.sessionId;
          recordTiming('coordinator.session.ack', {
            durationMs: performance.now() - connectStartedAt,
            serverTiming: payload.serverTiming || null,
          });
          resolve(payload.sessionId);
          return;
        }
        if (payload?.type === 'error' && !settled) {
          fail(new Error(payload.message || 'The connection service is unavailable.'));
          return;
        }

        const pending = payload?.requestId && this.pending.get(payload.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(payload.requestId);
          recordTiming(`coordinator.${pending.type}`, {
            durationMs: performance.now() - pending.startedAt,
            serverTiming: payload.serverTiming || null,
          });
          if (payload.type === 'error') pending.reject(new Error(payload.message || 'The request failed.'));
          else pending.resolve(payload);
          return;
        }
        this.emit(payload?.type, payload);
      });

      socket.addEventListener('error', () => {
        fail(new Error('GhostChat could not reach its connection service. Please try again.'));
        this.emit('disconnect', { reason: 'Connection service unavailable.' });
      });

      socket.addEventListener('close', () => {
        const wasAuthenticated = Boolean(this.sessionId);
        clearTimeout(timeout);
        this.socket = null;
        this.sessionId = null;
        fail(new Error('GhostChat lost its connection to the coordination service. Please try again.'));
        this.rejectPending(new Error('The coordination service disconnected.'));
        if (wasAuthenticated && !this.closedByClient) this.emit('disconnect', { reason: 'Connection service disconnected.' });
      });
    });

    this.connectPromise = connection;
    connection.finally(() => {
      if (this.connectPromise === connection) this.connectPromise = null;
    }).catch(() => {});
    return connection;
  }

  async request(type, fields = {}, timeoutMs = 12_000) {
    await this.connect();
    if (!this.socket || this.socket.readyState !== this.WebSocketConstructor.OPEN) {
      throw new Error('The coordination service is not connected.');
    }
    const requestId = crypto.randomUUID();
    const requestStartedAt = performance.now();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('The request timed out. Please try again.'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout, type, startedAt: requestStartedAt });
      this.socket.send(JSON.stringify({ type, requestId, ...fields }));
    });
  }

  on(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    return () => this.listeners.get(type)?.delete(listener);
  }

  emit(type, payload) {
    for (const listener of this.listeners.get(type) || []) listener(payload);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.closedByClient = true;
    this.rejectPending(new Error('Connection closed.'));
    if (this.socket) this.socket.close();
    this.socket = null;
    this.sessionId = null;
  }
}
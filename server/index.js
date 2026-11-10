import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { createCoordinatorService } from './coordinator.js';
import { createMemoryStore } from './store.js';

export { createCoordinatorService } from './coordinator.js';
export { createMemoryState, createMemoryStore } from './store.js';

export function createCoordinatorServer(port = 0, options = {}) {
  const serviceOptions = { ...options };
  if (!serviceOptions.store && !serviceOptions.redisUrl && !serviceOptions.requireRedis) serviceOptions.store = createMemoryStore();
  const service = createCoordinatorService(serviceOptions);
  const server = new WebSocketServer({ port, maxPayload: 16 * 1024 });
  server.on('connection', (socket, request) => service.attach(socket, request));
  server.on('close', () => { void service.close(); });
  return server;
}

export function createLocalServer({ port = Number(process.env.PORT || 8787), host = 'localhost' } = {}) {
  const root = new URL('../', import.meta.url);
  const service = createCoordinatorService({ store: createMemoryStore() });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname === '/api/ws') {
      response.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('WebSocket upgrade required');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    } catch {
      response.writeHead(400).end('Bad request');
      return;
    }
    if (pathname.includes('..') || !/^\/(?:index\.html|app\.js|styles\.css|js\/[^/]+\.js|assets\/[A-Za-z0-9._-]+)$/.test(pathname)) {
      response.writeHead(404).end('Not found');
      return;
    }

    try {
      const file = await readFile(new URL(`.${pathname}`, root));
      const extension = pathname.split('.').at(-1);
      const contentType = extension === 'html' ? 'text/html; charset=utf-8'
        : extension === 'css' ? 'text/css; charset=utf-8'
          : extension === 'svg' ? 'image/svg+xml'
            : 'text/javascript; charset=utf-8';
      response.writeHead(200, { 'content-type': contentType, 'x-content-type-options': 'nosniff' });
      response.end(file);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url || '/', 'http://localhost').pathname !== '/api/ws') {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit('connection', client, request));
  });
  webSockets.on('connection', (socket, request) => service.attach(socket, request));
  server.on('close', () => {
    webSockets.close();
    void service.close();
  });
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`GhostChat local app listening on http://${host}:${address.port}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createLocalServer();
}
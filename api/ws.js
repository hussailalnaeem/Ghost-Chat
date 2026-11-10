import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createCoordinatorService } from '../server/coordinator.js';

const server = createServer();
const webSockets = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const coordinator = createCoordinatorService({ requireRedis: true });

webSockets.on('connection', (socket, request) => coordinator.attach(socket, request));

export default server;
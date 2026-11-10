import assert from 'node:assert/strict';
import test from 'node:test';
import { getCoordinatorUrl } from '../js/coordinator-client.js';

test('coordinator URL stays on the current HTTP origin', () => {
  assert.equal(getCoordinatorUrl({ origin: 'http://localhost:8787', protocol: 'http:' }), 'ws://localhost:8787/api/ws');
});

test('coordinator URL uses same-origin secure WebSocket in deployment', () => {
  assert.equal(getCoordinatorUrl({ origin: 'https://ghostchat-example.vercel.app', protocol: 'https:' }), 'wss://ghostchat-example.vercel.app/api/ws');
});
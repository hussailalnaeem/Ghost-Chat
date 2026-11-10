import { createClient } from 'redis';

export default async function health(_request, response) {
  if (!process.env.REDIS_URL) {
    response.statusCode = 503;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(JSON.stringify({ status: 'unconfigured', coordinator: false, reporting: false }));
    return;
  }

  const client = createClient({
    url: process.env.REDIS_URL,
    socket: { connectTimeout: 2500, reconnectStrategy: false },
  });
  client.on('error', () => {});
  let healthy = false;
  try {
    await client.connect();
    healthy = (await client.ping()) === 'PONG';
  } catch {
    healthy = false;
  } finally {
    if (client.isOpen) await client.quit().catch(() => {});
  }
  response.statusCode = healthy ? 200 : 503;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify({
    status: healthy ? 'ready' : 'unavailable',
    coordinator: healthy,
    reporting: healthy && Boolean(process.env.REPORT_ADMIN_TOKEN),
  }));
}
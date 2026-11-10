import crypto from 'node:crypto';
import { createClient } from 'redis';

const PREFIX = 'ghost:{coord}';

function authorized(request, configuredToken) {
  const supplied = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expectedBuffer = Buffer.from(configuredToken);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length > 0
    && expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export default async function reports(request, response) {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  const token = process.env.REPORT_ADMIN_TOKEN || '';
  if (!token || !process.env.REDIS_URL) {
    response.statusCode = 503;
    response.end(JSON.stringify({ error: 'Reporting is not configured.' }));
    return;
  }
  if (!authorized(request, token)) {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: 'Unauthorized.' }));
    return;
  }
  if (request.method !== 'GET' && request.method !== 'DELETE') {
    response.setHeader('allow', 'GET, DELETE');
    response.statusCode = 405;
    response.end(JSON.stringify({ error: 'Method not allowed.' }));
    return;
  }

  const client = createClient({
    url: process.env.REDIS_URL,
    socket: { connectTimeout: 2500, reconnectStrategy: false },
  });
  client.on('error', () => {});
  try {
    await client.connect();
    if (request.method === 'GET') {
      const ids = await client.zRange(`${PREFIX}:reports`, 0, 99, { REV: true });
      const values = ids.length ? await client.mGet(ids.map((id) => `${PREFIX}:report:${id}`)) : [];
      const records = [];
      for (let index = 0; index < ids.length; index += 1) {
        if (values[index]) records.push(JSON.parse(values[index]));
        else await client.zRem(`${PREFIX}:reports`, ids[index]);
      }
      response.statusCode = 200;
      response.end(JSON.stringify({ reports: records }));
      return;
    }

    const url = new URL(request.url || '/', 'https://vercel.invalid');
    const id = url.searchParams.get('id') || '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: 'A valid report ID is required.' }));
      return;
    }
    const deleted = await client.del(`${PREFIX}:report:${id}`);
    await client.zRem(`${PREFIX}:reports`, id);
    response.statusCode = deleted ? 200 : 404;
    response.end(JSON.stringify({ deleted: deleted > 0 }));
  } catch {
    response.statusCode = 503;
    response.end(JSON.stringify({ error: 'Reporting storage is unavailable.' }));
  } finally {
    if (client.isOpen) await client.quit().catch(() => {});
  }
}
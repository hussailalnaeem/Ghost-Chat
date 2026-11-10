const coordinator = new URL('/api/ws', window.location.origin);
coordinator.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

const policy = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${coordinator.origin} wss://0.peerjs.com https://0.peerjs.com stun:`,
  "img-src 'self' data:",
].join('; ');

const contentSecurityPolicy = document.createElement('meta');
contentSecurityPolicy.httpEquiv = 'Content-Security-Policy';
contentSecurityPolicy.content = policy;
document.head.append(contentSecurityPolicy);
export function recordTiming(name, details = {}) {
  const at = performance.now();
  const entry = { name, at, ...details };
  if (typeof window !== 'undefined') {
    window.__GHOSTCHAT_TIMINGS ||= [];
    window.__GHOSTCHAT_TIMINGS.push(entry);
    window.dispatchEvent(new CustomEvent('ghostchat:timing', { detail: entry }));
  }
  performance.mark(`ghostchat:${name}`, { detail: entry });
  return entry;
}
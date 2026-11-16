import fs from 'fs/promises';
import http from 'http';

/** Native hook helper. Relay failure returns a documented deny/terminate decision
 * with exit zero; native command failure itself is fail-open. No remote endpoint. */
export async function relayHook(file: string, event: string, payload: string): Promise<object> {
  const fallback = event === 'PreInvocation' ? { terminationBehavior: 'terminate' }
    : event === 'PreToolUse' ? { decision: 'deny', reason: 'Native schedule relay unavailable.' } : {};
  try {
    if (Buffer.byteLength(payload) > 256 * 1024 || (await fs.stat(file)).size > 4096) return fallback;
    const descriptor = JSON.parse(await fs.readFile(file, 'utf8'));
    const url = new URL(descriptor.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/hook'
      || url.username || url.password || !/^[a-f0-9]{64}$/.test(descriptor.token)) return fallback;
    const data = JSON.stringify({ event, payload: JSON.parse(payload) });
    return await new Promise<object>(resolve => {
      const request = http.request(url, { method: 'POST', headers: {
        Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
      } }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; if (text.length > 4096) request.destroy(); });
        response.on('error', () => resolve(fallback));
        response.on('end', () => {
          try { resolve(response.statusCode === 200 ? JSON.parse(text) : fallback); }
          catch { resolve(fallback); }
        });
      });
      const timer = setTimeout(() => request.destroy(), 5000);
      request.on('error', () => resolve(fallback)); request.on('close', () => clearTimeout(timer));
      request.end(data);
    });
  } catch { return fallback; }
}

if (require.main === module) {
  let input = ''; let overflow = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { if (Buffer.byteLength(input) + Buffer.byteLength(chunk) <= 256 * 1024) input += chunk; else overflow = true; });
  process.stdin.on('end', () => {
    void relayHook(process.argv[2], process.argv[3], overflow ? '' : input).then(result => process.stdout.write(JSON.stringify(result)));
  });
}

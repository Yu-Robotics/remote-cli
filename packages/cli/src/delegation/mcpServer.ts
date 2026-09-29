/** Standalone stdio MCP adapter. Credentials are supplied by the parent process. */
import { randomUUID } from 'crypto';
import { StringDecoder } from 'string_decoder';
import { DELEGATION_TOOLS } from './contract';

const prefix = randomUUID();
const url = process.env.REMOTE_CLI_DELEGATION_URL;
const token = process.env.REMOTE_CLI_DELEGATION_TOKEN;
const controllers = new Map<string | number, AbortController>();
let buffer = '';
const decoder = new StringDecoder('utf8');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reply(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

async function handle(message: unknown): Promise<void> {
  if (!isRecord(message) || typeof message.method !== 'string') return;
  const { id, method, params } = message;
  if (method === 'notifications/cancelled') {
    const requestId = isRecord(params) ? params.requestId : undefined;
    if (typeof requestId === 'string' || typeof requestId === 'number') controllers.get(requestId)?.abort();
    return;
  }
  if (typeof id !== 'string' && typeof id !== 'number') return;
  if (method === 'initialize') {
    const version = isRecord(params) && typeof params.protocolVersion === 'string'
      ? params.protocolVersion : '2024-11-05';
    reply(id, { protocolVersion: version, capabilities: { tools: {} },
      serverInfo: { name: 'remote-cli-delegation', version: '1.0.0' } });
  } else if (method === 'tools/list') {
    reply(id, { tools: DELEGATION_TOOLS });
  } else if (method === 'tools/call') {
    const controller = new AbortController();
    controllers.set(id, controller);
    const timer = setTimeout(() => controller.abort(), 32_000);
    try {
      if (!url || !token) throw new Error('Delegation connection is unavailable');
      const argumentsValue = isRecord(params) && isRecord(params.arguments) ? params.arguments : {};
      const response = await fetch(url, { method: 'POST', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: isRecord(params) ? params.name : undefined,
          args: argumentsValue, callId: `${prefix}:${id}` }) });
      const result = await response.json();
      reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !response.ok });
    } catch (error) {
      reply(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Delegation failed' }], isError: true });
    } finally { clearTimeout(timer); controllers.delete(id); }
  } else if (method === 'ping') reply(id, {});
  else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method' } }) + '\n');
}

process.stdin.on('data', (chunk: Buffer) => {
  buffer += decoder.write(chunk);
  if (Buffer.byteLength(buffer) > 256 * 1024) { process.exitCode = 1; process.stdin.destroy(); return; }
  let newline: number;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    try { void handle(JSON.parse(line)).catch(() => undefined); } catch { /* Ignore malformed JSON-RPC frames. */ }
  }
});
process.stdin.on('end', () => { for (const controller of controllers.values()) controller.abort(); });

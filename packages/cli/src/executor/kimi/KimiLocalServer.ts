import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { stripAnsi } from '../../utils/stripAnsi';

const OUTPUT_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const unconfirmedExits = new Map<string, Promise<void>>();
const endpoints = {
  usage: { path: '/api/v1/oauth/usage?provider=managed%3Akimi-code', method: 'GET' },
  refreshOAuth: { path: '/api/v1/providers:refresh_oauth', method: 'POST' },
  models: { path: '/api/v1/models', method: 'GET' },
} as const;

export interface KimiLocalServerDependencies {
  spawnProcess?: typeof spawn;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  killGraceMs?: number;
}

export class KimiMetadataError extends Error {}

export function kimiHomeKey(command: string): string {
  const home = path.resolve(process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'));
  return JSON.stringify([command, home]);
}

function unavailable(): KimiMetadataError {
  return new KimiMetadataError('This Kimi installation does not provide the local metadata API. Upgrade Kimi Code and retry.');
}

async function readJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_LIMIT)) {
    void response.body?.cancel().catch(() => {});
    throw new KimiMetadataError('Kimi returned an oversized metadata response.');
  }
  if (!response.body) throw new KimiMetadataError('Kimi returned an empty metadata response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) throw new KimiMetadataError('Kimi returned an oversized metadata response.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new KimiMetadataError('Kimi returned invalid metadata JSON.'); }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Own one authenticated loopback server, including abort and confirmed exit. */
export async function withKimiLocalServer<T>(command: string, cwd: string,
  query: (request: (endpoint: keyof typeof endpoints) => Promise<unknown>) => Promise<T>,
  dependencies: KimiLocalServerDependencies = {}): Promise<T> {
  const key = kimiHomeKey(command);
  if (unconfirmedExits.has(key)) {
    throw new KimiMetadataError('A previous Kimi metadata server has not exited. Retry after its exit is confirmed.');
  }
  const controller = new AbortController();
  let announce!: (value: { origin: string; token: string }) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<{ origin: string; token: string }>((resolve, reject) => { announce = resolve; rejectReady = reject; });
  let markClosed!: () => void;
  const closed = new Promise<void>(resolve => { markClosed = resolve; });
  let exited = false;
  let spawned = false;
  let announced = false;
  let outputBytes = 0;
  let startup = '';
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  let child: ReturnType<typeof spawn>;
  try {
    child = (dependencies.spawnProcess ?? spawn)(command,
      ['web', '--no-open', '--host', '127.0.0.1', '--port', '0', '--log-level', 'silent'], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: 'false', KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '0' },
      });
  } catch { throw unavailable(); }
  const onOutput = (chunk: Buffer, stdout: boolean) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > OUTPUT_LIMIT) {
      rejectFailure(new KimiMetadataError('Kimi metadata startup output exceeded its limit.'));
      return;
    }
    if (announced || !stdout || controller.signal.aborted) return;
    startup += stripAnsi(chunk.toString());
    const match = /(?:^|\n)\s*Local:\s+(http:\/\/127\.0\.0\.1:(\d{1,5}))\/#token=([A-Za-z0-9._~-]{1,512})[ \t]*\r?\n/.exec(startup);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return;
    announced = true;
    startup = '';
    announce({ origin: match[1], token: match[3] });
  };
  child.stdout?.on('data', chunk => onOutput(chunk, true));
  child.stderr?.on('data', chunk => onOutput(chunk, false));
  child.once('spawn', () => { spawned = true; });
  child.once('error', () => {
    if (!spawned && child.pid === undefined) { exited = true; markClosed(); }
    rejectFailure(unavailable());
  });
  child.once('close', () => {
    exited = true;
    markClosed();
    rejectFailure(unavailable());
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new KimiMetadataError('Kimi model metadata request timed out. Check connectivity and retry.')),
      dependencies.timeoutMs ?? 5_000);
    timer.unref?.();
  });
  const operation = (async () => {
    const { origin, token } = await ready;
    const request = async (endpoint: keyof typeof endpoints): Promise<unknown> => {
      if (controller.signal.aborted) throw new KimiMetadataError('Kimi metadata request was cancelled.');
      const route = endpoints[endpoint];
      if (!route) throw new KimiMetadataError('Unsupported Kimi metadata endpoint.');
      const response = await (dependencies.fetchImpl ?? fetch)(`${origin}${route.path}`, {
        method: route.method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (controller.signal.aborted) throw new KimiMetadataError('Kimi metadata request was cancelled.');
      if ([404, 405, 501].includes(response.status)) throw unavailable();
      if (!response.ok || response.redirected) throw new KimiMetadataError('Kimi metadata request failed. Check account access and connectivity, then retry.');
      return readJson(response);
    };
    return query(request);
  })();
  try {
    return await Promise.race([operation, failure, timeout]);
  } catch (error) {
    throw error instanceof KimiMetadataError ? error
      : new KimiMetadataError('Kimi metadata request failed. Check account access and connectivity, then retry.');
  } finally {
    clearTimeout(timer);
    controller.abort();
    rejectReady(new KimiMetadataError('Kimi metadata request was cancelled.'));
    startup = '';
    const wait = async () => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closed, new Promise<void>(resolve => { grace = setTimeout(resolve, dependencies.killGraceMs ?? 500); })]); }
      finally { clearTimeout(grace); }
    };
    const signal = (value: NodeJS.Signals) => { try { child.kill(value); } catch { /* Exit must still be confirmed below. */ } };
    if (!exited) { signal('SIGTERM'); await wait(); }
    if (!exited) { signal('SIGKILL'); await wait(); }
    if (!exited) {
      unconfirmedExits.set(key, closed);
      void closed.then(() => { if (unconfirmedExits.get(key) === closed) unconfirmedExits.delete(key); });
      throw new KimiMetadataError('Kimi metadata server exit could not be confirmed. Further attempts are blocked until it exits.');
    }
  }
}

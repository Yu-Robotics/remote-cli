import * as fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import { MAX_TRANSCRIPT, parseTranscript, type TranscriptRecord } from './transcript';
import { openOutputFile } from '../../output/OutputSnapshots';
import type { HookDecision, HookPayload } from './AgySessionSchedules';

export const AGY_HOOK_EVENTS = ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop'] as const;
const MAX_BODY = 256 * 1024;
const GROUP = 'remote-cli-native-schedule';

/** Event-triggered, authenticated loopback IO. This is not a filesystem watcher
 * or a scheduler. Never reads a locator outside the exact bound native session. */
export class AgyHookRelay {
  private readonly token = randomBytes(32).toString('hex');
  private readonly server = http.createServer((request, response) => { void this.receive(request, response); });
  private session?: string;
  private chain: Promise<unknown> = Promise.resolve();
  private root = '';
  private closed = false;
  constructor(private readonly home: string,
    private readonly accept: (event: string, payload: HookPayload, records: TranscriptRecord[]) => HookDecision,
    private readonly fault: () => void) {
    this.server.requestTimeout = 5000; this.server.headersTimeout = 5000;
    this.server.maxConnections = 16;
  }
  async start(): Promise<{ url: string; token: string }> {
    this.root = await fs.realpath(this.home);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('AGY hook listener unavailable.');
    return { url: `http://127.0.0.1:${address.port}/hook`, token: this.token };
  }
  bindSession(session: string): void {
    if (this.session || !/^[a-zA-Z0-9_-]{1,128}$/.test(session)) throw new Error('AGY relay session cannot be rebound.');
    this.session = session;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    await this.chain;
  }
  private async receive(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const authorization = request.headers.authorization ?? '';
    const expected = `Bearer ${this.token}`;
    if (this.closed || request.method !== 'POST' || request.url !== '/hook' || Buffer.byteLength(authorization) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) { response.writeHead(403).end(); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) { response.writeHead(413).end(); request.destroy(); this.fault(); return; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!AGY_HOOK_EVENTS.includes(body.event) || !body.payload || typeof body.payload !== 'object'
        || !this.session || body.payload.conversationId !== this.session) throw new Error('Invalid AGY hook envelope.');
      const next = this.chain.then(async () => {
        const records = await this.read(body.payload.transcriptPath, body.event);
        return this.accept(body.event, body.payload, records);
      });
      this.chain = next.catch(() => {});
      const result = await next;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch {
      this.fault(); response.writeHead(409).end();
    }
  }
  private async read(locator: unknown, event: string): Promise<TranscriptRecord[]> {
    const expected = path.join(this.root, '.gemini', 'antigravity-cli', 'brain', this.session!, '.system_generated', 'logs', 'transcript_full.jsonl');
    if (typeof locator !== 'string' || path.resolve(locator) !== expected) throw new Error('AGY transcript locator mismatch.');
    // Check every component, not just the basename. Refuse shared/redirected brain
    // paths even if the caller supplied a plausible conversation name.
    let current = this.root;
    for (const part of path.relative(this.root, expected).split(path.sep)) {
      current = path.join(current, part);
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('AGY transcript symlink is not allowed.'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && event === 'SessionStart') return [];
        throw error;
      }
    }
    if (await fs.realpath(expected) !== expected) throw new Error('AGY transcript is not canonical.');
    // Reuse the existing portable handle-relative no-follow reader, including
    // ancestor revalidation and native size/mtime checks. No path-read fallback
    // when the platform helper is missing. A replaced directory cannot redirect
    // the read after the locator check above.
    const file = openOutputFile(expected, () => !this.closed);
    try {
      if (file.size > MAX_TRANSCRIPT) throw new Error('AGY transcript size unsupported.');
      const chunks: Buffer[] = [];
      for await (const chunk of file.chunks()) chunks.push(chunk);
      return parseTranscript(Buffer.concat(chunks).toString('utf8'));
    } finally { file.close(); }
  }
}

/** Overlay the documented per-HOME hook group, preserving user groups. Refuse a
 * shared configuration directory: the existing executor must detach its HOME
 * links before enabling ACP. Never silently modify the user's global config. */
export async function installAgyScheduleHooks(home: string, descriptor: { url: string; token: string }): Promise<() => Promise<void>> {
  const root = await fs.realpath(home);
  const config = path.join(root, '.gemini', 'config');
  // Detach only this private HOME's link; never write through global config.
  let directoryLink: string | undefined;
  try {
    if ((await fs.lstat(config)).isSymbolicLink()) {
      directoryLink = await fs.readlink(config);
      const source = await fs.realpath(config);
      await fs.unlink(config); await fs.mkdir(config, { mode: 0o700 });
      for (const entry of await fs.readdir(source)) await fs.symlink(path.join(source, entry), path.join(config, entry));
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await fs.mkdir(config, { recursive: true, mode: 0o700 });
  if (await fs.realpath(config) !== config) throw new Error('AGY hooks require a private canonical per-thread configuration directory.');
  const target = path.join(config, 'hooks.json');
  let original: string | undefined;
  let originalLink: string | undefined;
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) originalLink = await fs.readlink(target);
    if ((await fs.stat(target)).size > MAX_BODY) throw new Error('AGY hook configuration is too large.');
    original = await fs.readFile(target, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const groups = original === undefined ? {} : JSON.parse(original);
  if (!groups || typeof groups !== 'object' || Array.isArray(groups) || Object.hasOwn(groups, GROUP)) throw new Error('AGY hook overlay is already owned or unsupported.');
  const privateDir = await fs.mkdtemp(path.join(root, '.remote-cli-agy-hooks-'));
  await fs.chmod(privateDir, 0o700);
  const endpointFile = path.join(privateDir, 'relay.json');
  await fs.writeFile(endpointFile, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
  const helper = path.join(__dirname, 'hookClient.js');
  // Native hooks execute a shell command. Restrict metacharacters on both shells;
  // do not interpolate endpoint credentials or model-controlled arguments.
  const quote = (value: string) => {
    if (/[\r\n"`$%!]/.test(value)) throw new Error('AGY hook executable path cannot be safely quoted.');
    return `"${value}"`;
  };
  let installed: string;
  try {
    const group: Record<string, unknown> = { enabled: true };
    for (const event of AGY_HOOK_EVENTS) {
      const handler = { type: 'command', command: [process.execPath, helper, endpointFile, event].map(quote).join(' '), timeout: 10 };
      group[event] = event === 'PreToolUse' || event === 'PostToolUse' ? [{ matcher: '.*', hooks: [handler] }] : [handler];
    }
    installed = JSON.stringify({ ...groups, [GROUP]: group }, null, 2) + '\n';
    const temp = path.join(config, `.hooks-${randomBytes(8).toString('hex')}.tmp`);
    try {
      await fs.writeFile(temp, installed, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, target);
    } finally { await fs.rm(temp, { force: true }); }
  } catch (error) { await fs.rm(privateDir, { recursive: true, force: true }); throw error; }
  return async () => {
    // A concurrent user edit must never be overwritten by teardown.
    if (await fs.readFile(target, 'utf8') !== installed) throw new Error('AGY hooks changed; automatic overlay restoration refused.');
    if (originalLink) { await fs.unlink(target); await fs.symlink(originalLink, target); }
    else if (original === undefined) await fs.unlink(target);
    else await fs.writeFile(target, original, { mode: 0o600 });
    if (directoryLink) {
      const source = await fs.realpath(path.resolve(path.dirname(config), directoryLink));
      const entries = await fs.readdir(config);
      const unchanged = await Promise.all(entries.map(async name => {
        const file = path.join(config, name);
        return (await fs.lstat(file)).isSymbolicLink() && await fs.readlink(file) === path.join(source, name);
      }));
      if (unchanged.every(Boolean)) {
        for (const name of entries) await fs.unlink(path.join(config, name));
        await fs.rmdir(config); await fs.symlink(directoryLink, config, 'dir');
      }
    }
    await fs.rm(privateDir, { recursive: true, force: true });
  };
}

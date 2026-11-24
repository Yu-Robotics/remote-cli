import * as fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { isDeepStrictEqual } from 'util';
import { randomBytes, timingSafeEqual } from 'crypto';
import { MAX_TRANSCRIPT, parseTranscript, type TranscriptRecord } from './transcript';
import { openOutputFile } from '../../output/OutputSnapshots';
import { ownAgyHooks, type AgyHookLease } from './AgyHookOwnership';
import type { HookDecision, HookPayload } from './AgySessionSchedules';

export const AGY_HOOK_EVENTS = ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop'] as const;
const MAX_BODY = 256 * 1024;

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
  readCheckpointTranscript(): Promise<TranscriptRecord[]> {
    return this.read(this.transcriptPath(), 'Stop');
  }
  /** After group exit, confirm the native transcript still matches the last authenticated hook. */
  async confirmsTerminal(records: TranscriptRecord[]): Promise<boolean> {
    await this.chain;
    try {
      return records.length > 0 && isDeepStrictEqual(await this.read(this.transcriptPath(), 'Stop'), records);
    } catch { return false; }
  }
  private transcriptPath(): string {
    return path.join(this.root, '.gemini', 'antigravity-cli', 'brain', this.session!, '.system_generated', 'logs', 'transcript_full.jsonl');
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
    const expected = this.transcriptPath();
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

/** Install one durably owned per-HOME overlay; never overwrite an unknown owner. */
export async function installAgyScheduleHooks(home: string, descriptor: { url: string; token: string }): Promise<AgyHookLease> {
  return ownAgyHooks(home, privateDir => {
    const endpointFile = path.join(privateDir, 'relay.json');
    // The descriptor belongs only to this overlay and contains no user credential.
    require('fs').writeFileSync(endpointFile, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
    const helper = path.join(__dirname, 'hookClient.js');
    const quote = (value: string) => {
      if (/[\r\n"`$%!]/.test(value)) throw new Error('AGY hook executable path cannot be safely quoted.');
      return `"${value}"`;
    };
    const group: Record<string, unknown> = { enabled: true };
    for (const event of AGY_HOOK_EVENTS) {
      const handler = { type: 'command', command: [process.execPath, helper, endpointFile, event].map(quote).join(' '), timeout: 10 };
      group[event] = event === 'PreToolUse' || event === 'PostToolUse' ? [{ matcher: '.*', hooks: [handler] }] : [handler];
    }
    return group;
  });
}

import { ChildProcess, spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';

export interface CodexAppServerClientOptions {
  command?: string;
  cwd?: string;
  requestTimeoutMs?: number;
  killEscalationMs?: number;
}

export interface AppServerMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: any };
}

type MessageHandler = (message: AppServerMessage) => void;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_ESCALATION_MS = 3_000;
const STDERR_TAIL_LIMIT = 4_000;

/**
 * Minimal stdio JSON-RPC client for `codex app-server`.
 *
 * The protocol intentionally has no `jsonrpc` field. Each payload is encoded
 * as one JSON object per line. Unknown notifications are forwarded to callers
 * so newer Codex versions remain additive instead of breaking the transport.
 */
export class CodexAppServerClient {
  private readonly command: string;
  private cwd?: string;
  private readonly requestTimeoutMs: number;
  private readonly killEscalationMs: number;
  private proc: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private handlers = new Set<MessageHandler>();
  private decoder = new StringDecoder('utf8');
  private stdoutBuffer = '';
  private stderrTail = '';
  private stopping = false;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.command = options.command ?? 'codex';
    this.cwd = options.cwd;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.killEscalationMs = options.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;
  }

  setWorkingDirectory(cwd: string): void {
    this.cwd = cwd;
  }

  isRunning(): boolean {
    return this.proc !== null;
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.proc) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(): Promise<void> {
    this.stopping = false;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.decoder = new StringDecoder('utf8');

    let proc: ChildProcess;
    try {
      proc = spawn(this.command, ['app-server', '--stdio'], {
        cwd: this.cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw this.friendlySpawnError(error);
    }

    this.proc = proc;
    proc.stdout?.on('data', (data: Buffer) => this.handleStdout(proc, data));
    proc.stderr?.on('data', (data: Buffer) => {
      if (proc !== this.proc) return;
      this.stderrTail = (this.stderrTail + data.toString()).slice(-STDERR_TAIL_LIMIT);
    });
    proc.stdin?.on('error', (error: Error) => {
      if (proc === this.proc && !this.stopping) {
        this.failAll(new Error(`Codex app-server stdin error: ${error.message}`));
      }
    });
    proc.on('error', (error) => {
      if (proc !== this.proc) return;
      this.proc = null;
      this.failAll(this.friendlySpawnError(error));
    });
    proc.on('close', (code, signal) => {
      if (proc !== this.proc) return;
      this.stdoutBuffer += this.decoder.end();
      if (this.stdoutBuffer.trim()) this.handleLine(this.stdoutBuffer);
      this.stdoutBuffer = '';
      this.proc = null;
      if (!this.stopping) {
        const tail = this.stderrTail.trim().slice(-500);
        this.failAll(new Error(
          `Codex app-server exited unexpectedly (${code ?? signal ?? 'unknown'})${tail ? `: ${tail}` : ''}`
        ));
      }
    });

    try {
      await this.requestRaw('initialize', {
        clientInfo: {
          name: 'remote_cli',
          title: 'Remote CLI',
          version: this.getClientVersion(),
        },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async request(method: string, params?: any, timeoutMs = this.requestTimeoutMs): Promise<any> {
    await this.start();
    return this.requestRaw(method, params, timeoutMs);
  }

  notify(method: string, params?: any): void {
    const message: AppServerMessage = { method };
    if (params !== undefined) message.params = params;
    this.write(message);
  }

  respond(id: number | string, result: any): void {
    this.write({ id, result });
  }

  respondError(id: number | string, message: string, code = -32601): void {
    this.write({ id, error: { code, message } });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.startPromise = null;
    this.stopping = true;
    this.proc = null;
    this.failAll(new Error('Codex app-server stopped'));
    if (!proc) return;

    try {
      proc.stdin?.end();
    } catch {
      // The stream may already be closed.
    }

    let exited = false;
    proc.once('exit', () => { exited = true; });
    proc.kill();
    const escalation = setTimeout(() => {
      if (!exited) proc.kill('SIGKILL');
    }, this.killEscalationMs);
    if (typeof escalation.unref === 'function') escalation.unref();
  }

  private requestRaw(method: string, params?: any, timeoutMs = this.requestTimeoutMs): Promise<any> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const message: AppServerMessage = { id, method };
        if (params !== undefined) message.params = params;
        this.write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: AppServerMessage): void {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error('Codex app-server is not running');
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(proc: ChildProcess, data: Buffer): void {
    if (proc !== this.proc) return;
    this.stdoutBuffer += this.decoder.write(data);
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: AppServerMessage;
    try {
      message = JSON.parse(line) as AppServerMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? 'Codex app-server request failed');
        Object.assign(error, { code: message.error.code, data: message.error.data });
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    for (const handler of this.handlers) {
      try {
        handler(message);
      } catch (error) {
        console.error('[CodexAppServerClient] Message handler failed:', error);
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const handler of this.handlers) {
      try {
        handler({ method: 'client/disconnected', params: { error: error.message } });
      } catch {
        // A disconnect must continue notifying the remaining handlers.
      }
    }
  }

  private friendlySpawnError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ENOENT')) {
      return new Error('Codex CLI (codex) is not installed or not found on PATH. Install it with `npm i -g @openai/codex`, or use /backend to switch to another backend.');
    }
    return new Error(`Failed to start Codex app-server: ${message}`);
  }

  private getClientVersion(): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('../../package.json').version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

import { ChildProcess, spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { buildPiRpcArgs, consumeJsonl, type PiLaunchOptions, type PiRpcResponse, type PiTransport } from './PiTypes';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_ESCALATION_MS = 3_000;
const STDERR_TAIL_LIMIT = 4_000;

interface PendingRequest {
  resolve: (value: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PiClientOptions extends PiLaunchOptions {
  requestTimeoutMs?: number;
  killEscalationMs?: number;
}

/**
 * Persistent stdin/stdout JSONL client for `pi --mode rpc`.
 * Framing follows pi's RPC contract: split on LF only, never Node readline.
 */
export class PiClient implements PiTransport {
  private options: PiLaunchOptions;
  private readonly requestTimeoutMs: number;
  private readonly killEscalationMs: number;
  private proc: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private pending = new Map<string, PendingRequest>();
  private handlers = new Set<(event: Record<string, any>) => void>();
  private decoder = new StringDecoder('utf8');
  private stdoutBuffer = '';
  private stderrTail = '';
  private stopping = false;

  constructor(options: PiClientOptions = {}) {
    const { requestTimeoutMs, killEscalationMs, ...launch } = options;
    this.options = launch;
    this.requestTimeoutMs = requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.killEscalationMs = killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;
  }

  updateLaunch(partial: Partial<PiLaunchOptions>): void {
    this.options = { ...this.options, ...partial };
  }

  isRunning(): boolean {
    return this.proc !== null;
  }

  onEvent(handler: (event: Record<string, any>) => void): () => void {
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

  async request(command: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<PiRpcResponse> {
    await this.start();
    const id = typeof command.id === 'string' ? command.id : `req-${this.nextRequestId++}`;
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC request timed out: ${String(command.type)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  send(message: Record<string, unknown>): void {
    this.write(message);
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.startPromise = null;
    this.stopping = true;
    this.proc = null;
    this.failAll(new Error('Pi RPC process stopped'));
    if (!proc) return;

    try {
      proc.stdin?.end();
    } catch {
      // The stream may already be closed.
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(escalation);
        clearTimeout(giveUp);
        resolve();
      };

      proc.once('exit', finish);

      const escalation = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { finish(); }
      }, this.killEscalationMs);
      if (typeof escalation.unref === 'function') escalation.unref();

      const giveUp = setTimeout(finish, this.killEscalationMs + 1_000);
      if (typeof giveUp.unref === 'function') giveUp.unref();

      if (proc.exitCode !== null || proc.signalCode !== null) {
        finish();
        return;
      }

      try {
        proc.kill();
      } catch {
        finish();
      }
    });
  }

  private async startInternal(): Promise<void> {
    this.stopping = false;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.decoder = new StringDecoder('utf8');

    const { command, args } = buildPiRpcArgs(this.options);
    let proc: ChildProcess;
    try {
      proc = spawn(command, args, {
        cwd: this.options.cwd,
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
        this.failAll(new Error(`Pi RPC stdin error: ${error.message}`));
      }
    });
    proc.on('error', (error) => {
      if (proc !== this.proc) return;
      this.proc = null;
      this.failAll(this.friendlySpawnError(error));
    });
    proc.on('close', (code, signal) => {
      if (proc !== this.proc) return;
      const leftover = this.decoder.end();
      if (leftover) this.stdoutBuffer += leftover;
      if (this.stdoutBuffer.length > 0) this.handleLine(this.stdoutBuffer.endsWith('\r') ? this.stdoutBuffer.slice(0, -1) : this.stdoutBuffer);
      this.stdoutBuffer = '';
      this.proc = null;
      if (!this.stopping) {
        const tail = this.stderrTail.trim().slice(-500);
        this.failAll(new Error(
          `Pi RPC process exited unexpectedly (${code ?? signal ?? 'unknown'})${tail ? `: ${tail}` : ''}`
        ));
      }
    });
  }

  private write(message: Record<string, unknown>): void {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error('Pi RPC process is not running');
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(proc: ChildProcess, data: Buffer): void {
    if (proc !== this.proc) return;
    this.stdoutBuffer += this.decoder.write(data);
    const { lines, rest } = consumeJsonl(this.stdoutBuffer);
    this.stdoutBuffer = rest;
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    let message: Record<string, any>;
    try {
      message = JSON.parse(line) as Record<string, any>;
    } catch {
      return;
    }

    if (message.type === 'response') {
      const id = typeof message.id === 'string' ? message.id : undefined;
      const pending = id ? this.pending.get(id) : undefined;
      if (pending) {
        this.pending.delete(id!);
        clearTimeout(pending.timer);
        pending.resolve(message as PiRpcResponse);
        return;
      }
    }

    this.emit(message);
  }

  private emit(event: Record<string, any>): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('[PiClient] Event handler failed:', error);
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit({ type: 'client_disconnected', error: error.message });
  }

  private friendlySpawnError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ENOENT')) {
      return new Error('Pi CLI (pi) is not installed or not found on PATH. Install it with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, or use /backend to switch to another backend.');
    }
    return new Error(`Failed to start Pi RPC: ${message}`);
  }
}

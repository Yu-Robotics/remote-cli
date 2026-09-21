import { ChildProcess, spawn } from 'child_process';
import * as readline from 'readline';
import type {
  AcpConfigOption,
  AcpContentBlock,
  AcpJsonRpcErrorResponse,
  AcpJsonRpcNotification,
  AcpJsonRpcRequest,
  AcpJsonRpcResponse,
  AcpJsonRpcSuccessResponse,
  AcpPermissionOption,
  AcpSessionResult,
} from './AcpTypes';

const SIGKILL_GRACE_MS = 3_000;

export interface AcpToolCallUpdate {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  content?: Array<Record<string, unknown>>;
  rawOutput?: unknown;
}

export interface AcpEventCallbacks {
  onTextChunk?: (content: AcpContentBlock) => void;
  onThoughtChunk?: (content: AcpContentBlock) => void;
  onToolCall?: (toolCall: AcpToolCallUpdate) => void;
  onToolResult?: (toolCall: AcpToolCallUpdate) => void;
  onPlan?: (entries: Array<{ content: string; status?: string; priority?: string }>) => void;
  onConfigOptions?: (options: AcpConfigOption[]) => void;
  onUsage?: (update: Record<string, unknown>) => void;
  onPermissionRequest?: (title: string, options: AcpPermissionOption[]) => Promise<number>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export interface AcpTransport {
  initialize(): Promise<unknown>;
  newSession(cwd: string): Promise<AcpSessionResult>;
  loadSession(sessionId: string, cwd: string): Promise<AcpSessionResult>;
  prompt(sessionId: string, blocks: AcpContentBlock[]): Promise<{ stopReason: string }>;
  setConfigOption(sessionId: string, configId: string, value: string): Promise<AcpSessionResult>;
  compactSession?(sessionId: string): Promise<{ stopReason: string }>;
  deleteSession(sessionId: string): Promise<void>;
  sendCancel(sessionId: string): void;
  destroy(): void;
}

export class AcpClient implements AcpTransport {
  private readonly child: ChildProcess;
  private readonly callbacks: AcpEventCallbacks;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly rl: readline.Interface;
  private nextId = 1;
  private destroyed = false;
  private closed = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(command: string, args: string[], cwd: string, callbacks: AcpEventCallbacks) {
    this.callbacks = callbacks;
    this.child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.child.stdout!.on('error', () => {});
    this.child.stdin?.on('error', () => {});
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trimEnd();
      if (message && !message.includes('EPIPE') && !message.includes('write EPIPE')) {
        console.error(`[AcpClient stderr] ${message}`);
      }
    });

    this.rl = readline.createInterface({ input: this.child.stdout! });
    this.rl.on('line', (line) => this.handleLine(line));
    this.child.on('error', (error) => this.rejectAllPending(error));
    this.child.on('close', (code, signal) => {
      this.closed = true;
      this.clearKillTimer();
      if (!this.destroyed) {
        this.rejectAllPending(new Error(`ACP process exited: code=${code} signal=${signal}`));
      }
    });
  }

  initialize(): Promise<unknown> {
    return this.sendRequest('initialize', { protocolVersion: 1, clientCapabilities: {} });
  }

  async newSession(cwd: string): Promise<AcpSessionResult> {
    return this.sendRequest('session/new', { cwd, mcpServers: [] }) as Promise<AcpSessionResult>;
  }

  async loadSession(sessionId: string, cwd: string): Promise<AcpSessionResult> {
    return this.sendRequest('session/load', { sessionId, cwd, mcpServers: [] }) as Promise<AcpSessionResult>;
  }

  async prompt(sessionId: string, blocks: AcpContentBlock[]): Promise<{ stopReason: string }> {
    return this.sendRequest('session/prompt', { sessionId, prompt: blocks }) as Promise<{ stopReason: string }>;
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<AcpSessionResult> {
    return this.sendRequest('session/set_config_option', {
      sessionId,
      configId,
      value,
    }) as Promise<AcpSessionResult>;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.sendRequest('session/delete', { sessionId });
  }

  sendCancel(sessionId: string): void {
    this.sendNotification('session/cancel', { sessionId });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rejectAllPending(new Error('ACP client destroyed'));
    this.rl.close();
    try {
      this.child.stdin?.end();
    } catch {}
    if (!this.child.killed) {
      this.child.kill('SIGTERM');
      this.killTimer = setTimeout(() => {
        if (!this.closed) this.child.kill('SIGKILL');
      }, SIGKILL_GRACE_MS);
      this.killTimer.unref?.();
    }
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pendingRequests.set(id, { resolve, reject });
      this.writeLine({ jsonrpc: '2.0', id, method, params } satisfies AcpJsonRpcRequest);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    this.writeLine({ jsonrpc: '2.0', method, params } satisfies AcpJsonRpcNotification);
  }

  private sendResponse(id: number, result: unknown): void {
    this.writeLine({ jsonrpc: '2.0', id, result } satisfies AcpJsonRpcSuccessResponse);
  }

  private sendErrorResponse(id: number, code: number, message: string): void {
    this.writeLine({ jsonrpc: '2.0', id, error: { code, message } } satisfies AcpJsonRpcErrorResponse);
  }

  private writeLine(message: object): void {
    if (this.destroyed || !this.child.stdin) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {}
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.jsonrpc !== '2.0') return;
    const hasId = typeof message.id === 'number';
    const hasMethod = typeof message.method === 'string';
    if (hasId && hasMethod) {
      this.handleServerRequest(message as unknown as AcpJsonRpcRequest);
    } else if (hasId) {
      this.handleResponse(message as unknown as AcpJsonRpcResponse);
    } else if (hasMethod) {
      this.handleNotification(message as unknown as AcpJsonRpcNotification);
    }
  }

  private handleResponse(message: AcpJsonRpcResponse): void {
    if (this.destroyed) return;
    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;
    this.pendingRequests.delete(message.id);
    if ('error' in message) {
      const data = message.error.data === undefined ? '' : ` (${JSON.stringify(message.error.data)})`;
      pending.reject(new Error(`ACP error ${message.error.code}: ${message.error.message}${data}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleNotification(message: AcpJsonRpcNotification): void {
    if (message.method !== 'session/update') return;
    const params = message.params as { update?: Record<string, unknown> };
    const update = params.update;
    if (!update) return;
    const type = update.sessionUpdate;
    if (type === 'agent_message_chunk') {
      this.callbacks.onTextChunk?.(update.content as AcpContentBlock);
    } else if (type === 'agent_thought_chunk') {
      this.callbacks.onThoughtChunk?.(update.content as AcpContentBlock);
    } else if (type === 'tool_call') {
      this.callbacks.onToolCall?.(update as unknown as AcpToolCallUpdate);
    } else if (type === 'tool_call_update') {
      const tool = update as unknown as AcpToolCallUpdate;
      if (tool.status === 'completed' || tool.status === 'failed') this.callbacks.onToolResult?.(tool);
      else if (tool.rawInput !== undefined || tool.title !== undefined || tool.kind !== undefined) {
        this.callbacks.onToolCall?.(tool);
      }
    } else if (type === 'plan') {
      this.callbacks.onPlan?.((update.entries ?? []) as Array<{ content: string; status?: string; priority?: string }>);
    } else if (type === 'config_options_update' || type === 'config_option_update') {
      this.callbacks.onConfigOptions?.((update.configOptions ?? []) as AcpConfigOption[]);
    } else if (type === 'usage_update') {
      this.callbacks.onUsage?.(update);
    }
  }

  private handleServerRequest(message: AcpJsonRpcRequest): void {
    if (message.method !== 'session/request_permission') {
      this.sendErrorResponse(message.id, -32601, 'Method not found');
      return;
    }
    void this.handlePermissionRequest(message.id, message.params as {
      toolCall?: { title?: string };
      options?: AcpPermissionOption[];
    });
  }

  private async handlePermissionRequest(
    id: number,
    params: { toolCall?: { title?: string }; options?: AcpPermissionOption[] }
  ): Promise<void> {
    const options = params.options ?? [];
    if (options.length === 0) {
      this.sendResponse(id, { outcome: 'cancelled' });
      return;
    }
    let index = 0;
    if (this.callbacks.onPermissionRequest) {
      try {
        index = await this.callbacks.onPermissionRequest(params.toolCall?.title ?? 'Tool request', options);
      } catch {
        index = 0;
      }
    }
    if (index < 0) {
      this.sendResponse(id, { outcome: 'cancelled' });
      return;
    }
    const selected = options[index] ?? options[0];
    if (selected.kind.startsWith('reject')) {
      this.sendResponse(id, { outcome: 'cancelled' });
    } else {
      this.sendResponse(id, { outcome: 'selected', optionId: selected.optionId });
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
  }

  private clearKillTimer(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
  }
}

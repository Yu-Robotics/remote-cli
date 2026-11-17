import { spawnManaged } from '../ManagedSpawn';
import { ownedSpawn as spawn } from '../../delegation/OwnershipRuntime';
import { ChildProcess } from 'child_process';
import * as readline from 'readline';
import { assertWorkingDirectoryExists } from '../../utils/WorkingDirectory';
import { ManagedProcessGroups } from '../ManagedProcessGroups';
import type {
  AcpMcpServer,
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
const CONTROL_REQUEST_TIMEOUT_MS = 10_000;

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
  timer?: ReturnType<typeof setTimeout>;
}

/** Initial controls run before original-session admission. The setter is scoped
 * to this allocation/load and expires when setup finishes or ownership changes. */
export type AcpSessionSetup = (session: AcpSessionResult,
  configure: (configId: string, value: string) => Promise<AcpSessionResult>) => Promise<void>;

export interface AcpTransport {
  /** Process-local original-session admission identity. Never a resume or recovery
   * receipt. Revoked before load/configuration/cancel/delete, including failures. */
  sessionAdmission?(sessionId: string): object | undefined;
  /** Allocation/load and admission-revoking controls change this local epoch. */
  sessionLifecycle?(): object | undefined;
  createNativeSchedule?(sessionId: string, input: import('../../scheduling/types').NativeScheduleInput,
    onEvent: (event: import('../../scheduling/types').NativeScheduleEvent) => void | Promise<void>, current?: () => boolean): Promise<import('../../scheduling/types').NativeScheduleHandle>;
  initialize(): Promise<unknown>;
  newSession(cwd: string, mcpServers?: AcpMcpServer[]): Promise<AcpSessionResult>;
  loadSession(sessionId: string, cwd: string, mcpServers?: AcpMcpServer[]): Promise<AcpSessionResult>;
  /** Optional initial-control transaction; ordinary transport signatures stay compatible. */
  newSessionWithSetup?(cwd: string, mcpServers: AcpMcpServer[] | undefined, setup: AcpSessionSetup): Promise<AcpSessionResult>;
  loadSessionWithSetup?(sessionId: string, cwd: string, mcpServers: AcpMcpServer[] | undefined, setup: AcpSessionSetup): Promise<AcpSessionResult>;
  prompt(sessionId: string, blocks: AcpContentBlock[]): Promise<{ stopReason: string }>;
  setConfigOption(sessionId: string, configId: string, value: string): Promise<AcpSessionResult>;
  compactSession?(sessionId: string): Promise<{ stopReason: string }>;
  deleteSession(sessionId: string): Promise<void>;
  sendCancel(sessionId: string): void;
  destroy(): void;
  waitForExit?(): Promise<void>;
  waitForManagedProcessGroupExit?(): Promise<void>;
}

/** Optional launch policy for specialized transports; existing ACP launches are unchanged. */
export interface AcpLaunchOptions {
  delegationWorker?: boolean;
  env?: NodeJS.ProcessEnv;
  onStderr?: (message: string) => void;
}

export class AcpClient implements AcpTransport {
  private readonly workerGroups = new ManagedProcessGroups();
  private readonly workerGroupEnabled: boolean;
  private readonly child: ChildProcess;
  private readonly callbacks: AcpEventCallbacks;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly rl: readline.Interface;
  private nextId = 1;
  private readonly sessionAdmissions = new Map<string, object | undefined>();
  private sessionEpoch: object = {};
  private readonly sessionSetups = new Set<object>();
  private destroyed = false;
  private closed = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly exited: Promise<void>;

  constructor(command: string, args: string[], cwd: string, callbacks: AcpEventCallbacks, private readonly managedProcess = false, launch: AcpLaunchOptions = {}) {
    this.workerGroupEnabled = launch.delegationWorker === true;
    this.callbacks = callbacks;
    assertWorkingDirectoryExists(cwd);
    this.child = spawnManaged(this.workerGroupEnabled, command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: launch.env ?? process.env,
      ...(managedProcess && process.platform !== 'win32' ? { detached: true } : {}),
    });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    if (this.workerGroupEnabled) this.workerGroups.track(this.child);

    this.child.stdout!.on('error', () => {});
    this.child.stdin?.on('error', () => {});
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trimEnd();
      if (message && !message.includes('EPIPE') && !message.includes('write EPIPE')) {
        if (launch.onStderr) launch.onStderr(message);
        else console.error(`[AcpClient stderr] ${message}`);
      }
    });

    this.rl = readline.createInterface({ input: this.child.stdout! });
    this.rl.on('line', (line) => this.handleLine(line));
    this.child.on('error', (error) => this.rejectAllPending(error));
    this.child.on('close', (code, signal) => {
      this.sessionEpoch = {};
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

  async newSession(cwd: string, mcpServers: AcpMcpServer[] = []): Promise<AcpSessionResult> {
    return this.newSessionWithSetup(cwd, mcpServers);
  }

  async newSessionWithSetup(cwd: string, mcpServers: AcpMcpServer[] = [], setup?: AcpSessionSetup): Promise<AcpSessionResult> {
    for (const id of this.sessionAdmissions.keys()) this.sessionAdmissions.set(id, undefined);
    return this.prepareSession('session/new', { cwd, mcpServers }, setup);
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: AcpMcpServer[] = []): Promise<AcpSessionResult> {
    return this.loadSessionWithSetup(sessionId, cwd, mcpServers);
  }

  async loadSessionWithSetup(sessionId: string, cwd: string, mcpServers: AcpMcpServer[] = [], setup?: AcpSessionSetup): Promise<AcpSessionResult> {
    if (this.sessionAdmissions.has(sessionId) || this.sessionAdmissions.size < 1000) this.sessionAdmissions.set(sessionId, undefined);
    return this.prepareSession('session/load', { sessionId, cwd, mcpServers }, setup);
  }

  private async prepareSession(method: 'session/new' | 'session/load', params: object, setup?: AcpSessionSetup): Promise<AcpSessionResult> {
    if (this.closed) throw new Error('ACP process exited before initial session setup.');
    const epoch = this.sessionEpoch = {};
    const ticket = {};
    if (setup) this.sessionSetups.add(ticket);
    let active = true;
    let configuring = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => {
      if (!active || this.destroyed || this.closed || this.sessionEpoch !== epoch) throw new Error('ACP initial session setup was invalidated.');
    };
    try {
      current();
      const result = await this.sendRequest(method, params) as AcpSessionResult;
      const id = result?.sessionId;
      const fresh = method === 'session/new' && typeof id === 'string' && id.length > 0
        && !this.sessionAdmissions.has(id) && this.sessionAdmissions.size < 1000;
      // A stale or loaded identity can never become a later fresh allocation.
      if (typeof id === 'string' && id.length > 0 && this.sessionAdmissions.size < 1000) this.sessionAdmissions.set(id, undefined);
      current();
      if (setup) {
        await Promise.race([
          setup(result, async (configId, value) => {
            current();
            if (configuring) throw new Error('ACP initial session controls must be sequential.');
            if (typeof id !== 'string' || !id) throw new Error('ACP initial session identity is missing.');
            configuring = true;
            try {
              const configured = await this.sendRequest('session/set_config_option', { sessionId: id, configId, value }) as AcpSessionResult;
              current();
              return configured;
            } finally { configuring = false; }
          }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => {
            active = false;
            reject(new Error('ACP initial session setup timed out.'));
          }, CONTROL_REQUEST_TIMEOUT_MS * 3); }),
        ]);
      }
      current();
      if (configuring) throw new Error('ACP initial session controls are still pending.');
      if (fresh) this.sessionAdmissions.set(id, Object.freeze({}));
      return result;
    } finally {
      active = false;
      if (timer) clearTimeout(timer);
      this.sessionSetups.delete(ticket);
    }
  }

  async prompt(sessionId: string, blocks: AcpContentBlock[]): Promise<{ stopReason: string }> {
    if (this.sessionSetups.size) {
      this.sessionEpoch = {};
      throw new Error('ACP initial session setup is still pending.');
    }
    return this.sendRequest('session/prompt', { sessionId, prompt: blocks }) as Promise<{ stopReason: string }>;
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<AcpSessionResult> {
    this.sessionEpoch = {};
    if (this.sessionAdmissions.has(sessionId)) this.sessionAdmissions.set(sessionId, undefined);
    return this.sendRequest('session/set_config_option', {
      sessionId,
      configId,
      value,
    }) as Promise<AcpSessionResult>;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessionEpoch = {};
    if (this.sessionAdmissions.has(sessionId)) this.sessionAdmissions.set(sessionId, undefined);
    await this.sendRequest('session/delete', { sessionId });
  }

  sendCancel(sessionId: string): void {
    this.sessionEpoch = {};
    if (this.sessionAdmissions.has(sessionId)) this.sessionAdmissions.set(sessionId, undefined);
    this.sendNotification('session/cancel', { sessionId });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.sessionEpoch = {};
    this.rejectAllPending(new Error('ACP client destroyed'));
    this.rl.close();
    try {
      this.child.stdin?.end();
    } catch {}
    if (!this.child.killed) {
      this.signalProcess('SIGTERM');
      this.killTimer = setTimeout(() => {
        if (!this.closed) this.signalProcess('SIGKILL');
      }, SIGKILL_GRACE_MS);
      this.killTimer.unref?.();
    }
  }

  sessionAdmission(sessionId: string): object | undefined {
    return this.closed || this.destroyed ? undefined : this.sessionAdmissions.get(sessionId);
  }

  sessionLifecycle(): object | undefined { return this.closed || this.destroyed ? undefined : this.sessionEpoch; }

  waitForExit(): Promise<void> { return this.exited; }

  async waitForManagedProcessGroupExit(): Promise<void> {
    if (!this.workerGroupEnabled) throw new Error('Managed worker process-group tracking was not enabled');
    await this.workerGroups.waitForExit();
  }

  private signalProcess(signal: NodeJS.Signals): void {
    if (this.managedProcess && process.platform === 'linux' && this.child.pid) {
      try { process.kill(-this.child.pid, signal); return; } catch { /* Fall back to the direct child. */ }
    }
    this.child.kill(signal);
  }

  protected sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      // Inference may wait for tools or human input. Only control RPCs have
      // this deadline, so settings cannot hold command admission indefinitely.
      const timer = method === 'session/prompt' ? undefined : setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`ACP ${method} timed out after ${CONTROL_REQUEST_TIMEOUT_MS}ms`));
      }, CONTROL_REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timer });
      try { this.writeLine({ jsonrpc: '2.0', id, method, params } satisfies AcpJsonRpcRequest); }
      catch (error) {
        if (timer) clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  protected sendNotification(method: string, params: unknown): void {
    this.writeLine({ jsonrpc: '2.0', method, params } satisfies AcpJsonRpcNotification);
  }

  protected sendResponse(id: number, result: unknown): void {
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
    if (pending.timer) clearTimeout(pending.timer);
    if ('error' in message) {
      const data = message.error.data === undefined ? '' : ` (${JSON.stringify(message.error.data)})`;
      pending.reject(Object.assign(new Error(`ACP error ${message.error.code}: ${message.error.message}${data}`), {
        code: message.error.code, data: message.error.data, rpcMessage: message.error.message,
      }));
    } else {
      pending.resolve(message.result);
    }
  }

  protected handleNotification(message: AcpJsonRpcNotification): void {
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

  protected async handlePermissionRequest(
    id: number,
    params: { toolCall?: { title?: string }; options?: AcpPermissionOption[] }
  ): Promise<void> {
    const options = Array.isArray(params?.options) ? params.options : [];
    if (options.length === 0 || !this.callbacks.onPermissionRequest) {
      this.sendResponse(id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    let index: number;
    try {
      index = await this.callbacks.onPermissionRequest(params.toolCall?.title ?? 'Tool request', options);
    } catch {
      this.sendResponse(id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= options.length) {
      this.sendResponse(id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    const selected = options[index];
    if (!selected || typeof selected.kind !== 'string') {
      this.sendResponse(id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    const rejected = selected.kind === 'reject_once' || selected.kind === 'reject_always';
    const allowed = selected.kind === 'allow_once' || selected.kind === 'allow_always';
    if (rejected) {
      this.sendResponse(id, { outcome: { outcome: 'cancelled' } });
    } else if (allowed && typeof selected.optionId === 'string' && selected.optionId) {
      this.sendResponse(id, { outcome: { outcome: 'selected', optionId: selected.optionId } });
    } else {
      this.sendResponse(id, { outcome: { outcome: 'cancelled' } });
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private clearKillTimer(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
  }
}

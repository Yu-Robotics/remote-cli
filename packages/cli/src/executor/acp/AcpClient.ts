import { ChildProcess, spawn } from 'child_process';
import * as readline from 'readline';
import type {
  PermissionOption,
  SessionUpdate,
  ContentChunk,
  ToolCall,
  ToolCallUpdate,
  Plan,
} from '@agentclientprotocol/sdk';
import type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  AcpSessionUpdateParams,
} from './AcpTypes';

// ─── Grace period before SIGKILL after SIGTERM (mirrors acpx) ─────────────────
const SIGKILL_GRACE_MS = 5_000;

export interface AcpEventCallbacks {
  onTextChunk: (text: string) => void;
  onThoughtChunk?: (text: string) => void;
  onToolCall?: (toolCallId: string, title: string, kind?: string) => void;
  onToolResult?: (toolCallId: string, status: string, output?: string) => void;
  onPlan?: (text: string) => void;
  /** Returns the index of the chosen option (0 = first = typically allow_once). */
  onPermissionRequest?: (title: string, options: PermissionOption[]) => Promise<number>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Bidirectional JSON-RPC 2.0 transport for Gemini CLI ACP.
 *
 * Improvements over the previous version (inspired by acpx):
 *  - Uses canonical types from @agentclientprotocol/sdk
 *  - Multi-stage graceful shutdown: stdin close → SIGTERM → SIGKILL
 *  - Explicit sendCancel() for cooperative in-flight cancellation
 *  - Strict JSON-RPC message validation before routing
 *  - Handles the 'close' event in addition to 'exit' for reliable cleanup
 */
export class AcpClient {
  private child: ChildProcess;
  private pendingRequests = new Map<number, PendingRequest>();
  private nextId = 1;
  private callbacks: AcpEventCallbacks;
  private rl: readline.Interface;
  private destroyed = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    geminiCommand: string,
    geminiArgs: string[],
    cwd: string,
    callbacks: AcpEventCallbacks
  ) {
    this.callbacks = callbacks;

    this.child = spawn(geminiCommand, geminiArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: process.env,
    });

    this.rl = readline.createInterface({ input: this.child.stdout! });
    this.rl.on('line', (line) => this.handleLine(line));

    this.child.on('error', (err) => {
      console.error('[AcpClient] Child process error:', err.message);
      this.rejectAllPending(err);
    });

    // Use 'close' (fires after stdio is drained) rather than 'exit' alone
    this.child.on('close', (code, signal) => {
      this.clearKillTimer();
      if (!this.destroyed) {
        console.warn(`[AcpClient] Child closed unexpectedly: code=${code} signal=${signal}`);
        this.rejectAllPending(new Error(`Gemini CLI exited: code=${code} signal=${signal}`));
      }
    });
  }

  // ─── ACP lifecycle ──────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    const result = await this.sendRequest('initialize', { protocolVersion: 1 }) as { protocolVersion: number };
    console.log(`[AcpClient] Initialized, server protocol version: ${result.protocolVersion}`);
  }

  async newSession(cwd: string): Promise<string> {
    const result = await this.sendRequest('session/new', { cwd, mcpServers: [] }) as { sessionId: string };
    return result.sessionId;
  }

  /** Switch a session to YOLO mode so no per-tool permission requests are sent. */
  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    await this.sendRequest('session/set_mode', { sessionId, modeId });
  }

  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    const result = await this.sendRequest('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    }) as { stopReason: string };
    return result;
  }

  /**
   * Send a cooperative cancel notification for an in-flight prompt.
   * The agent may still send final updates before replying with stopReason='cancelled'.
   */
  sendCancel(sessionId: string): void {
    this.sendNotification('session/cancel', { sessionId });
  }

  /**
   * Graceful multi-stage shutdown (mirrors acpx):
   *   1. Close stdin so the agent sees EOF
   *   2. Send SIGTERM and wait SIGKILL_GRACE_MS
   *   3. If still alive, send SIGKILL
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rl.close();

    // Stage 1: close stdin (EOF signal to the child)
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }

    if (!this.child.killed) {
      // Stage 2: SIGTERM
      this.child.kill('SIGTERM');

      // Stage 3: escalate to SIGKILL if still running after grace period
      this.killTimer = setTimeout(() => {
        if (!this.child.killed) {
          console.warn('[AcpClient] Grace period elapsed, sending SIGKILL');
          this.child.kill('SIGKILL');
        }
      }, SIGKILL_GRACE_MS);
    }

    this.rejectAllPending(new Error('AcpClient destroyed'));
  }

  // ─── Internal message routing ───────────────────────────────────────────────

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.pendingRequests.set(id, { resolve, reject });
      this.writeLine(msg);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.writeLine(msg);
  }

  private sendResponse(id: number, result: unknown): void {
    const msg: JsonRpcSuccessResponse = { jsonrpc: '2.0', id, result };
    this.writeLine(msg);
  }

  private sendErrorResponse(id: number, code: number, message: string): void {
    const msg: JsonRpcErrorResponse = { jsonrpc: '2.0', id, error: { code, message } };
    this.writeLine(msg);
  }

  private writeLine(msg: object): void {
    if (this.destroyed || !this.child.stdin) return;
    const line = JSON.stringify(msg);
    console.log(`[AcpClient] → ${line.slice(0, 200)}${line.length > 200 ? '...' : ''}`);
    this.child.stdin.write(line + '\n');
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    console.log(`[AcpClient] ← ${line.slice(0, 300)}${line.length > 300 ? '...' : ''}`);

    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // Non-JSON output (e.g. Gemini startup logs) — ignore
      console.log(`[AcpClient] ← Non-JSON: ${line.slice(0, 200)}`);
      return;
    }

    // ── Strict JSON-RPC 2.0 validation ──────────────────────────────────────
    if (typeof msg !== 'object' || msg === null) return;
    const obj = msg as Record<string, unknown>;
    if (obj['jsonrpc'] !== '2.0') {
      console.warn('[AcpClient] ⚠️ Dropping non-JSON-RPC-2.0 message');
      return;
    }

    const hasId = typeof obj['id'] === 'number';
    const hasMethod = typeof obj['method'] === 'string';

    if (hasId && hasMethod) {
      // Server→client request (e.g. session/request_permission)
      this.handleServerRequest(obj as unknown as JsonRpcRequest);
    } else if (hasId) {
      // Response to one of our requests
      this.handleResponse(obj as unknown as JsonRpcResponse);
    } else if (hasMethod) {
      // Notification
      this.handleNotification(obj as unknown as JsonRpcNotification);
    } else {
      console.warn('[AcpClient] ⚠️ Unrecognized JSON-RPC message shape');
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) {
      console.warn(`[AcpClient] ⚠️ No pending request for id=${msg.id}`);
      return;
    }
    this.pendingRequests.delete(msg.id);

    if ('error' in msg) {
      console.error(`[AcpClient] ❌ RPC error id=${msg.id} code=${msg.error.code}: ${msg.error.message}`);
      pending.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    if (msg.method === 'session/update') {
      this.handleSessionUpdate(msg.params as AcpSessionUpdateParams);
    }
    // Other notifications silently ignored
  }

  private handleServerRequest(msg: JsonRpcRequest): void {
    if (msg.method === 'session/request_permission') {
      void this.handlePermissionRequest(msg.id, msg.params as {
        sessionId: string;
        toolCall: { toolCallId: string; title: string };
        options: PermissionOption[];
      });
    } else {
      // Unknown method — reply method_not_found so the agent can fall back gracefully
      this.sendErrorResponse(msg.id, -32601, 'Method not found');
    }
  }

  private handleSessionUpdate(params: AcpSessionUpdateParams): void {
    const { update } = params;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const block = (update as ContentChunk & { sessionUpdate: string }).content;
        const text = block.type === 'text' ? block.text : undefined;
        if (text) this.callbacks.onTextChunk(text);
        break;
      }
      case 'agent_thought_chunk': {
        const block = (update as ContentChunk & { sessionUpdate: string }).content;
        const text = block.type === 'text' ? block.text : undefined;
        if (text && this.callbacks.onThoughtChunk) {
          this.callbacks.onThoughtChunk(text);
        }
        break;
      }
      case 'tool_call': {
        const u = update as ToolCall & { sessionUpdate: string };
        if (this.callbacks.onToolCall) {
          this.callbacks.onToolCall(u.toolCallId, u.title ?? u.toolCallId, u.kind ?? undefined);
        }
        break;
      }
      case 'tool_call_update': {
        const u = update as ToolCallUpdate & { sessionUpdate: string };
        if (u.status === 'completed' && this.callbacks.onToolResult) {
          const rawOutput = u.content
            ?.map((c) => ('text' in c ? (c as { text?: string }).text : ''))
            .filter(Boolean)
            .join('');
          this.callbacks.onToolResult(u.toolCallId, u.status, rawOutput);
        }
        break;
      }
      case 'plan': {
        if (this.callbacks.onPlan) {
          const u = update as Plan & { sessionUpdate: string };
          const text = u.entries
            .map((e) => `[${e.status}] ${e.content}`)
            .join('\n');
          this.callbacks.onPlan(text);
        }
        break;
      }
      default:
        // Unknown update type — silently ignore for forward compatibility
        break;
    }
  }

  private async handlePermissionRequest(
    id: number,
    params: { sessionId: string; toolCall: { toolCallId: string; title: string }; options: PermissionOption[] }
  ): Promise<void> {
    let chosenIndex = 0; // default: first option (allow_once / proceed_once)

    if (this.callbacks.onPermissionRequest) {
      try {
        chosenIndex = await this.callbacks.onPermissionRequest(
          params.toolCall.title,
          params.options
        );
      } catch {
        chosenIndex = 0;
      }
    }

    const chosen = params.options[chosenIndex] ?? params.options[0];
    const outcome = chosen.kind.startsWith('reject')
      ? { outcome: 'cancelled' as const }
      : { outcome: 'selected' as const, optionId: chosen.optionId };
    this.sendResponse(id, { outcome });
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private clearKillTimer(): void {
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }
}

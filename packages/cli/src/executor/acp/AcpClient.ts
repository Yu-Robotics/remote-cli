import { ChildProcess, spawn } from 'child_process';
import * as readline from 'readline';
import {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  AcpSessionUpdateParams,
  AcpRequestPermissionParams,
  AcpPermissionOption,
  AcpPermissionResponse,
  AcpInitializeResult,
  AcpNewSessionResult,
  AcpPromptResult,
  AcpUpdateAgentMessageChunk,
  AcpUpdateAgentThoughtChunk,
  AcpUpdateToolCall,
  AcpUpdateToolCallUpdate,
  AcpUpdatePlan,
} from './AcpTypes';

export interface AcpEventCallbacks {
  onTextChunk: (text: string) => void;
  onThoughtChunk?: (text: string) => void;
  onToolCall?: (toolCallId: string, title: string, kind?: string) => void;
  onToolResult?: (toolCallId: string, status: string, output?: string) => void;
  onPlan?: (text: string) => void;
  /** Returns the index of the chosen option (0 = first = typically allow_once). */
  onPermissionRequest?: (title: string, options: AcpPermissionOption[]) => Promise<number>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Bidirectional JSON-RPC 2.0 transport for Gemini CLI ACP.
 *
 * Manages a single Gemini CLI child process and routes messages:
 *  - Outgoing: sendRequest / sendNotification over stdin
 *  - Incoming: responses, notifications, server-side requests (permission) over stdout
 *
 * Permissions are auto-approved with allow_once unless a custom onPermissionRequest
 * callback is provided.
 */
export class AcpClient {
  private child: ChildProcess;
  private pendingRequests = new Map<number, PendingRequest>();
  private nextId = 1;
  private callbacks: AcpEventCallbacks;
  private rl: readline.Interface;
  private destroyed = false;

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

    this.child.on('exit', (code, signal) => {
      if (!this.destroyed) {
        console.warn(`[AcpClient] Child exited unexpectedly: code=${code} signal=${signal}`);
        this.rejectAllPending(new Error(`Gemini CLI exited: code=${code} signal=${signal}`));
      }
    });
  }

  // ─── ACP lifecycle ──────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    const result = await this.sendRequest('initialize', { protocolVersion: 1 }) as AcpInitializeResult;
    console.log(`[AcpClient] Initialized, server protocol version: ${result.protocolVersion}`);
  }

  async newSession(cwd: string): Promise<string> {
    const result = await this.sendRequest('session/new', { cwd, mcpServers: [] }) as AcpNewSessionResult;
    return result.sessionId;
  }

  /** Switch a session to YOLO mode so no per-tool permission requests are sent. */
  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    await this.sendRequest('session/set_mode', { sessionId, modeId });
  }

  async prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
    const result = await this.sendRequest('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }) as AcpPromptResult;
    return result;
  }

  sendCancel(sessionId: string): void {
    this.sendNotification('session/cancel', { sessionId });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rl.close();
    if (!this.child.killed) {
      this.child.kill('SIGTERM');
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
    console.log(`[AcpClient] → Sending: ${line.slice(0, 200)}${line.length > 200 ? '...' : ''}`);
    this.child.stdin.write(line + '\n');
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    console.log(`[AcpClient] ← Raw line: ${line.slice(0, 300)}${line.length > 300 ? '...' : ''}`);
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // Non-JSON output from Gemini CLI — ignore (e.g. startup logs)
      console.log(`[AcpClient] ← Non-JSON output: ${line.slice(0, 200)}`);
      return;
    }

    const obj = msg as Record<string, unknown>;

    if (typeof obj['id'] === 'number' && obj['method']) {
      // Server-side request (e.g. session/request_permission)
      this.handleServerRequest(obj as unknown as JsonRpcRequest);
    } else if (typeof obj['id'] === 'number') {
      // Response to one of our requests
      this.handleResponse(obj as unknown as JsonRpcResponse);
    } else if (obj['method']) {
      // Notification from server
      this.handleNotification(obj as unknown as JsonRpcNotification);
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) {
      console.log(`[AcpClient] ⚠️ No pending request for id=${msg.id}`);
      return;
    }
    this.pendingRequests.delete(msg.id);

    if ('error' in msg) {
      console.error(`[AcpClient] ❌ JSON-RPC Error: code=${msg.error.code}, message=${msg.error.message}`);
      console.error(`[AcpClient] ❌ Full error data:`, JSON.stringify(msg.error, null, 2));
      pending.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
    } else {
      console.log(`[AcpClient] ✅ Response received for id=${msg.id}`);
      pending.resolve(msg.result);
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    if (msg.method === 'session/update') {
      this.handleSessionUpdate(msg.params as AcpSessionUpdateParams);
    }
    // Other notifications are silently ignored
  }

  private handleServerRequest(msg: JsonRpcRequest): void {
    if (msg.method === 'session/request_permission') {
      void this.handlePermissionRequest(msg.id, msg.params as AcpRequestPermissionParams);
    } else {
      // Unsupported method — return method_not_found (Gemini falls back to local filesystem ops)
      this.sendErrorResponse(msg.id, -32601, 'Method not found');
    }
  }

  private handleSessionUpdate(params: AcpSessionUpdateParams): void {
    const { update } = params;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = (update as AcpUpdateAgentMessageChunk).content.text;
        if (text) this.callbacks.onTextChunk(text);
        break;
      }
      case 'agent_thought_chunk': {
        const text = (update as AcpUpdateAgentThoughtChunk).content.text;
        if (text && this.callbacks.onThoughtChunk) {
          this.callbacks.onThoughtChunk(text);
        }
        break;
      }
      case 'tool_call': {
        const u = update as AcpUpdateToolCall;
        if (this.callbacks.onToolCall) {
          this.callbacks.onToolCall(u.toolCallId, u.title, u.kind);
        }
        break;
      }
      case 'tool_call_update': {
        const u = update as AcpUpdateToolCallUpdate;
        if (u.status === 'completed' && this.callbacks.onToolResult) {
          this.callbacks.onToolResult(u.toolCallId, u.status, u.rawOutput);
        }
        break;
      }
      case 'plan': {
        if (this.callbacks.onPlan) {
          const text = (update as AcpUpdatePlan).entries
            .map((e) => `[${e.status}] ${e.content}`)
            .join('\n');
          this.callbacks.onPlan(text);
        }
        break;
      }
      default:
        // Unknown update type — ignore
        break;
    }
  }

  private async handlePermissionRequest(id: number, params: AcpRequestPermissionParams): Promise<void> {
    let chosenIndex = 0; // default: first option = allow_once / proceed_once

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
    const response: AcpPermissionResponse = chosen.kind.startsWith('reject')
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: chosen.optionId } };
    this.sendResponse(id, response);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }
}

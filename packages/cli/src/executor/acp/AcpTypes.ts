/**
 * ACP type re-exports from @agentclientprotocol/sdk.
 *
 * We delegate all wire-format types to the official SDK rather than
 * maintaining hand-written duplicates.  Only project-specific additions
 * (that the SDK does not cover) live here.
 */

// ─── Re-export canonical SDK types ───────────────────────────────────────────

export type {
  // Session lifecycle
  NewSessionResponse,
  PromptResponse,
  StopReason,

  // Session updates
  SessionUpdate,
  ContentChunk,
  ToolCall,
  ToolCallUpdate,
  Plan,
  PlanEntry,
  PlanEntryStatus,
  PlanEntryPriority,

  // Permissions
  PermissionOption,
  PermissionOptionKind,
  PermissionOptionId,
  RequestPermissionRequest,
  RequestPermissionResponse,
  RequestPermissionOutcome,
} from '@agentclientprotocol/sdk';

// ─── JSON-RPC 2.0 envelope (not exported by SDK — it only exposes ACP-level types) ──

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ─── Session update notification envelope (not in SDK public types) ──────────

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: import('@agentclientprotocol/sdk').SessionUpdate;
}

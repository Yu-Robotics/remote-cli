/**
 * ACP wire format type definitions (subset needed for our client role).
 * Gemini CLI exposes Agent Client Protocol (ACP) via --experimental-acp.
 * ACP is JSON-RPC 2.0 over stdio (newline-delimited).
 */

// ─── JSON-RPC 2.0 envelope ────────────────────────────────────────────────────

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
  // No id field — notifications don't expect a response
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

// ─── ACP content blocks ───────────────────────────────────────────────────────

export interface AcpContentBlock {
  type: 'text' | 'image' | 'resource_link' | 'resource';
  text?: string;
}

// ─── session/update notification payload variants ─────────────────────────────

export interface AcpUpdateAgentMessageChunk {
  sessionUpdate: 'agent_message_chunk';
  content: AcpContentBlock;
}

export interface AcpUpdateAgentThoughtChunk {
  sessionUpdate: 'agent_thought_chunk';
  content: AcpContentBlock;
}

export interface AcpUpdateToolCall {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title: string;
  kind?: string;
  status?: string;
}

export interface AcpUpdateToolCallUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status: string;
  rawOutput?: string;
}

export interface AcpUpdatePlan {
  sessionUpdate: 'plan';
  content: AcpContentBlock[];
}

export interface AcpUpdateUnknown {
  sessionUpdate: string;
  [key: string]: unknown;
}

export type AcpSessionUpdate =
  | AcpUpdateAgentMessageChunk
  | AcpUpdateAgentThoughtChunk
  | AcpUpdateToolCall
  | AcpUpdateToolCallUpdate
  | AcpUpdatePlan
  | AcpUpdateUnknown;

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: AcpSessionUpdate;
}

// ─── session/request_permission ───────────────────────────────────────────────

export interface AcpPermissionOption {
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: { toolCallId: string; title: string };
  options: AcpPermissionOption[];
}

// ─── Method results ───────────────────────────────────────────────────────────

export interface AcpInitializeResult {
  protocolVersion: number;
}

export interface AcpNewSessionResult {
  sessionId: string;
}

export interface AcpPromptResult {
  sessionId: string;
  stopReason: 'end_turn' | 'max_tokens' | 'cancelled' | 'refusal' | 'max_turn_requests';
}

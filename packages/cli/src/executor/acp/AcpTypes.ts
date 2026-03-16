/**
 * ACP wire-format types — inlined from the Agent Client Protocol spec.
 *
 * These were previously re-exported from @agentclientprotocol/sdk, but that
 * package is a pure-type dependency that causes "Cannot find module" errors
 * when the published package is installed without it.  Since we only use a
 * small subset of the ACP types we inline the relevant definitions here so
 * there is no external type dependency at all.
 */

// ─── ACP session-update types ────────────────────────────────────────────────

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';
export type PlanEntryPriority = 'high' | 'medium' | 'low';

export interface PlanEntry {
  content: string;
  status: PlanEntryStatus;
  priority: PlanEntryPriority;
}

export interface Plan {
  entries: PlanEntry[];
}

export type TextContent = { type: 'text'; text: string };
export type ImageContent = { type: 'image'; data: string; mimeType: string };
export type ContentBlock = TextContent | ImageContent | { type: string; [key: string]: unknown };

/** agent_message_chunk / agent_thought_chunk */
export interface ContentChunk {
  content: ContentBlock;
}

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** tool_call notification */
export interface ToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
}

/** tool_call_update notification */
export interface ToolCallUpdate {
  toolCallId: string;
  status?: ToolCallStatus | null;
  content?: Array<ContentBlock> | null;
}

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
export type PermissionOptionId = string;

export interface PermissionOption {
  kind: PermissionOptionKind;
  optionId: PermissionOptionId;
  name?: string;
}

export type SessionUpdate =
  | (ContentChunk & { sessionUpdate: 'agent_message_chunk' })
  | (ContentChunk & { sessionUpdate: 'agent_thought_chunk' })
  | (ToolCall & { sessionUpdate: 'tool_call' })
  | (ToolCallUpdate & { sessionUpdate: 'tool_call_update' })
  | (Plan & { sessionUpdate: 'plan' })
  | { sessionUpdate: string; [key: string]: unknown };

// ─── JSON-RPC 2.0 envelope (not part of the ACP spec itself) ─────────────────

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

// ─── Session update notification envelope ────────────────────────────────────

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

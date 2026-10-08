import { version } from '../../package.json';

/**
 * Common type definitions
 */

/**
 * Router's current protocol version.
 * Increment when making any breaking wire format change.
 * See CLAUDE.md § Protocol Versioning for rules on when to bump.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Oldest CLI protocol version the router will accept.
 * Bump this (along with PROTOCOL_VERSION) only when dropping backward compat.
 * Old CLIs below this version receive a PROTOCOL_VERSION_INCOMPATIBLE error.
 */
export const MIN_SUPPORTED_CLI_VERSION = 1;

/**
 * Router npm package version, returned by the /api/version endpoint.
 * Auto-imported from package.json.
 */
export const ROUTER_VERSION = version;

// Binding code (valid for 5 minutes)
export interface BindingCode {
  devicePublicKey?: string;
  code: string;           // "ABC-123-XYZ"
  deviceId: string;       // "dev_mac_xxx"
  createdAt: number;      // Creation timestamp
  expiresAt: number;      // Expiration timestamp
}

// Legacy binding record (for migration from single-device schema)
export interface LegacyUserBinding {
  openId: string;         // Feishu user open_id
  deviceId: string;       // Device unique identifier
  deviceName: string;     // "MacBook-Pro-xxx"
  boundAt: number;        // Binding time
  lastActiveAt: number;   // Last active time
}

// Single device binding record
export interface DeviceBinding {
  deviceId: string;       // Device unique identifier
  deviceName: string;     // "MacBook-Pro-xxx"
  boundAt: number;        // Binding time
  lastActiveAt: number;   // Last active time
  isActive: boolean;      // Whether this device is the active one
}

// User binding record (supports multiple devices)
export interface UserBinding {
  openId: string;                    // Feishu user open_id
  devices: DeviceBinding[];          // Array of bound devices
  activeDeviceId: string | null;     // Currently active device ID
  createdAt: number;                 // First binding time
  updatedAt: number;                 // Last update time
}

// WebSocket message type
export enum MessageType {
  COMMAND = 'command',             // Command message
  RESPONSE = 'response',           // Response message
  BINDING_REQUEST = 'binding_request',  // Binding request
  BINDING_CONFIRM = 'binding_confirm',  // Binding confirmation
  HEARTBEAT = 'heartbeat',         // Heartbeat
  ERROR = 'error',                 // Error
  NOTIFICATION = 'notification',   // Notification message to Feishu
  TASK_NOTIFICATION = 'task_notification'  // Background task terminal-state event (Claude Code 2.x)
}

export interface TaskResumeInfo {
  /** Available only for a terminal execution; old CLIs omit it. */
  executionMetadata?: ExecutionMetadata;
  recoveryId: string;
  threadName: string;
  backend: string;
  cwd: string;
  preview: string;
  state: 'running' | 'completed' | 'failed';
  error?: string;
}

/**
 * Background task notification payload (Claude Code 2.x)
 *
 * Sent by the CLI when a background task reaches a terminal state. Not tied
 * to any in-flight command — the router renders it as a standalone Feishu
 * card and registers it in cardThreadMap for reply-to-continue routing.
 */
export interface TaskNotificationInfo {
  /** Background task ID */
  taskId: string;
  /** Terminal status of the task */
  status: 'completed' | 'failed' | 'stopped';
  /** Short result summary produced by Claude Code */
  summary: string;
  /** Path to the task's full output file on the user's machine */
  outputFile: string;
}

// WebSocket message interface
export interface WSMessage {
  type: MessageType;
  messageId: string;
  timestamp: number;
  data: any;
}

// Command message
export interface CommandMessage extends WSMessage {
  type: MessageType.COMMAND;
  /** Optional references on the actual top-level command envelope. */
  fileIds?: string[];
  data: {
    openId: string;
    content: string;
    attachments?: Attachment[];
    workingDir?: string;
    isSlashCommand?: boolean;
    threadId?: string;
  };
}

/** Provenance is not a guarantee about a proxy's underlying model identity. */
export type ExecutionMetadataSource = 'reported' | 'configured' | 'default' | 'unknown';

export interface ExecutionMetadata {
  backend: string;
  model?: string;
  modelSource: ExecutionMetadataSource;
  reasoningEffort?: string;
  effortSource: ExecutionMetadataSource;
}

/** Public progress provenance, not private reasoning or an estimated percentage. */
export interface ActivityProgressInfo {
  source: 'public_text' | 'reasoning_summary' | 'plan' | 'tool' | 'state';
  text: string;
}

// Response message
export interface ResponseMessage extends WSMessage {
  type: MessageType.RESPONSE;
  /** Thread that produced this response (optional — new CLIs only) */
  threadId?: string;
  /** Runtime thread summaries for card button rendering (optional — new CLIs only) */
  threads?: ThreadSummary[];
  /** Optional on the actual top-level response envelope; old CLIs omit it. */
  executionMetadata?: ExecutionMetadata;
  /** Optional top-level field; negotiated by the settingsCards capability. */
  settingsMenu?: import('./Settings').SettingsMenu;
  data: {
    success: boolean;
    output?: string;
    error?: string;
    cwd?: string;
    queueConfirmation?: QueueConfirmationInfo;
  };
}

/** Maximum number of threads allowed per user (mirrors CLI-side MAX_THREADS). */
export const MAX_THREADS = 10;

/**
 * Thread runtime summary.
 * Sent from CLI to router in response messages so the router can
 * display per-thread status in Feishu cards.
 */
export interface ThreadSummary {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'error';
  backend?: 'claude' | 'agy' | 'codex' | 'opencode' | 'kimi' | 'zcode' | 'pi' | 'dsh';
  /** Last path component of the thread's current working directory. */
  workspaceName?: string;
}

// Content block types for structured messages
export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'divider' | 'redacted_thinking' | 'plan_mode' | 'image';

// Base content block
export interface ContentBlock {
  type: ContentBlockType;
}

// Text content block
export interface TextBlock extends ContentBlock {
  type: 'text';
  content: string;
}

// Image content block (base64 encoded)
export interface ImageBlock extends ContentBlock {
  type: 'image';
  data: string; // base64 data
  mimeType: string;
}

/**
 * Attachment for incoming messages
 */
export type Attachment = ImageBlock;

/** Emitted immediately before a confirmed queued task starts executing. */
export interface QueueStartedInfo {
  threadName: string;
  backend: string;
  cwd: string;
  preview: string;
  remainingCount: number;
}

/** Confirmation payload for a message waiting to be added to a busy thread queue. */
export interface QueueConfirmationInfo {
  id: string;
  threadId: string;
  threadName: string;
  backend: string;
  cwd: string;
  preview: string;
  pendingCount: number;
  expiresAt: number;
}

// Tool use information
export interface ToolUseInfo {
  name: string;
  id: string;
  input: Record<string, any>;
  /** Optional per-call labels supplied by the backend, not execution-wide activity. */
  title?: string;
  description?: string;
}

// Tool result information
export interface ToolResultInfo {
  tool_use_id: string;
  content: string;
  is_error: boolean;
  /** Optional unified diff for file-change results. */
  diff?: string;
  /** Optional bounded native web results; content remains the old-peer fallback. */
  webSearch?: WebSearchResultsInfo;
}

export interface WebSearchResultsInfo {
  results: Array<{ title?: string; url?: string; snippet?: string }>;
  /** Native entries excluded from this preview, including unsupported entries. */
  omittedResults: number;
}

/** Lifecycle event for a delegated worker displayed inside its coordinator card. */
export type DelegationProgressPhase =
  | 'started'
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'waiting_input'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted';

/** Bounded delegated-worker progress associated with the coordinator's streaming card. */
export interface DelegationProgressInfo {
  /** Optional, CLI-owned identity for a capability-negotiated context reset. */
  workerContext?: { laneId: string; generation: number };
  taskId: string;
  backend: string;
  phase: DelegationProgressPhase;
  /** This worker's bounded execution snapshot; old CLIs omit it. */
  executionMetadata?: ExecutionMetadata;
  /** Optional public activity snapshot; never a result or worker liveness signal. */
  activity?: ActivityProgressInfo;
  /** Verified native input state from activity-progress-capable CLIs. */
  waitingForInput?: boolean;
  objective?: string;
  toolUse?: ToolUseInfo;
  toolResult?: ToolResultInfo;
  /** Latest bounded displayable worker text. This is not a task result or liveness signal. */
  latestText?: string;
  summary?: string;
  error?: string;
  startedAt?: number;
}

// Tool use content block
export interface ToolUseBlock extends ContentBlock {
  type: 'tool_use';
  tool: ToolUseInfo;
}

// Tool result content block
export interface ToolResultBlock extends ContentBlock {
  type: 'tool_result';
  result: ToolResultInfo;
}

// Divider content block
export interface DividerBlock extends ContentBlock {
  type: 'divider';
}

// Redacted thinking content block (for safety-filtered reasoning)
// When AI models' internal reasoning is flagged by safety systems,
// the thinking block is encrypted and returned as redacted_thinking.
// This applies to Claude 3.7 Sonnet and Gemini models.
export interface RedactedThinkingBlock extends ContentBlock {
  type: 'redacted_thinking';
  /** Encrypted thinking content (not human-readable) */
  redacted_thinking: string;
}

// Plan mode content block
// Represents the plan that Claude produces when entering plan mode.
// Execution is auto-approved; this block is for user visibility only.
export interface PlanModeBlock extends ContentBlock {
  type: 'plan_mode';
  /** The plan text produced by Claude between EnterPlanMode and ExitPlanMode */
  planContent: string;
}

// Union type for all content blocks
export type ContentBlockUnion = TextBlock | ToolUseBlock | ToolResultBlock | DividerBlock | RedactedThinkingBlock | PlanModeBlock | ImageBlock;

// Structured content for rich message formatting
export interface StructuredContent {
  blocks: ContentBlockUnion[];
  sessionAbbr?: string;
}

// Structured message from client
export interface StructuredMessage extends WSMessage {
  type: MessageType.RESPONSE;
  /** Thread that produced this response (optional — new CLIs only) */
  threadId?: string;
  /** Runtime thread summaries for card button rendering (optional — new CLIs only) */
  threads?: ThreadSummary[];
  data: {
    success: boolean;
    output?: string;
    structuredContent?: StructuredContent;
    error?: string;
    sessionAbbr?: string;
    openId?: string;
    cwd?: string;
  };
}

/** Optional approval-card protocol; negotiated through approvalCards capability. */
export type ApprovalAction = 'approve' | 'deny' | 'remember';
export type ApprovalStatus = 'approved' | 'denied' | 'remembered' | 'expired';

export interface ApprovalRequestInfo {
  requestId: string;
  kind: 'command' | 'file' | 'permissions';
  description: string;
  canRemember: boolean;
  writableRoots?: string[];
}

export interface ApprovalRequestMessage {
  type: 'approval_request';
  messageId: string;
  taskMessageId: string;
  openId: string;
  threadId: string;
  threadName: string;
  cwd: string;
  approval: ApprovalRequestInfo;
  timestamp: number;
}

export interface ApprovalResponseMessage {
  type: 'approval_response';
  messageId: string;
  taskMessageId: string;
  openId: string;
  threadId: string;
  action: ApprovalAction;
  timestamp: number;
}

export interface ApprovalResolvedMessage {
  type: 'approval_resolved';
  messageId: string;
  openId: string;
  threadId: string;
  status: ApprovalStatus | 'pending';
  error?: string;
  timestamp: number;
}

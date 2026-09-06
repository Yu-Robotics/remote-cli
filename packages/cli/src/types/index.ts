import { version } from '../../package.json';
import type { ThreadSummary } from '../thread/types';

/**
 * WebSocket protocol version.
 * Increment this when making breaking changes to the wire format.
 * See CLAUDE.md § Protocol Versioning for rules on when to bump.
 */
export const PROTOCOL_VERSION = 1;

/**
 * CLI npm package version, used to compare against the router version on startup.
 * Auto-imported from package.json.
 */
export const CLI_VERSION = version;

/**
 * Tool use information for structured messages
 */
export interface ToolUseInfo {
  name: string;
  id: string;
  input: Record<string, any>;
}

/**
 * Tool result information for structured messages
 */
export interface ToolResultInfo {
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

/**
 * Content block types for structured streaming messages
 */
export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'divider' | 'redacted_thinking' | 'image';

/**
 * Base content block interface
 */
export interface ContentBlock {
  type: ContentBlockType;
}

/**
 * Text content block
 */
export interface TextBlock extends ContentBlock {
  type: 'text';
  content: string;
}

/**
 * Image content block (base64 encoded)
 */
export interface ImageBlock extends ContentBlock {
  type: 'image';
  data: string; // base64 data
  mimeType: string;
}

/**
 * Attachment for incoming messages
 */
export type Attachment = ImageBlock;

/**
 * Tool use content block
 */
export interface ToolUseBlock extends ContentBlock {
  type: 'tool_use';
  tool: ToolUseInfo;
}

/**
 * Tool result content block
 */
export interface ToolResultBlock extends ContentBlock {
  type: 'tool_result';
  result: ToolResultInfo;
}

/**
 * Divider content block (for visual separation)
 */
export interface DividerBlock extends ContentBlock {
  type: 'divider';
}

/**
 * Redacted thinking content block (for safety-filtered reasoning)
 * When Claude's or other AI models' internal reasoning is flagged by safety systems,
 * the thinking block is encrypted and returned as redacted_thinking.
 * This applies to Claude 3.7 Sonnet and Gemini models.
 */
export interface RedactedThinkingBlock extends ContentBlock {
  type: 'redacted_thinking';
  /** Encrypted thinking content (not human-readable) */
  redacted_thinking: string;
}

/**
 * Union type for all content blocks
 */
export type ContentBlockUnion = TextBlock | ToolUseBlock | ToolResultBlock | DividerBlock | RedactedThinkingBlock | ImageBlock;

/**
 * Structured content for rich message formatting
 */
export interface StructuredContent {
  /** Array of content blocks */
  blocks: ContentBlockUnion[];
  /** Optional session abbreviation for completion tracking */
  sessionAbbr?: string;
}

/**
 * Incoming message from router server
 */
export interface IncomingMessage {
  type: 'command' | 'status' | 'ping';
  messageId: string;
  content?: string;
  /** Optional attachments (e.g. images) */
  attachments?: Attachment[];
  workingDirectory?: string;
  openId?: string;
  timestamp: number;
  /** Whether this is a passthrough slash command */
  isSlashCommand?: boolean;
  /** Target thread ID for multi-thread routing (optional — defaults to default thread) */
  threadId?: string;
}

/**
 * Stream message types
 */
export type StreamType = 'text' | 'tool_use' | 'tool_result' | 'redacted_thinking' | 'plan_mode';

/**
 * Background task notification payload (Claude Code 2.x)
 *
 * Sent by the CLI when a background task reaches a terminal state. Unlike
 * stream messages, this is not tied to any in-flight command's streaming
 * card — the router renders it as a standalone card.
 */
export interface TaskNotificationInfo {
  /** Background task ID */
  taskId: string;
  /** Terminal status of the task */
  status: 'completed' | 'failed' | 'stopped';
  /** Short result summary produced by Claude Code */
  summary: string;
  /** Path to the task's full output file on the local machine */
  outputFile: string;
}

/**
 * Outgoing message to router server
 */
export interface OutgoingMessage {
  type: 'result' | 'progress' | 'status' | 'pong' | 'structured' | 'stream' | 'response' | 'task_notification';
  messageId: string;
  success?: boolean;
  /** Plain text output (for backward compatibility) */
  output?: string;
  /** Structured content for rich formatting (new format) */
  structuredContent?: StructuredContent;
  error?: string;
  message?: string;
  status?: any;
  timestamp: number;
  workingDirectory?: string;
  openId?: string;
  /** Stream chunk (for streaming messages) */
  chunk?: string;
  /** Stream type (for typed streaming) */
  streamType?: StreamType;
  /** Tool use info (when streamType === 'tool_use') */
  toolUse?: ToolUseInfo;
  /** Tool result info (when streamType === 'tool_result') */
  toolResult?: ToolResultInfo;
  /** Plan content (when streamType === 'plan_mode') */
  planContent?: string;
  /** Background task notification (when type === 'task_notification') */
  taskNotification?: TaskNotificationInfo;
  /** Thread ID that produced this output (optional — for multi-thread routing) */
  threadId?: string;
  /** Thread display name (optional — for background task notification cards) */
  threadName?: string;
  /** Runtime thread summaries (for card display) */
  threads?: ThreadSummary[];
  /** Current working directory (for response messages) */
  cwd?: string;
  /** Session abbreviation */
  sessionAbbr?: string;
}

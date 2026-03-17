import { version } from '../../package.json';

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
export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'divider' | 'redacted_thinking';

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
export type ContentBlockUnion = TextBlock | ToolUseBlock | ToolResultBlock | DividerBlock | RedactedThinkingBlock;

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
  workingDirectory?: string;
  openId?: string;
  timestamp: number;
  /** Whether this is a passthrough slash command */
  isSlashCommand?: boolean;
}

/**
 * Stream message types
 */
export type StreamType = 'text' | 'tool_use' | 'tool_result' | 'redacted_thinking' | 'plan_mode';

/**
 * Outgoing message to router server
 */
export interface OutgoingMessage {
  type: 'result' | 'progress' | 'status' | 'pong' | 'structured' | 'stream';
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
}

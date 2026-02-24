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

// Binding code (valid for 5 minutes)
export interface BindingCode {
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
  NOTIFICATION = 'notification'    // Notification message to Feishu
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
  data: {
    openId: string;
    content: string;
    workingDir?: string;
  };
}

// Response message
export interface ResponseMessage extends WSMessage {
  type: MessageType.RESPONSE;
  data: {
    success: boolean;
    output?: string;
    error?: string;
    cwd?: string;
  };
}

// Content block types for structured messages
export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'divider' | 'redacted_thinking';

// Base content block
export interface ContentBlock {
  type: ContentBlockType;
}

// Text content block
export interface TextBlock extends ContentBlock {
  type: 'text';
  content: string;
}

// Tool use information
export interface ToolUseInfo {
  name: string;
  id: string;
  input: Record<string, any>;
}

// Tool result information
export interface ToolResultInfo {
  tool_use_id: string;
  content: string;
  is_error: boolean;
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

// Union type for all content blocks
export type ContentBlockUnion = TextBlock | ToolUseBlock | ToolResultBlock | DividerBlock | RedactedThinkingBlock;

// Structured content for rich message formatting
export interface StructuredContent {
  blocks: ContentBlockUnion[];
  sessionAbbr?: string;
}

// Structured message from client
export interface StructuredMessage extends WSMessage {
  type: MessageType.RESPONSE;
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

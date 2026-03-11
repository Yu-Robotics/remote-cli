import type { ExecutorType } from '../executor';

/**
 * Configuration type definitions
 */

/**
 * Security configuration
 */
export interface SecurityConfig {
  /** Allowed directory list (supports ~ and relative paths) */
  allowedDirectories: string[];
  /** Denied command patterns */
  deniedCommands: string[];
  /** Maximum concurrent tasks */
  maxConcurrentTasks: number;
}

/**
 * Server configuration (for router mode)
 */
export interface ServerConfig {
  /** WebSocket server URL */
  url: string;
  /** Reconnect interval (milliseconds) */
  reconnectInterval: number;
  /** Heartbeat interval (milliseconds) */
  heartbeatInterval: number;
}

/**
 * Feishu configuration (for direct mode)
 */
export interface FeishuConfig {
  /** Feishu app ID */
  appId?: string;
  /** Feishu app secret */
  appSecret?: string;
  /** Whether direct mode is enabled */
  directMode?: boolean;
}

/**
 * Gemini executor configuration
 */
export interface GeminiExecutorConfig {
  /** Gemini model to use */
  model?: string;
  /** Auto-approve tool permissions */
  autoApprove?: boolean;
  /** Override Gemini CLI command */
  command?: string;
  /** Pin Gemini CLI version */
  version?: string;
}

/**
 * Claude executor configuration
 */
export interface ClaudeExecutorConfig {
  /** Whether to use persistent mode */
  persistent?: boolean;
}

/**
 * Executor configuration
 */
export interface ExecutorConfig {
  /** Type of executor to use */
  type: ExecutorType;
  /** Gemini-specific configuration */
  gemini?: GeminiExecutorConfig;
  /** Claude-specific configuration */
  claude?: ClaudeExecutorConfig;
}

/**
 * Complete configuration
 */
export interface Config {
  deviceId?: string;
  openId?: string;
  serverUrl?: string;
  lastWorkingDirectory?: string;
  security: SecurityConfig;
  server: ServerConfig;
  feishu?: FeishuConfig;
  executor?: ExecutorConfig;
  service?: {
    running?: boolean;
    startedAt?: number;
    stoppedAt?: number;
    pid?: number;
  };
}

/**
 * Default configuration
 */
export const DEFAULT_CONFIG: Config = {
  security: {
    allowedDirectories: [],
    deniedCommands: [],
    maxConcurrentTasks: 1
  },
  server: {
    url: 'wss://localhost:3000',
    reconnectInterval: 5000,
    heartbeatInterval: 30000
  },
  feishu: {
    directMode: false
  },
  executor: {
    type: 'auto'
  }
};

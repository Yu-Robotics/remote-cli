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
 * Server configuration
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
 * Gemini executor configuration
 */
export interface GeminiExecutorConfig {
  model?: string;
  /** Auto-approve all tool permissions. Default: true. False = future Feishu approval flow. */
  autoApprove?: boolean;
  /** Override CLI command (default: 'npx') */
  command?: string;
  /** Pin gemini-cli version (default: '@google/gemini-cli@latest') */
  version?: string;
}

/**
 * Executor configuration — controls which AI CLI backend is used
 */
export interface ExecutorConfig {
  type: 'auto' | 'claude-persistent' | 'claude-spawn' | 'gemini';
  gemini?: GeminiExecutorConfig;
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
  service?: {
    running?: boolean;
    startedAt?: number;
    stoppedAt?: number;
    pid?: number;
  };
  /** Executor backend selection. Defaults to 'auto' (Claude persistent or spawn). */
  executor?: ExecutorConfig;
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
  }
};

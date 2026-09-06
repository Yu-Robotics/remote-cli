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
 * AGY (Antigravity CLI) executor configuration
 */
export interface AgyExecutorConfig {
  /** Model slug from `agy models` (e.g. 'gemini-3.8-flash-low'). Unset = agy default. */
  model?: string;
  /** Auto-approve all tool permissions. Default: true. False = future Feishu approval flow. */
  autoApprove?: boolean;
  /** Override agy binary command (default: 'agy') */
  command?: string;
}

/**
 * Legacy Gemini CLI configuration.
 * @deprecated The Gemini/ACP backend was removed; the 'gemini' backend slot
 * now maps to AGY. These fields are read only as fallbacks for `agy.*`
 * during config migration.
 */
export interface GeminiExecutorConfig {
  model?: string;
  autoApprove?: boolean;
  command?: string;
  version?: string;
}

/**
 * Executor configuration — controls which AI CLI backend is used
 */
export interface ExecutorConfig {
  type: 'auto' | 'claude-persistent' | 'claude-spawn' | 'agy';
  agy?: AgyExecutorConfig;
  /** @deprecated Legacy Gemini config — read as fallback for agy.* during migration. */
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
  /** Remote machine configurations */
  machines?: Record<string, any>;
  /** Remote proxy/host configuration */
  remote?: any;
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

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
 * Codex CLI (OpenAI) executor configuration
 */
export interface CodexSandboxConfig {
  mode: 'workspace-write' | 'read-only' | 'danger-full-access';
  /** Allow network access inside the sandbox. Default: true. */
  networkAccess?: boolean;
  /** Additional writable directories explicitly authorized by the user. */
  writableRoots?: string[];
  /** Include download and package-cache directories. Default: true. */
  developmentDirectories?: boolean;
}

export interface CodexExecutorConfig {
  /** Model passed as -m (e.g. 'gpt-5.2-codex'). Unset = codex default. */
  model?: string;
  /**
   * Use full access and approve tool requests when no sandbox is configured.
   * Restricted sandbox modes always ask before widening permissions. Default: true.
   */
  autoApprove?: boolean;
  /** Optional sandbox policy. Unset preserves the existing backend behavior. */
  sandbox?: CodexSandboxConfig;
  /** Override codex binary command (default: 'codex') */
  command?: string;
}

/**
 * Claude Code sandbox configuration. Mirrors CodexSandboxConfig semantics;
 * mapped to Claude Code's native sandbox settings at process spawn.
 */
export interface ClaudeSandboxConfig {
  mode: 'workspace-write' | 'read-only' | 'danger-full-access';
  /** Let sandboxed commands reach new network domains (asks via approval). Default: true. */
  networkAccess?: boolean;
  /** Additional writable directories explicitly authorized by the user. */
  writableRoots?: string[];
}

/** Claude Code executor configuration. */
export interface ClaudeExecutorConfig {
  /** Optional sandbox policy. Unset preserves the existing backend behavior. */
  sandbox?: ClaudeSandboxConfig;
  /** Override claude binary command (default: 'claude') */
  command?: string;
}

/** OpenCode CLI executor configuration. */
export interface OpenCodeExecutorConfig {
  /** Model in provider/model form. Unset uses the OpenCode session default. */
  model?: string;
  /** Automatically approve tool permission requests. Default: true. */
  autoApprove?: boolean;
  /** Override the OpenCode binary command. Default: opencode. */
  command?: string;
}

/** Kimi Code CLI executor configuration. */
export interface KimiExecutorConfig {
  /** Model alias exposed by the Kimi Code ACP session. */
  model?: string;
  /** Automatically approve tool permission requests. Default: true. */
  autoApprove?: boolean;
  /** Override the Kimi Code binary command. Default: kimi. */
  command?: string;
}

/** Official ZCode executor configuration. */
export interface ZCodeExecutorConfig {
  /** Model ID exposed by the ZCode app-server. Unset uses the session default. */
  model?: string;
  /** Run in yolo mode and automatically approve tool requests. Default: true. */
  autoApprove?: boolean;
  /** Override the ZCode CLI or bundled zcode.cjs path. */
  command?: string;
}

/** Pi coding agent executor configuration. */
export interface PiExecutorConfig {
  /** Model as `provider/id` or a bare model id. Unset uses the Pi session default. */
  model?: string;
  /** Optional provider when `model` is a bare id (for example `google`). */
  provider?: string;
  /** Trust project-local Pi resources for non-interactive RPC runs. Default: true. */
  autoApprove?: boolean;
  /** Override the Pi binary command. Default: pi. */
  command?: string;
}

/**
 * Executor configuration — controls which AI CLI backend is used
 */
export interface ExecutorConfig {
  type: 'auto' | 'claude-persistent' | 'agy' | 'codex' | 'opencode' | 'kimi' | 'zcode' | 'pi';
  claude?: ClaudeExecutorConfig;
  agy?: AgyExecutorConfig;
  codex?: CodexExecutorConfig;
  opencode?: OpenCodeExecutorConfig;
  kimi?: KimiExecutorConfig;
  zcode?: ZCodeExecutorConfig;
  pi?: PiExecutorConfig;
}

/**
 * Canonical backend keys for per-backend thread settings (e.g. Thread.models).
 */
export type BackendKey = 'claude' | 'agy' | 'codex' | 'opencode' | 'kimi' | 'zcode' | 'pi';

/**
 * Map an executor config type to its canonical backend key.
 * 'auto'/'claude-*' map to 'claude'.
 */
export function backendKeyOf(type: ExecutorConfig['type'] | string): BackendKey {
  if (type === 'agy') return 'agy';
  if (type === 'codex') return 'codex';
  if (type === 'opencode') return 'opencode';
  if (type === 'kimi') return 'kimi';
  if (type === 'zcode') return 'zcode';
  if (type === 'pi') return 'pi';
  return 'claude';
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
  /** Executor backend selection. Defaults to 'auto' (Claude persistent). */
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

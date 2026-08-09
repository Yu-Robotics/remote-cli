import { DirectoryGuard } from '../security/DirectoryGuard';
import { ClaudeExecutor } from './ClaudeExecutor';
import { ClaudePersistentExecutor } from './ClaudePersistentExecutor';
import { GeminiExecutor } from './GeminiExecutor';
import type { IExecutor } from './IExecutor';
import type { ExecutorConfig } from '../types/config';

export type { ClaudeExecuteOptions, ClaudeExecuteResult } from './ClaudeExecutor';
export type { PersistentClaudeOptions, PersistentClaudeResult } from './ClaudePersistentExecutor';
export { ClaudeExecutor } from './ClaudeExecutor';
export { ClaudePersistentExecutor } from './ClaudePersistentExecutor';
export { GeminiExecutor } from './GeminiExecutor';
export type { IExecutor } from './IExecutor';

/**
 * Check if we're running inside a Claude Code session
 */
function isRunningInsideClaudeCode(): boolean {
  // Check for CLAUDECODE environment variable
  if (process.env.CLAUDECODE) {
    return true;
  }

  // Check for other indicators
  if (process.env.CLAUDE_CODE) {
    return true;
  }

  return false;
}

/**
 * Executor type
 */
export type ExecutorType = 'persistent' | 'spawn' | 'auto';

/**
 * Create an appropriate Claude executor (legacy API — preserved for backward compatibility)
 *
 * @param directoryGuard Directory guard instance
 * @param type Executor type: 'persistent' (long-running process), 'spawn' (one-shot process), or 'auto' (choose based on environment)
 * @param initialWorkingDirectory Optional initial working directory for persistent executor
 * @returns Executor instance
 */
export function createClaudeExecutor(
  directoryGuard: DirectoryGuard,
  type: ExecutorType = 'auto',
  initialWorkingDirectory?: string
): ClaudeExecutor | ClaudePersistentExecutor {
  if (type === 'auto') {
    // Auto-detect: use spawn mode if running inside Claude Code to avoid nested session error
    if (isRunningInsideClaudeCode()) {
      console.log('[ExecutorFactory] Detected nested Claude Code session, using spawn mode');
      return new ClaudeExecutor(directoryGuard);
    }
    // Otherwise use persistent mode
    console.log('[ExecutorFactory] Using persistent mode for better performance');
    return new ClaudePersistentExecutor(directoryGuard, initialWorkingDirectory);
  }

  if (type === 'persistent') {
    return new ClaudePersistentExecutor(directoryGuard, initialWorkingDirectory);
  }

  return new ClaudeExecutor(directoryGuard);
}

/**
 * Create an executor based on the executor config.
 * Supports Claude (persistent / spawn / auto) and Gemini (via ACP).
 *
 * @param directoryGuard Directory guard instance
 * @param executorConfig Executor config from remote-cli config (defaults to auto)
 * @param initialWorkingDirectory Optional initial working directory
 * @returns IExecutor instance
 */
export function createExecutor(
  directoryGuard: DirectoryGuard,
  executorConfig: ExecutorConfig = { type: 'auto' },
  initialWorkingDirectory?: string,
  threadId?: string,
  model?: string
): IExecutor {
  switch (executorConfig.type) {
    case 'gemini':
      console.log('[ExecutorFactory] Using Gemini CLI executor (ACP)');
      return new GeminiExecutor(directoryGuard, {
        model: executorConfig.gemini?.model,
        autoApprove: executorConfig.gemini?.autoApprove ?? true,
        initialWorkingDirectory,
        geminiCommand: executorConfig.gemini?.command,
        geminiVersion: executorConfig.gemini?.version,
        threadId,
      });

    case 'claude-persistent':
      console.log('[ExecutorFactory] Using Claude persistent executor');
      return new ClaudePersistentExecutor(directoryGuard, initialWorkingDirectory, threadId, model);

    case 'claude-spawn':
      console.log('[ExecutorFactory] Using Claude spawn executor');
      return new ClaudeExecutor(directoryGuard);

    case 'auto':
    default:
      if (isRunningInsideClaudeCode()) {
        console.log('[ExecutorFactory] Detected nested Claude Code session, using spawn mode');
        return new ClaudeExecutor(directoryGuard);
      }
      console.log('[ExecutorFactory] Using Claude persistent executor (auto)');
      return new ClaudePersistentExecutor(directoryGuard, initialWorkingDirectory, threadId, model);
  }
}

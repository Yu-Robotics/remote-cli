import { DirectoryGuard } from '../security/DirectoryGuard';
import { ClaudeExecutor } from './ClaudeExecutor';
import { ClaudePersistentExecutor } from './ClaudePersistentExecutor';
import { AgyExecutor } from './AgyExecutor';
import { CodexExecutor } from './CodexExecutor';
import type { IExecutor } from './IExecutor';
import type { ExecutorConfig } from '../types/config';

export type { ClaudeExecuteOptions, ClaudeExecuteResult } from './ClaudeExecutor';
export type { PersistentClaudeOptions, PersistentClaudeResult } from './ClaudePersistentExecutor';
export { ClaudeExecutor } from './ClaudeExecutor';
export { ClaudePersistentExecutor } from './ClaudePersistentExecutor';
export { AgyExecutor } from './AgyExecutor';
export { CodexExecutor } from './CodexExecutor';
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
 * Supports Claude (persistent / spawn / auto), AGY (Antigravity CLI,
 * stream-json protocol), and Codex (OpenAI codex exec mode).
 *
 * Legacy note: configs written before the Gemini→AGY migration may still
 * say `type: 'gemini'`. That slot now maps to the AGY backend (the Gemini
 * CLI/ACP stack was removed), with `executor.gemini.*` read as a fallback
 * for `executor.agy.*` where applicable.
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
  // Cast to string so the legacy 'gemini' case compiles even though the
  // ExecutorConfig union no longer includes it.
  switch (executorConfig.type as string) {
    case 'agy':
      console.log('[ExecutorFactory] Using AGY CLI executor (stream-json)');
      return new AgyExecutor(directoryGuard, {
        // Legacy fallback: the user may have switched type to 'agy' while
        // their model still lives under the old executor.gemini key.
        model: executorConfig.agy?.model ?? executorConfig.gemini?.model,
        autoApprove: executorConfig.agy?.autoApprove ?? executorConfig.gemini?.autoApprove ?? true,
        initialWorkingDirectory,
        agyCommand: executorConfig.agy?.command,
        threadId,
      });

    case 'gemini': {
      // Legacy alias: the Gemini backend slot was replaced by AGY.
      console.log('[ExecutorFactory] Legacy "gemini" backend migrated to AGY CLI executor');
      const legacy = executorConfig.gemini;
      return new AgyExecutor(directoryGuard, {
        model: executorConfig.agy?.model ?? legacy?.model,
        autoApprove: executorConfig.agy?.autoApprove ?? legacy?.autoApprove ?? true,
        initialWorkingDirectory,
        agyCommand: executorConfig.agy?.command,
        threadId,
      });
    }

    case 'codex':
      console.log('[ExecutorFactory] Using Codex CLI executor (exec mode)');
      return new CodexExecutor(directoryGuard, {
        model: executorConfig.codex?.model,
        autoApprove: executorConfig.codex?.autoApprove ?? true,
        initialWorkingDirectory,
        codexCommand: executorConfig.codex?.command,
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

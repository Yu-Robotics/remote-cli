import { DirectoryGuard } from '../security/DirectoryGuard';
import { ClaudeExecutor } from './ClaudeExecutor';
import { ClaudePersistentExecutor } from './ClaudePersistentExecutor';
import type { IExecutor, ExecuteOptions, ExecuteResult, ExecutorType, ExecutorConfig } from './IExecutor';

export type { IExecutor, ExecuteOptions, ExecuteResult, ExecutorType, ExecutorConfig } from './IExecutor';
export type { ClaudeExecuteOptions, ClaudeExecuteResult } from './ClaudeExecutor';
export type { PersistentClaudeOptions, PersistentClaudeResult } from './ClaudePersistentExecutor';
export { ClaudeExecutor } from './ClaudeExecutor';
export { ClaudePersistentExecutor } from './ClaudePersistentExecutor';

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
 * Create an appropriate executor based on configuration
 *
 * @param directoryGuard Directory guard instance
 * @param config Executor configuration
 * @returns Executor instance implementing IExecutor
 */
export function createExecutor(
  directoryGuard: DirectoryGuard,
  config: ExecutorConfig
): IExecutor {
  const { type, initialWorkingDirectory } = config;

  switch (type) {
    case 'claude-spawn':
      console.log('[ExecutorFactory] Using Claude spawn mode');
      return new ClaudeExecutor(directoryGuard);

    case 'claude-persistent':
      console.log('[ExecutorFactory] Using Claude persistent mode');
      return new ClaudePersistentExecutor(directoryGuard, initialWorkingDirectory);

    case 'gemini':
      console.log('[ExecutorFactory] Using Gemini mode');
      // TODO: Implement GeminiExecutor
      throw new Error('Gemini executor not yet implemented');

    case 'auto':
    default:
      // Auto-detect: use spawn mode if running inside Claude Code to avoid nested session error
      if (isRunningInsideClaudeCode()) {
        console.log('[ExecutorFactory] Detected nested Claude Code session, using spawn mode');
        return new ClaudeExecutor(directoryGuard);
      }
      // Otherwise use persistent mode
      console.log('[ExecutorFactory] Using persistent mode for better performance');
      return new ClaudePersistentExecutor(directoryGuard, initialWorkingDirectory);
  }
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use createExecutor instead
 */
export function createClaudeExecutor(
  directoryGuard: DirectoryGuard,
  type: 'persistent' | 'spawn' | 'auto' = 'auto',
  initialWorkingDirectory?: string
): IExecutor {
  const config: ExecutorConfig = {
    type: type === 'spawn' ? 'claude-spawn' : type === 'persistent' ? 'claude-persistent' : 'auto',
    initialWorkingDirectory
  };
  return createExecutor(directoryGuard, config);
}

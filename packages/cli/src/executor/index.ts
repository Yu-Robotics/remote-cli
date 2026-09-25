import { DirectoryGuard } from '../security/DirectoryGuard';
import { ClaudePersistentExecutor } from './ClaudePersistentExecutor';
import { AgyExecutor } from './AgyExecutor';
import { CodexAppServerExecutor } from './CodexAppServerExecutor';
import { OpenCodeExecutor } from './OpenCodeExecutor';
import { KimiExecutor } from './KimiExecutor';
import { ZCodeExecutor } from './ZCodeExecutor';
import { PiExecutor } from './PiExecutor';
import type { IExecutor } from './IExecutor';
import type { ExecutorConfig } from '../types/config';

export type { PersistentClaudeOptions, PersistentClaudeResult } from './ClaudePersistentExecutor';
export type {
  PersistentClaudeOptions as ClaudeExecuteOptions,
  PersistentClaudeResult as ClaudeExecuteResult,
} from './ClaudePersistentExecutor';
export { ClaudePersistentExecutor } from './ClaudePersistentExecutor';
export { AgyExecutor } from './AgyExecutor';
export { CodexAppServerExecutor } from './CodexAppServerExecutor';
export { OpenCodeExecutor } from './OpenCodeExecutor';
export { KimiExecutor } from './KimiExecutor';
export { ZCodeExecutor } from './ZCodeExecutor';
export { PiExecutor } from './PiExecutor';
export type { ExecutorModelInfo, IExecutor } from './IExecutor';

/**
 * Executor type
 */
export type ExecutorType = 'persistent' | 'spawn' | 'auto';

/**
 * Create an appropriate Claude executor (legacy API — preserved for backward compatibility)
 *
 * @param directoryGuard Directory guard instance
 * @param type Executor type. The legacy 'spawn' value is mapped to persistent mode.
 * @param initialWorkingDirectory Optional initial working directory for persistent executor
 * @returns Executor instance
 */
export function createClaudeExecutor(
  directoryGuard: DirectoryGuard,
  type: ExecutorType = 'auto',
  initialWorkingDirectory?: string
): ClaudePersistentExecutor {
  if (type === 'spawn') {
    console.warn('[ExecutorFactory] Claude spawn mode was removed; using persistent mode.');
  }
  console.log('[ExecutorFactory] Using persistent Claude executor');
  return new ClaudePersistentExecutor(directoryGuard, initialWorkingDirectory);
}

/**
 * Create an executor based on the executor config.
 * Supports Claude (persistent), AGY (stream-json), Codex (app-server),
 * OpenCode and Kimi Code (ACP), official ZCode (app-server), and Pi (RPC).
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
  model?: string,
  effort?: string
): IExecutor {
  const executorType = executorConfig.type as string;
  switch (executorType) {
    case 'agy':
      console.log('[ExecutorFactory] Using AGY CLI executor (stream-json)');
      return new AgyExecutor(directoryGuard, {
        // Per-thread model (set via /model, persisted on the thread) wins.
        model: model ?? executorConfig.agy?.model,
        effort,
        autoApprove: executorConfig.agy?.autoApprove ?? true,
        initialWorkingDirectory,
        agyCommand: executorConfig.agy?.command,
        threadId,
      });

    case 'codex':
      if ((executorConfig.codex as Record<string, unknown> | undefined)?.transport === 'exec') {
        console.warn('[ExecutorFactory] Codex exec transport was removed; using app-server.');
      }
      console.log('[ExecutorFactory] Using Codex app-server executor');
      return new CodexAppServerExecutor(directoryGuard, {
        // Per-thread model (set via /model, persisted on the thread) wins
        model: model ?? executorConfig.codex?.model,
        effort,
        autoApprove: executorConfig.codex?.autoApprove ?? true,
        sandbox: executorConfig.codex?.sandbox,
        initialWorkingDirectory,
        codexCommand: executorConfig.codex?.command,
        threadId,
      });

    case 'opencode':
      console.log('[ExecutorFactory] Using OpenCode ACP executor');
      return new OpenCodeExecutor(directoryGuard, {
        model: model ?? executorConfig.opencode?.model,
        effort,
        autoApprove: executorConfig.opencode?.autoApprove ?? true,
        initialWorkingDirectory,
        openCodeCommand: executorConfig.opencode?.command,
        threadId,
      });

    case 'kimi':
      console.log('[ExecutorFactory] Using Kimi Code ACP executor');
      return new KimiExecutor(directoryGuard, {
        model: model ?? executorConfig.kimi?.model,
        effort,
        autoApprove: executorConfig.kimi?.autoApprove ?? true,
        initialWorkingDirectory,
        kimiCommand: executorConfig.kimi?.command,
        threadId,
      });

    case 'zcode':
      console.log('[ExecutorFactory] Using official ZCode app-server executor');
      return new ZCodeExecutor(directoryGuard, {
        model: model ?? executorConfig.zcode?.model,
        effort,
        autoApprove: executorConfig.zcode?.autoApprove ?? true,
        initialWorkingDirectory,
        zcodeCommand: executorConfig.zcode?.command,
        threadId,
      });

    case 'pi':
      console.log('[ExecutorFactory] Using Pi RPC executor');
      return new PiExecutor(directoryGuard, {
        model: model ?? executorConfig.pi?.model,
        effort,
        provider: executorConfig.pi?.provider,
        autoApprove: executorConfig.pi?.autoApprove ?? true,
        initialWorkingDirectory,
        piCommand: executorConfig.pi?.command,
        threadId,
      });

    case 'claude-persistent':
      console.log('[ExecutorFactory] Using Claude persistent executor');
      return new ClaudePersistentExecutor(directoryGuard, initialWorkingDirectory, threadId, model);

    case 'claude-spawn':
      console.warn('[ExecutorFactory] Claude spawn mode was removed; using persistent mode.');
      return new ClaudePersistentExecutor(directoryGuard, initialWorkingDirectory, threadId, model);

    case 'auto':
    default:
      console.log('[ExecutorFactory] Using Claude persistent executor (auto)');
      return new ClaudePersistentExecutor(directoryGuard, initialWorkingDirectory, threadId, model);
  }
}

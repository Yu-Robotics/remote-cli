import { randomUUID } from 'crypto';
import { createExecutor } from '../executor';
import type { IExecutor } from '../executor/IExecutor';
import { CodexSandbox } from '../executor/CodexSandbox';
import { ClaudeSandbox } from '../executor/claude/ClaudeSandbox';
import type { DirectoryGuard } from '../security/DirectoryGuard';
import type { Thread } from '../thread/types';
import { resolveThreadModel } from '../thread/ThreadExecutorPool';
import type { ExecutorConfig } from '../types/config';
import type { SettingsBackend } from '../types/Settings';
import type { SettingsCatalog } from './SettingsService';

type Factory = typeof createExecutor;

/** Resolve policy under the real identity before using any synthetic preview ID. */
export function metadataConfiguration(config: ExecutorConfig, guard: DirectoryGuard, threadId: string,
  coordinator: SettingsBackend, target: SettingsBackend): ExecutorConfig {
  const read = (backend: SettingsBackend) => backend === 'codex'
    ? new CodexSandbox(guard, config.codex?.sandbox, threadId).getConfig()
    : backend === 'claude' ? new ClaudeSandbox(guard, config.claude?.sandbox, threadId).getConfig() : undefined;
  const parentPolicy = read(coordinator);
  if ((parentPolicy?.mode === 'workspace-write' || parentPolicy?.mode === 'read-only') && coordinator !== target) {
    throw new Error('Catalog queries for a different backend are unavailable while the coordinator sandbox is enabled.');
  }
  const result: ExecutorConfig = { ...config, type: target === 'claude' ? 'claude-persistent' : target };
  if (target === 'codex') result.codex = { ...config.codex, sandbox: read(target) };
  if (target === 'claude') result.claude = { ...config.claude, sandbox: read(target) };
  return result;
}

export function configuredBackendModel(config: ExecutorConfig, backend: SettingsBackend): string | undefined {
  return (config[backend] as { model?: string } | undefined)?.model;
}

/** Catalog previews never share direct/Worker pointers and never enter ThreadExecutorPool. */
export class SettingsCatalogReader {
  constructor(private readonly guard: DirectoryGuard, private readonly factory: Factory = createExecutor,
    private readonly timeoutMs = 10_000, private readonly cleanupTimeoutMs = 10_000) {}

  async withExecutor<T>(config: ExecutorConfig, thread: Thread, coordinator: SettingsBackend,
    target: SettingsBackend, body: (executor: IExecutor) => Promise<T>, withoutModelOverride = false): Promise<T> {
    const resolved = metadataConfiguration(config, this.guard, thread.id, coordinator, target);
    const id = `settings-meta-${randomUUID()}`;
    const model = withoutModelOverride ? configuredBackendModel(resolved, target) : resolveThreadModel(thread, resolved);
    const executor = this.factory(this.guard, resolved, thread.workingDirectory, id, model,
      thread.efforts?.[target], { lifecycleHooks: false, delegationWorker: true });
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const operation = Promise.resolve().then(() => body(executor));
    void operation.then(() => { settled = true; }, () => { settled = true; });
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The backend settings query timed out.')), this.timeoutMs);
    });
    try { return await Promise.race([operation, expired]); }
    finally {
      if (timer) clearTimeout(timer);
      // Destroy first so pending RPCs cannot outlive pointer cleanup. An uncertain
      // stop retains the preview's own data; it never authorizes parent cleanup.
      let cleanupTimer: NodeJS.Timeout | undefined;
      let exited = false;
      const cleanup = Promise.resolve().then(async () => {
        // Delete only the preview's known native session, before its transport
        // closes. Unsupported native deletion cannot prevent process shutdown.
        if (settled) {
          let releaseTimer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([Promise.resolve().then(() => executor.releaseMetadataSession?.()),
              new Promise<never>((_, reject) => { releaseTimer = setTimeout(() => reject(new Error('Temporary session deletion timed out.')), 2_000); })]);
          } catch { /* Native deletion is best effort. */ }
          finally { if (releaseTimer) clearTimeout(releaseTimer); }
        }
        await executor.destroy();
        await executor.waitForExit?.();
        exited = true;
      });
      // Even after a deadline, delayed RPC settlement and confirmed exit may
      // permit own-pointer cleanup. Never sweep unrelated/uncertain previews.
      let removal: Promise<void> | undefined;
      const removeOwnData = async () => {
        if (exited && settled) await (removal ??= Promise.resolve().then(() => executor.deleteThreadData?.(id)));
      };
      void Promise.all([operation.catch(() => undefined), cleanup]).then(removeOwnData).catch(() => undefined);
      try {
        await Promise.race([
          cleanup,
          new Promise<never>((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('Metadata process exit could not be confirmed. Preview data was retained.')), this.cleanupTimeoutMs); }),
        ]);
      } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
      await removeOwnData();
    }
  }

  async read(config: ExecutorConfig, thread: Thread, coordinator: SettingsBackend,
    target: SettingsBackend, kind: 'model' | 'effort'): Promise<SettingsCatalog> {
    return this.withExecutor(config, thread, coordinator, target, async executor => {
      if (kind === 'model') {
        if (!executor.listModels) throw new Error('This backend does not expose a structured model catalog.');
        const models = await executor.listModels();
        const current = models.find(model => model.isCurrent);
        const reported = executor.getExecutionMetadata?.()?.modelSource === 'reported';
        const configured = resolveThreadModel(thread, { ...config, type: target === 'claude' ? 'claude-persistent' : target })
          ?? configuredBackendModel(config, target);
        return {
          choices: models.map(model => ({ value: model.id, label: model.displayName, description: model.description })),
          effectiveValue: current?.id ?? configured,
          effectiveSource: current ? (reported ? 'native' : 'configured') : configured ? 'configured' : 'unknown',
          defaultValue: models.find(model => model.isDefault)?.id,
          supportsReset: Boolean(executor.clearModel || (configuredBackendModel(config, target) && executor.setModel)),
        };
      }
      if (!executor.listEfforts) throw new Error('This backend does not expose model-specific effort choices.');
      const efforts = await executor.listEfforts();
      const reported = executor.getExecutionMetadata?.()?.effortSource === 'reported';
      return {
        choices: efforts.choices.map(choice => ({ value: choice.value, label: choice.displayName, description: choice.description })),
        effectiveValue: efforts.current, defaultValue: efforts.default,
        effectiveSource: efforts.current ? (reported ? 'native' : 'configured') : 'unknown',
        supportsReset: efforts.supportsReset && typeof executor.setEffort === 'function',
        unavailableReason: efforts.unavailableReason,
      };
    });
  }
}

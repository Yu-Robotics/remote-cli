import type { ExecutorConfig, BackendKey, CodexSandboxConfig, ClaudeSandboxConfig } from '../types/config';
import type { DirectoryGuard } from '../security/DirectoryGuard';
import { CodexSandbox } from '../executor/CodexSandbox';
import { ClaudeSandbox } from '../executor/claude/ClaudeSandbox';
import type { DelegationBackend } from './contract';
import type { BackendAvailability } from './BackendRegistry';

type Policy = CodexSandboxConfig | ClaudeSandboxConfig;
const restricted = (policy?: Policy): boolean => policy?.mode === 'read-only' || policy?.mode === 'workspace-write';

/** Resolve independent workers without weakening the coordinator's sandbox or saved settings. */
export function workerConfiguration(
  config: ExecutorConfig, guard: DirectoryGuard, threadId: string, parent: BackendKey,
  target: DelegationBackend, mode: 'inherit' | 'read_only',
): ExecutorConfig {
  const read = (backend: BackendKey): Policy | undefined => backend === 'codex'
    ? new CodexSandbox(guard, config.codex?.sandbox, threadId).getConfig()
    : backend === 'claude' ? new ClaudeSandbox(guard, config.claude?.sandbox, threadId).getConfig() : undefined;
  const parentPolicy = read(parent);
  // A separate worker identity/worktree needs a scope-aware policy even on the
  // same backend. Do not silently weaken or translate a restricted parent policy.
  if (restricted(parentPolicy)) {
    throw new Error('Managed delegation is unavailable while the coordinator sandbox is enabled; sandbox equivalence is not guaranteed.');
  }
  if (mode === 'read_only') {
    throw new Error('Managed delegation supports inherit mode only. Use inherit and describe any no-write requirement in the objective; an unrestricted coordinator cannot enable a worker sandbox.');
  }
  // A target backend's settings apply when it is the coordinator, not to a
  // temporary worker launched by an unrestricted coordinator.
  const result: ExecutorConfig = { ...config, type: target === 'claude' ? 'claude-persistent' : target };
  if (target === 'codex') {
    result.codex = { ...config.codex, sandbox: { mode: 'danger-full-access' } };
  } else if (target === 'claude') {
    result.claude = { ...config.claude, sandbox: { mode: 'danger-full-access' } };
  }
  return result;
}

/** Keep menu and tool discovery subject to the same admission policy. */
export function workerAvailability(
  config: ExecutorConfig, guard: DirectoryGuard, threadId: string, parent: BackendKey,
  item: BackendAvailability,
): BackendAvailability {
  try { workerConfiguration(config, guard, threadId, parent, item.backend, 'inherit'); }
  catch (error) { return { ...item, worker: false, readOnly: false, reason: (error as Error).message }; }
  // read_only remains recognized by the schema but is unavailable under this policy.
  return { ...item, readOnly: false };
}

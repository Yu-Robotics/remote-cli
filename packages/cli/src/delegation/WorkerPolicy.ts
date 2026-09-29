import type { ExecutorConfig, BackendKey, CodexSandboxConfig, ClaudeSandboxConfig } from '../types/config';
import type { DirectoryGuard } from '../security/DirectoryGuard';
import { CodexSandbox } from '../executor/CodexSandbox';
import { ClaudeSandbox } from '../executor/claude/ClaudeSandbox';
import type { DelegationBackend } from './contract';

type Policy = CodexSandboxConfig | ClaudeSandboxConfig;
const restricted = (policy?: Policy): boolean => policy?.mode === 'read-only' || policy?.mode === 'workspace-write';

/** Resolve cross-backend workers without weakening the coordinator's sandbox or saved settings. */
export function workerConfiguration(
  config: ExecutorConfig, guard: DirectoryGuard, threadId: string, parent: BackendKey,
  target: DelegationBackend, mode: 'inherit' | 'read_only',
): ExecutorConfig {
  if (parent === target) {
    throw new Error('Same-backend delegation is disabled. Use the current backend directly or its native subagents, if supported.');
  }
  const read = (backend: BackendKey): Policy | undefined => backend === 'codex'
    ? new CodexSandbox(guard, config.codex?.sandbox, threadId).getConfig()
    : backend === 'claude' ? new ClaudeSandbox(guard, config.claude?.sandbox, threadId).getConfig() : undefined;
  const parentPolicy = read(parent);
  // Native policies have different enforcement semantics. Do not silently translate
  // a restricted parent into another backend's weaker or differently scoped policy.
  if (restricted(parentPolicy)) {
    throw new Error('Cross-backend delegation is unavailable while the coordinator sandbox is enabled; sandbox equivalence is not guaranteed.');
  }
  if (mode === 'read_only') {
    throw new Error('Cross-backend delegation supports inherit mode only. Use inherit and describe any no-write requirement in the objective; an unrestricted coordinator cannot enable a worker sandbox.');
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

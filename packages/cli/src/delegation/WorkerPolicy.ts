import type { ExecutorConfig, BackendKey, CodexSandboxConfig, ClaudeSandboxConfig } from '../types/config';
import type { DirectoryGuard } from '../security/DirectoryGuard';
import { CodexSandbox } from '../executor/CodexSandbox';
import { ClaudeSandbox } from '../executor/claude/ClaudeSandbox';
import type { DelegationBackend } from './contract';

type Policy = CodexSandboxConfig | ClaudeSandboxConfig;
const restricted = (policy?: Policy): boolean => policy?.mode === 'read-only' || policy?.mode === 'workspace-write';

/** Inherit the coordinator's effective sandbox without changing saved backend settings. */
export function workerConfiguration(
  config: ExecutorConfig, guard: DirectoryGuard, threadId: string, parent: BackendKey,
  target: DelegationBackend, mode: 'inherit' | 'read_only',
): ExecutorConfig {
  const read = (backend: BackendKey): Policy | undefined => backend === 'codex'
    ? new CodexSandbox(guard, config.codex?.sandbox, threadId).getConfig()
    : backend === 'claude' ? new ClaudeSandbox(guard, config.claude?.sandbox, threadId).getConfig() : undefined;
  const parentPolicy = read(parent);
  const parentRestricted = restricted(parentPolicy);
  if (mode === 'read_only' && !parentRestricted) {
    throw new Error('An unrestricted coordinator cannot enable a worker sandbox. Use inherit and describe any no-write requirement in the objective; read_only requires a sandboxed coordinator.');
  }
  if (parentRestricted && target !== 'claude' && target !== 'codex') {
    throw new Error(`${target} cannot enforce the required sandbox policy. Select the same backend as the sandboxed coordinator.`);
  }
  // Native policies have different enforcement semantics. Do not silently translate
  // a restricted parent into another backend's weaker or differently scoped policy.
  if (parentRestricted && parent !== target) {
    throw new Error('A sandboxed coordinator can delegate only to the same backend in this release; cross-backend sandbox equivalence is not guaranteed.');
  }
  // A target backend's settings apply when it is the coordinator, not to a
  // temporary worker launched by an unrestricted coordinator.
  const inheritedPolicy: Policy = parentRestricted ? parentPolicy! : { mode: 'danger-full-access' };
  const result: ExecutorConfig = { ...config, type: target === 'claude' ? 'claude-persistent' : target };
  if (target === 'codex') {
    result.codex = { ...config.codex, sandbox: mode === 'read_only'
      ? { ...inheritedPolicy, mode: 'read-only', writableRoots: [], developmentDirectories: false }
      : inheritedPolicy as CodexSandboxConfig };
  } else if (target === 'claude') {
    result.claude = { ...config.claude, sandbox: mode === 'read_only'
      ? { ...inheritedPolicy, mode: 'read-only', writableRoots: [] }
      : inheritedPolicy };
  }
  return result;
}

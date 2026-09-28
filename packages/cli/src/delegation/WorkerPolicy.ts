import type { ExecutorConfig, BackendKey, CodexSandboxConfig, ClaudeSandboxConfig } from '../types/config';
import type { DirectoryGuard } from '../security/DirectoryGuard';
import { CodexSandbox } from '../executor/CodexSandbox';
import { ClaudeSandbox } from '../executor/claude/ClaudeSandbox';
import type { DelegationBackend } from './contract';

type Policy = CodexSandboxConfig | ClaudeSandboxConfig;
const restricted = (policy?: Policy): boolean => policy?.mode === 'read-only' || policy?.mode === 'workspace-write';

/** Resolve saved authorization using the real thread before creating a child session ID. */
export function workerConfiguration(
  config: ExecutorConfig, guard: DirectoryGuard, threadId: string, parent: BackendKey,
  target: DelegationBackend, mode: 'inherit' | 'read_only',
): ExecutorConfig {
  const read = (backend: BackendKey): Policy | undefined => backend === 'codex'
    ? new CodexSandbox(guard, config.codex?.sandbox, threadId).getConfig()
    : backend === 'claude' ? new ClaudeSandbox(guard, config.claude?.sandbox, threadId).getConfig() : undefined;
  const parentPolicy = read(parent);
  const targetPolicy = target === parent ? parentPolicy : read(target);
  if (target !== 'claude' && target !== 'codex' && (mode === 'read_only' || restricted(parentPolicy))) {
    throw new Error(`${target} cannot enforce the required sandbox policy. Select Claude or Codex, or use an unrestricted parent thread.`);
  }
  // Native policies have different enforcement semantics. Do not silently translate
  // a restricted parent into another backend's weaker or differently scoped policy.
  if (restricted(parentPolicy) && parent !== target) {
    throw new Error('A sandboxed coordinator can delegate only to the same backend in this release; cross-backend sandbox equivalence is not guaranteed.');
  }
  const result: ExecutorConfig = { ...config, type: target === 'claude' ? 'claude-persistent' : target };
  if (target === 'codex') {
    result.codex = { ...config.codex, sandbox: mode === 'read_only'
      ? { ...targetPolicy, mode: 'read-only', writableRoots: [], developmentDirectories: false }
      : targetPolicy as CodexSandboxConfig | undefined };
  } else if (target === 'claude') {
    result.claude = { ...config.claude, sandbox: mode === 'read_only'
      ? { ...targetPolicy, mode: 'read-only', writableRoots: [] }
      : targetPolicy };
  }
  return result;
}

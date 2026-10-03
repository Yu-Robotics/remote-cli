import { backendKeyOf, type BackendKey, type ExecutorConfig } from '../types/config';

type PlainBackend = Exclude<BackendKey | ExecutorConfig['type'], 'zcode'>;

export function getBackendCommand(type: PlainBackend, config?: ExecutorConfig): string;
export function getBackendCommand(type: string, config?: ExecutorConfig): string | undefined;
/** Preserve ZCode's native handling of absent/empty overrides and bundled lookup. */
export function getBackendCommand(type: string, config?: ExecutorConfig): string | undefined {
  const key = backendKeyOf(type);
  return config?.[key]?.command ?? (key === 'zcode' ? undefined : key);
}

/** Safe probe diagnostics never expose the executable path or raw stderr. */
export function backendProbeFailure(error: unknown): string {
  const failure = error as { code?: string | number; killed?: boolean } | null;
  if (failure?.code === 'ENOENT') return 'Command could not start; the executable, interpreter, or working directory may be missing.';
  if (failure?.code === 'EACCES' || failure?.code === 'EPERM') return 'Command could not start because permission was denied.';
  if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Version probe output exceeded its limit.';
  if (failure?.code === 'ETIMEDOUT' || failure?.killed) return 'Version probe timed out or was interrupted.';
  if (typeof failure?.code === 'number') return 'Version probe exited unsuccessfully.';
  return 'Version probe failed.';
}

import { AgyHookOwnershipError } from '../../scheduling/agy/AgyHookOwnership';
export type AgyAcpStartupStage = 'startup' | 'native-helper' | 'hooks' | 'process'
  | 'initialize' | 'session-create' | 'session-load' | 'session-settings' | 'session-save' | 'host-admission' | 'cleanup';

/** Only fixed categories and known codes may leave a native startup failure. */
export function describeAgyAcpFailure(error: unknown, stage: AgyAcpStartupStage = 'startup'): string {
  if (error instanceof AgyAcpStartupError) return error.message;
  const message = error instanceof Error ? error.message.slice(0, 4096) : '';
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const rpc = /ACP error (-\d+):/.exec(message)?.[1];
  let reason = 'initialization-failed';
  if (/authentication required|not logged in|authentication failed/i.test(message)) reason = 'authentication-required';
  else if (/flags provided but not defined|unknown flag/i.test(message)) reason = 'unsupported-argument';
  else if (/unknown model|unknown config option|thinking level|selection could not be confirmed|setting.*(?:unavailable|unsupported|confirm|mismatch)/i.test(message)) reason = 'unsupported-setting';
  else if (/timed out|timeout/i.test(message)) reason = 'timeout';
  else if (/native.*(?:support|helper).*unavailable|helper.*unavailable/i.test(message)) reason = 'native-helper-unavailable';
  else if (code === 'ENOENT') reason = 'process-not-found';
  else if (code === 'EACCES' || code === 'EPERM') reason = 'permission-denied';
  else if (/ACP process exited/i.test(message)) reason = 'process-exited';
  const details = [`stage=${stage}`, `reason=${reason}`];
  if (rpc && ['-32700', '-32600', '-32601', '-32602', '-32603', '-32000'].includes(rpc)) details.push(`rpc=${rpc}`);
  if (['ENOENT', 'EACCES', 'EPERM', 'EADDRINUSE'].includes(code)) details.push(`system=${code}`);
  return `AGY ACP startup failed (${details.join(', ')}).`;
}

/** Do not retain a raw cause: callers may print the entire Error object. */
export class AgyAcpStartupError extends Error {
  constructor(stage: AgyAcpStartupStage, error: unknown, cleanup?: unknown) {
    super(error instanceof AgyHookOwnershipError ? error.message : describeAgyAcpFailure(error, stage)
      + ' Verify AGY 1.5.10 or newer and the remote-cli native helper for your platform. No legacy transport fallback is available.'
      + (cleanup === undefined ? '' : ` ${describeAgyAcpFailure(cleanup, 'cleanup')}`));
    this.name = 'AgyAcpStartupError';
  }
}

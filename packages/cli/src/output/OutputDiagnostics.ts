import { createHash } from 'crypto';

export type OutputFailureReason = 'missing' | 'policy' | 'limit' | 'quota' | 'changed' | 'permission' | 'storage' | 'unknown';
const messages: Record<string, OutputFailureReason> = {
  'Output export policy denied this file.': 'policy', 'Application state cannot be exported.': 'policy',
  'Credential and native session roots cannot be exported.': 'policy', 'Output is outside the authorized workspace.': 'policy',
  'Output exceeds the configured limit.': 'limit', 'Output file is unavailable or exceeds the limit.': 'limit',
  'Output snapshot quota reached.': 'quota', 'Output changed during snapshot.': 'changed', 'Verified export changed.': 'changed',
  'Output capture stopped.': 'storage', 'Output expired.': 'missing',
};
/** Never serialize exception text, filenames, paths, content, or raw request identities. */
export class OutputDiagnostics {
  private remaining = 16;
  constructor(private readonly report: (value: object) => void = value => console.error('[OutputFiles]', JSON.stringify(value))) {}
  failure(request: string, candidate: string, error: unknown): void {
    if (this.remaining <= 0) return;
    this.remaining--;
    const value = error as { code?: unknown; message?: unknown } | undefined;
    const reason: OutputFailureReason = value?.code === 'ENOENT' ? 'missing'
      : value?.code === 'EACCES' || value?.code === 'EPERM' ? 'permission'
      : typeof value?.message === 'string' ? Object.prototype.hasOwnProperty.call(messages, value.message) ? messages[value.message] : 'unknown' : 'unknown';
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    try { this.report({ event: 'attachment_preparation_failed', reason, requestHash: hash(request), pathHash: hash(candidate) }); }
    catch { /* Diagnostics cannot affect task execution. */ }
  }
}

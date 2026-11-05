import { createHash } from 'crypto';

/** Match the Router without new wire fields; never fingerprint task text. */
export function taskCorrelation(id: unknown): string | undefined {
  try {
    return typeof id === 'string' && id.length <= 512
      ? createHash('sha256').update('remote-cli-task-v1:').update(id).digest('hex').slice(0, 24) : undefined;
  } catch { return undefined; }
}

/** Only fixed event names and allowlisted metadata belong here. */
export function taskEvent(event: string, fields: Record<string, unknown> = {}): void {
  try { console.info('[TaskDiagnostics]', { event, ...fields }); } catch { /* Logging cannot interrupt transport. */ }
}

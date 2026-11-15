import { createHash } from 'node:crypto';
import type { ScheduleOwner, ScheduleRecord, ScheduleRule } from './types';

export type CleanupReason = 'native_absence_unknown' | 'predecessor_unknown' | 'unattributed';
/** Deletion-only selector. No prompt, output, execution options or recovery permission. */
export interface ScheduleCleanupRecord extends ScheduleOwner {
  id: string;
  historyRemoved: true;
  backend: ScheduleRecord['backend'];
  cwd: string;
  nativeId?: string;
  reason: CleanupReason;
  attribution?: { sessionId: string; marker?: string; promptHash: string; rule: ScheduleRule };
}
export function cleanupDetail(reason: CleanupReason): string {
  if (reason === 'unattributed') return 'History removed; native cleanup unresolved: original session/definition attribution is missing. Review native tasks in the original bound session and delete exact selected definitions. No account/session search or global absence is implied.';
  if (reason === 'predecessor_unknown') return 'History removed; native cleanup unresolved: predecessor or admitted work is unconfirmed. Retry these managed IDs after framework retirement proof becomes available.';
  return 'History removed; native cleanup unresolved: exact native absence is unconfirmed. Retry these managed IDs in the original bound session or use native cleanup review/delete.';
}
export function promptHash(prompt: string): string { return createHash('sha256').update(prompt).digest('hex'); }

export function cleanupRecord(record: ScheduleRecord, reason: CleanupReason): ScheduleCleanupRecord {
  const result: ScheduleCleanupRecord = { id: record.id, threadId: record.threadId, openId: record.openId,
    generation: record.generation, backend: record.backend, cwd: record.cwd, historyRemoved: true, reason,
    ...(record.nativeId ? { nativeId: record.nativeId } : {}) };
  // Do not carry opaque provider JSON into the deletion ledger. Only supported
  // session selectors are retained, with an irreversible exact prompt digest.
  try {
    const identity = JSON.parse(record.recovery?.identity ?? 'null');
    const provider = record.backend === 'claude' ? 'claude-session-skip-unadmitted-v1' : 'dsh-session-orderly-v1';
    if (record.recovery?.provider === provider && record.recovery.strategy === 'reconstruct'
      && identity?.threadId === record.threadId && identity.cwd === record.cwd
      && typeof identity.sessionId === 'string' && identity.sessionId.length > 0 && identity.sessionId.length <= 256
      && !/[\x00-\x1f\x7f]/.test(identity.sessionId)
      && (record.backend !== 'claude' || /^[a-f0-9-]{36}$/.test(identity.marker ?? ''))) {
      result.attribution = { sessionId: identity.sessionId, promptHash: promptHash(record.prompt), rule: structuredClone(record.rule),
        ...(record.backend === 'claude' ? { marker: identity.marker } : {}) };
    }
  } catch { /* Missing or malformed legacy attribution is not invented. */ }
  return result;
}

export function cleanupSummary(record: ScheduleCleanupRecord) {
  return { id: record.id, backend: record.backend, historyRemoved: true as const, reason: record.reason,
    detail: cleanupDetail(record.reason), ...(record.nativeId ? { nativeId: record.nativeId } : {}),
    ...(record.attribution ? { sessionId: record.attribution.sessionId } : {}) };
}
export type ScheduleCleanupSummary = ReturnType<typeof cleanupSummary>;

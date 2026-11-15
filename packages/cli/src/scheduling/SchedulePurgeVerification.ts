import { cleanupInventory, type NativeCleanupSession } from './ReviewedNativeCleanup';
import type { SchedulePurgeEvidence } from './ScheduleService';
import type { ScheduleRecord } from './types';

/** Called only inside the framework's bound native cleanup lease. An empty
 * inventory is useful only with original session attribution and retirement. */
export async function verifySchedulePurge<T>(record: Readonly<ScheduleRecord>, host: NativeCleanupSession | undefined,
  current: () => boolean, accept: (evidence: SchedulePurgeEvidence) => Promise<T>): Promise<T> {
  const unresolved = (reason: 'unattributed' | 'predecessor_unknown' | 'native_absence_unknown', detail: string) =>
    accept({ status: 'unresolved', reason, detail });
  if (!record.recovery || !record.nativeId) return unresolved('unattributed',
    'Original native session/definition attribution is missing. Review and delete selected native definitions in the original bound session; an empty different session cannot retire this history. Cancellation intent remains saved.');
  if (record.backend !== 'claude') return unresolved('predecessor_unknown',
    'This backend requires its original live cancellation handle or a saved confirmed cleanup/clean-handoff receipt. Current-session inventory cannot prove predecessor retirement.');
  let identity: { marker?: string; sessionId?: string; cwd?: string; threadId?: string };
  try { identity = JSON.parse(record.recovery.identity); }
  catch { return unresolved('unattributed', 'Original native session attribution is invalid. Preserve the original session for cleanup review.'); }
  if (!identity || !/^[a-f0-9-]{36}$/.test(identity.marker ?? '') || !identity.sessionId
    || identity.threadId !== record.threadId || identity.cwd !== record.cwd
    || record.recovery.provider !== 'claude-session-skip-unadmitted-v1' || record.recovery.strategy !== 'reconstruct') {
    return unresolved('unattributed', 'Original native definition attribution is incomplete or incompatible; no history was erased.');
  }
  if (!host || identity.sessionId !== host.sessionId || record.cwd !== host.cwd) return unresolved('unattributed',
    'Select the original Claude thread/session and working directory, then retry these managed IDs. No other native sessions are searched.');
  const valid = () => current() && host.current() && host.sessionId === identity.sessionId && host.cwd === record.cwd;
  if (!valid()) throw new Error('Schedule purge native context changed before inventory.');
  const entries = cleanupInventory({ jobs: await host.inventory() });
  if (!valid()) throw new Error('Schedule purge native context changed during inventory.');
  const marker = `[remote-cli:${identity.marker}]`;
  if (entries.some(entry => entry.id === record.nativeId || entry.prompt.includes(marker))) return unresolved('native_absence_unknown',
    'The original native ID or marker is still present. Use cleanup review/delete for the exact definition, then retry these managed IDs; siblings are never swept.');
  if (!host.retirementConfirmed?.()) return unresolved('predecessor_unknown',
    'Fresh original-session inventory confirms definition absence, but predecessor or admitted work is unconfirmed. Cancellation intent is saved; history remains until framework retirement proof is available.');
  return accept({ status: 'verified', isCurrent: () => valid() && host.retirementConfirmed?.() === true });
}

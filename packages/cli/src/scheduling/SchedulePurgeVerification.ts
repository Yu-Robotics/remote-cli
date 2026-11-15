import { promptHash, type ScheduleCleanupRecord } from './ScheduleCleanup';
import { cleanupCanonical, cleanupInventory, type NativeCleanupSession } from './ReviewedNativeCleanup';
import type { SchedulePurgeEvidence } from './ScheduleService';
import type { ScheduleRecord } from './types';

/** Called only inside the framework's bound native cleanup lease. An empty
 * inventory is useful only with original session attribution and retirement. */
export async function verifySchedulePurge<T>(record: Readonly<ScheduleRecord | ScheduleCleanupRecord>, host: NativeCleanupSession | undefined,
  current: () => boolean, accept: (evidence: SchedulePurgeEvidence) => Promise<T>): Promise<T> {
  const unresolved = (reason: 'unattributed' | 'predecessor_unknown' | 'native_absence_unknown', detail: string) =>
    accept(host?.mutationPending?.() ? { status: 'unresolved', reason: 'operation_pending', detail: 'A native mutation receipt is unsettled; retry after reconciliation.' } : { status: 'unresolved', reason, detail });
  if (host?.mutationPending?.()) return unresolved('native_absence_unknown', 'Native mutation pending.');
  if ('historyRemoved' in record) return verifyCleanup(record, host, current, accept);
  if (!record.recovery || !record.nativeId) return unresolved('unattributed',
    'Original native session/definition attribution is missing. Review and delete selected native definitions in the original bound session; an empty different session cannot prove native absence.');
  if (record.backend !== 'claude') return unresolved('predecessor_unknown',
    'This backend requires its original live cancellation handle or a saved confirmed cleanup/clean-handoff receipt. Current-session inventory cannot prove predecessor retirement.');
  let identity: { marker?: string; sessionId?: string; cwd?: string; threadId?: string };
  try { identity = JSON.parse(record.recovery.identity); }
  catch { return unresolved('unattributed', 'Original native session attribution is invalid. Preserve the original session for cleanup review.'); }
  if (!identity || !/^[a-f0-9-]{36}$/.test(identity.marker ?? '') || !identity.sessionId
    || identity.threadId !== record.threadId || identity.cwd !== record.cwd
    || record.recovery.provider !== 'claude-session-skip-unadmitted-v1' || record.recovery.strategy !== 'reconstruct') {
    return unresolved('unattributed', 'Original native definition attribution is incomplete or incompatible; native absence remains unknown.');
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
    'Fresh original-session inventory confirms definition absence, but predecessor or admitted work is unconfirmed. Cancellation intent is saved; native cleanup remains unresolved until framework retirement proof is available.');
  return accept({ status: 'verified', isCurrent: () => valid() && !host.mutationPending?.() && host.retirementConfirmed?.() === true });
}

/** A digest preserves exact deletion attribution after user text has been erased.
 * This callback has no execution or recovery path and never searches sessions. */
async function verifyCleanup<T>(record: Readonly<ScheduleCleanupRecord>, host: NativeCleanupSession | undefined,
  current: () => boolean, accept: (evidence: SchedulePurgeEvidence) => Promise<T>): Promise<T> {
  const unresolved = (reason: 'unattributed' | 'predecessor_unknown' | 'native_absence_unknown') =>
    accept({ status: 'unresolved', reason, detail: 'History is already removed; native cleanup remains unresolved.' });
  const a = record.attribution;
  if (!a || !record.nativeId) return unresolved('unattributed');
  if (record.backend !== 'claude') return unresolved('predecessor_unknown');
  if (!host || host.sessionId !== a.sessionId || host.cwd !== record.cwd) return unresolved('unattributed');
  const valid = () => current() && host.current() && host.sessionId === a.sessionId && host.cwd === record.cwd;
  const inventory = async () => {
    if (!valid()) throw new Error('Schedule cleanup context changed before inventory.');
    const entries = cleanupInventory({ jobs: await host.inventory() });
    if (!valid()) throw new Error('Schedule cleanup context changed during inventory.');
    return entries;
  };
  const marker = `[remote-cli:${a.marker}]`;
  const entries = await inventory();
  const identity = (rows: typeof entries) => cleanupCanonical(rows.map(({ nextFireAt: _forecast, ...definition }) => definition));
  const matches = entries.filter(entry => entry.id === record.nativeId || entry.prompt.includes(marker));
  if (matches.length) {
    const target = matches[0];
    const prefix = marker + '\n';
    // One-shot cron uses the native host timezone, which legacy catalogs did
    // not record. Preserve its selector, but require fresh reviewed deletion.
    if (a.rule.kind !== 'cron') return unresolved('native_absence_unknown');
    if (matches.length !== 1 || target.id !== record.nativeId || target.durable !== false
      || !target.prompt.startsWith(prefix) || promptHash(target.prompt.slice(prefix.length)) !== a.promptHash
      || (target.recurring ?? false) !== true || target.cron !== a.rule.expression.trim().split(/\s+/).join(' ')) return unresolved('native_absence_unknown');
    // Compare complete fresh inventories, including siblings, before and after
    // exact deletion. Advancing timer forecasts do not change definitions.
    if (identity(await inventory()) !== identity(entries)) return unresolved('native_absence_unknown');
    try { await host.remove(target); }
    catch { /* Reconcile an ambiguous receipt only through authoritative absence. */ }
    const after = await inventory();
    if (identity(after) !== identity(entries.filter(entry => entry.id !== target.id))) return unresolved('native_absence_unknown');
  }
  if (!host.retirementConfirmed?.()) return unresolved('predecessor_unknown');
  return accept({ status: 'verified', isCurrent: () => valid() && !host.mutationPending?.() && host.retirementConfirmed?.() === true });
}

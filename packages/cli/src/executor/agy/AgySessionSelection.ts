import fs from 'fs';
import path from 'path';
import os from 'os';
import { isWorkerLaneExecutorId, type DelegatedWorkerLane } from '../../delegation/DelegatedWorkerSessionStore';
import { createHash } from 'crypto';
import { syncDirectory } from '../../delegation/OwnershipRuntime';

export const agyOwnershipReview = 'Keep this thread and ask the device operator to inspect AGY ownership. Use /thread list to choose another thread if needed.';
export const agySavedSelectionDeletion = 'AGY ACP host retirement is unconfirmed. To delete the thread, run /clear in the target thread to reset its conversation and archive its AGY selection, then retry /thread delete <name>.';

/** Preflight for an explicit pointer reset, including when AGY is inactive.
 * Missing ownership is never permission to resume or erase native history. */
function present(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Bind a clean exit to the original SQLite files and hook transcript. A changed
 * or redirected native store cannot inherit the previous process's proof. */
export function agyHostScheduleHistory(home: string, session: string, beforeFirstPrompt = false): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(session)) throw new Error('Invalid AGY checkpoint session.');
  const root = path.join(fs.realpathSync(home), '.gemini', 'antigravity-cli');
  const database = path.join(root, 'conversations', session + '.db');
  const transcript = path.join(root, 'brain', session, '.system_generated', 'logs', 'transcript_full.jsonl');
  const fingerprint = createHash('sha256');
  for (const file of [database, transcript, database + '-wal', database + '-shm', database + '-journal']) {
    if (file !== database && (file !== transcript || beforeFirstPrompt) && !present(file)) { fingerprint.update('absent\n'); continue; }
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || fs.realpathSync(file) !== file) throw new Error('AGY checkpoint history is redirected.');
    if (beforeFirstPrompt && file === transcript && stat.size !== 0n) throw new Error('AGY settings-only session already has a transcript.');
    fingerprint.update([stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join('/') + '\n');
  }
  return fingerprint.digest('hex');
}
export function assertAgySelectionResettable(pointer: string): void {
  if (present(pointer + '.allocation-unconfirmed')) throw new Error('AGY allocation ownership is unconfirmed; retained evidence cannot be discarded.');
  if (present(pointer + '.checkpoint.lock')) throw new Error('AGY checkpoint transition is unconfirmed; retained state cannot be discarded.');
  if (present(pointer + '.native-schedules')) throw new Error('AGY native schedule ownership remains; keep the original selection and use a new thread.');
}

/** Archive an unconfirmed ACP selection before unlinking it. Returns false for
 * legacy or absent pointers. Never edits native history or starts a process. */
export function detachAgySelection(pointer: string): boolean {
  assertAgySelectionResettable(pointer);
  let session: { id?: unknown; transport?: unknown };
  try { session = JSON.parse(fs.readFileSync(pointer, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (session.transport !== 'acp') return false;
  if (typeof session.id !== 'string' || !session.id) throw new Error('Invalid saved AGY ACP selection; state was retained.');
  const archive = pointer + '.detached-acp';
  fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(session.id).digest('hex');
  const file = path.join(archive, key + '.json'), temporary = file + '.tmp';
  const evidence = { session, retirement: 'unconfirmed',
    ...(fs.existsSync(pointer + '.checkpoint') ? { legacyCheckpoint: fs.readFileSync(pointer + '.checkpoint', 'utf8') } : {}) };
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(evidence)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  syncDirectory(archive); syncDirectory(path.dirname(archive));
  // A crash before unlink retains the refused pointer; afterwards the archive
  // keeps the unresolved data-erasure obligation across fresh sessions/restarts.
  fs.unlinkSync(pointer); syncDirectory(path.dirname(pointer));
  return true;
}

/** Card reset shares the main AGY ownership preflight. It is a pointer reset,
 * not native data erasure or discharge of an unidentified allocation. */
export function assertAgyWorkerSelectionResettable(pointer: string): void {
  try { assertAgySelectionResettable(pointer); }
  catch {
    // Use the existing card handler's safe, actionable error category. No path
    // or native identifier from storage is forwarded to the remote caller.
    throw new Error('The Worker context has changed. AGY allocation or schedule ownership is unconfirmed; Clear did not discard it. Preserve this lane and use a new thread or worker lane.');
  }
}

/** Parent thread deletion removes the whole lane HOME. A worker archive cannot
 * use the main thread's storage-preserving deletion path. */
export function assertAgyWorkerLaneDeletable(lane: DelegatedWorkerLane): void {
  if (!isWorkerLaneExecutorId(lane.executorThreadId)) throw new Error('Invalid AGY worker lane identity.');
  if (lane.nativeHistoryExitUnconfirmed || lane.nativeMaintenanceExitUnconfirmed || lane.nativeSessionConflict) {
    throw new Error('AGY worker history ownership is unconfirmed.');
  }
  for (const home of new Set([process.env.HOME, os.homedir()])) {
    if (!home) continue;
    const pointer = path.join(home, '.remote-cli', 'agy-sessions', lane.executorThreadId + '.json');
    assertAgySelectionResettable(pointer);
    if (present(pointer + '.detached-acp')) throw new Error('Detached AGY worker history must be retained.');
    if (!present(pointer)) continue;
    const stat = fs.lstatSync(pointer);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error('Unsafe AGY worker selection.');
    const session = JSON.parse(fs.readFileSync(pointer, 'utf8'));
    if (session.transport === 'acp' && (lane.nativeGroupExitGeneration !== (lane.contextGeneration ?? 0)
      || lane.nativeSession?.backend !== 'agy' || lane.nativeSession.sessionId !== session.id
      || lane.nativeSession.executorThreadId !== lane.executorThreadId || lane.nativeSession.pointer !== pointer)) {
      throw new Error('AGY worker selection ownership or process-group exit is unconfirmed.');
    }
  }
}

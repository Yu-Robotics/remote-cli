import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { syncDirectory } from '../../delegation/OwnershipRuntime';

/** Preflight for an explicit pointer reset, including when AGY is inactive.
 * Missing ownership is never permission to resume or erase native history. */
export function assertAgySelectionResettable(pointer: string): void {
  if (fs.existsSync(pointer + '.checkpoint.lock')) throw new Error('AGY checkpoint transition is unconfirmed; retained state cannot be discarded.');
  if (fs.existsSync(pointer + '.native-schedules')) throw new Error('AGY native schedule ownership remains; keep the original selection and use a new thread.');
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

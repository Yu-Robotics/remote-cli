import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { replaceAtomicFile } from '../delegation/AtomicFile';
import { kernelGate, syncDirectory } from '../delegation/OwnershipRuntime';

export class DamagedCatalog extends Error {}
export class UnreadableCatalog extends Error {}

/** Serialize read/modify/write and repair across CLI processes. */
export async function withCatalogLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5000;
  let lock = kernelGate(file + '.lock');
  while (!lock) {
    if (Date.now() >= deadline) throw new Error('Catalog is busy; retry the operation.');
    await delay(15);
    lock = kernelGate(file + '.lock');
  }
  try { return await action(); } finally { lock.close(); }
}

async function identity(file: string): Promise<string> {
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n) throw new Error('Unsafe catalog file identity.');
  return stat.ino && stat.birthtimeNs > 0n ? [path.basename(file), stat.dev, stat.ino, stat.birthtimeNs].join('/') : '';
}

async function replace(file: string, bytes: Buffer | string): Promise<void> {
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await replaceAtomicFile(temporary, file);
    syncDirectory(path.dirname(file));
  } finally { await fs.rm(temporary, { force: true }); }
}

function checksum(id: string, data: string): string {
  return createHash('sha256').update(JSON.stringify([id, data])).digest('hex');
}

/** Back up the committed inode. An old mirror cannot roll back a later atomic replacement. */
export async function writeCatalog(file: string, data: string): Promise<void> {
  await replace(file, data);
  const id = await identity(file);
  if (id) {
    try { await replace(file + '.bak', JSON.stringify({ id, data, checksum: checksum(id, data) })); }
    catch { console.warn('[Catalog] Saved the catalog, but could not refresh its recovery copy.'); }
  }
}

/** The caller holds the file lock. Only a content failure is eligible for recovery. */
export async function readCatalog<T>(file: string, parse: (text: string) => T,
  snapshotData = (_parsed: T, original: string) => original): Promise<T | undefined> {
  let id: string;
  try { id = await identity(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { await fs.lstat(file + '.bak'); }
    catch (backupError) { if ((backupError as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw backupError; }
    throw new DamagedCatalog(`Missing ${path.basename(file)}; its recovery copy cannot establish the missing file's identity.`);
  }
  let original: Buffer;
  try { original = await fs.readFile(file); }
  catch (error) {
    if (['EACCES', 'EPERM', 'EIO'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw new UnreadableCatalog(`Unable to read ${path.basename(file)}; retry when storage is available.`, { cause: error });
    }
    throw error;
  }
  const text = original.toString('utf8');
  let parsed: T | undefined;
  try {
    if (!Buffer.from(text).equals(original)) throw new DamagedCatalog();
    parsed = parse(text);
  }
  catch (error) { if (!(error instanceof SyntaxError || error instanceof DamagedCatalog)) throw error; }

  if (parsed !== undefined) {
    if (id) {
      const data = snapshotData(parsed, text);
      const snapshot = JSON.stringify({ id, data, checksum: checksum(id, data) });
      let saved: string | undefined;
      try { await identity(file + '.bak'); saved = await fs.readFile(file + '.bak', 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // Include older installations and valid external edits observed on startup.
      if (saved !== snapshot) await replace(file + '.bak', snapshot);
    }
    return parsed;
  }

  let data: string;
  let recovered: T;
  try {
    await identity(file + '.bak');
    const backup = JSON.parse(await fs.readFile(file + '.bak', 'utf8'));
    if (!id || backup?.id !== id || typeof backup.data !== 'string' || backup.checksum !== checksum(id, backup.data)) {
      throw new DamagedCatalog();
    }
    data = backup.data;
    recovered = parse(data);
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof DamagedCatalog || (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
    throw new DamagedCatalog(`Damaged ${path.basename(file)}; restore a verified backup. The original file was preserved.`);
  }
  if (await identity(file) !== id || !(await fs.readFile(file)).equals(original)) {
    throw new Error('Catalog changed during recovery; retry startup.');
  }
  await replace(file + '.damaged-' + randomUUID(), original);
  await writeCatalog(file, snapshotData(recovered, data));
  return recovered;
}

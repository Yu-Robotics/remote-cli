import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { privateDirectory } from '../files/FileIO';

/** External intents are admitted only after file sync and atomic replacement. */
export async function durableJson(filename: string, value: unknown, check = () => {}): Promise<void> {
  check();
  await privateDirectory(path.dirname(filename));
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    check();
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value)); await handle.sync();
    await handle.close(); handle = undefined;
    for (let attempt = 0; ; attempt++) {
      check();
      try { await fs.rename(temporary, filename); break; }
      catch (error: any) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
    check(); await syncDirectory(path.dirname(filename)); check();
  } finally { await handle?.close(); check(); await fs.rm(temporary, { force: true }); }
}
export async function syncDirectory(directory: string): Promise<void> {
  // Windows Node cannot open directory handles for FlushFileBuffers; file sync is required on every host.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

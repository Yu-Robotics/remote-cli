import fs from 'fs/promises';
import { setTimeout as delay } from 'timers/promises';

/** Retry transient Windows sharing violations without unlinking the old durable record. */
export async function replaceAtomicFile(temporary: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temporary, target); return; }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= 5
        || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await delay(10 * 2 ** attempt);
    }
  }
}

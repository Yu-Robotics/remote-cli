import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

/** Small private, atomic state file. Invalid data fails closed, never erases a ledger. */
export class PrivateStore<T> {
  private writes = Promise.resolve();
  constructor(private readonly filename: string, private readonly validate: (value: unknown) => value is T) {}

  async read(): Promise<T | undefined> {
    try {
      const stat = await fs.lstat(this.filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsafe maintenance state.');
      const value = JSON.parse(await fs.readFile(this.filename, 'utf8'));
      if (!this.validate(value)) throw new Error('Invalid maintenance state.');
      return value;
    } catch (error: any) {
      if (error.code === 'ENOENT') return;
      throw new Error('Maintenance state could not be read.');
    }
  }

  write(value: T): Promise<void> {
    const operation = this.writes.then(async () => {
      if (!this.validate(value) || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new Error('Invalid maintenance state.');
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, this.filename);
      } finally { await fs.rm(temporary, { force: true }); }
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
}

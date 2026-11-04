import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { replaceAtomicFile } from './AtomicFile';
import { syncDirectory } from './OwnershipRuntime';
import { historyDirectory, historyIdentity } from './NativeHistoryFiles';
import { createDshHistoryScope, dshHistoryPatch, captureDshDeletionTarget, validDshHistoryScope,
  type DshHistoryScope, type DshDeletionTarget } from './DshSessionDeletion';

/** A separate binding avoids polluting native session-pointer inventories. */
export class DshManagedHistory {
  private scope?: DshHistoryScope;
  patch = '';
  constructor(private readonly home: string, private readonly executorThreadId: string,
    private readonly pointer: string) {}

  private async read(file: string): Promise<unknown | undefined> {
    let before;
    try { before = await historyIdentity(file, 'file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (BigInt(before.size) > 65_536n) throw new Error('DSH history binding exceeds limit');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (String(opened.ino) !== before.ino || String(opened.dev) !== before.dev) throw new Error('DSH history binding changed');
      const bytes = await handle.readFile('utf8');
      if (JSON.stringify(await historyIdentity(file, 'file')) !== JSON.stringify(before)) throw new Error('DSH history binding changed');
      return JSON.parse(bytes);
    } finally { await handle.close(); }
  }

  async prepare(cwd: string): Promise<void> {
    if (!/^delegate-lane-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(this.executorThreadId)) {
      throw new Error('DSH history requires a managed lane');
    }
    await historyDirectory(this.home);
    let directory = this.home;
    for (const name of ['.remote-cli', 'dsh-history-bindings']) {
      directory = path.join(directory, name);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await historyDirectory(directory);
    }
    const binding = path.join(directory, `${this.executorThreadId}.json`);
    const saved = await this.read(binding);
    const pointer = await this.read(this.pointer) as { id?: unknown; cwd?: unknown } | undefined;
    if (saved !== undefined && (!validDshHistoryScope(saved) || saved.executorThreadId !== this.executorThreadId
      || saved.home.path !== this.home)) throw new Error('DSH history binding is not owned');
    if (saved && validDshHistoryScope(saved) && saved.cwd === cwd) {
      this.scope = saved;
      this.patch = await dshHistoryPatch(saved);
      return;
    }
    if (pointer !== undefined) {
      // Never migrate a legacy/adopted session into a new private persistence root.
      if (saved !== undefined || typeof pointer?.id !== 'string' || !pointer.id) throw new Error('DSH legacy history binding is ambiguous');
      this.scope = undefined;
      this.patch = '';
      return;
    }
    const scope = await createDshHistoryScope(this.home, this.executorThreadId, cwd);
    const patch = await dshHistoryPatch(scope);
    const temporary = `${binding}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(scope)); await handle.sync(); }
    finally { await handle.close(); }
    await replaceAtomicFile(temporary, binding);
    await syncDirectory(directory);
    this.scope = scope;
    this.patch = patch;
  }

  async capture(sessionId: string): Promise<DshDeletionTarget> {
    if (!this.scope) throw new Error('DSH legacy session has no owned history scope');
    return captureDshDeletionTarget(this.scope, sessionId);
  }
}

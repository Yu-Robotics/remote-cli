import { spawn, type ChildProcess } from 'child_process';
import syncFs from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';
import { setImmediate as nextTurn } from 'timers/promises';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegationOwnership } from '../../src/delegation/DelegationOwnership';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

let directory: string;
let common: string;
let implementation: string;
const children: Array<{ child: ChildProcess; closed: Promise<number | null> }> = [];
const rootLock = (root: string) => `${root}.ownership`;
const repositoryLock = (root: string) => path.join(root, 'remote-cli-delegation.ownership');

function supportsAlias(directoryLink: boolean): boolean {
  const scratch = syncFs.realpathSync(syncFs.mkdtempSync(path.join(os.tmpdir(), 'delegation-link-capability-')));
  try {
    const target = path.join(scratch, 'target');
    if (directoryLink) syncFs.mkdirSync(target);
    else syncFs.writeFileSync(target, 'synthetic fixture');
    syncFs.symlinkSync(target, path.join(scratch, 'alias'), directoryLink ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  } finally { syncFs.rmSync(scratch, { recursive: true, force: true }); }
}

// Only alias-specific cases skip when the fixture filesystem cannot create the
// required link. Windows junctions need no file-symlink elevation in normal use.
const supportsDirectoryAlias = supportsAlias(true);
const supportsFileAlias = supportsAlias(false);

async function alias(target: string, name: string, directoryLink = true) {
  await fs.symlink(target, name, directoryLink ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
}

async function owner(name: string) {
  const root = path.join(directory, name);
  const ownership = new DelegationOwnership(root);
  await ownership.acquire();
  return { root, ownership };
}

function startChild(root: string, mode: 'root' | 'repository' | 'crash' | 'repository-crash' = 'root', repository = common) {
  const script = `
    const fs = require('fs/promises');
    const originalOpen = fs.open;
    let reportedContention = false;
    fs.open = async (...args) => {
      try { return await originalOpen(...args); }
      catch (error) {
        if (error.code === 'EEXIST' && !reportedContention) {
          reportedContention = true;
          process.send({ type: 'contended' });
        }
        throw error;
      }
    };
    const { DelegationOwnership } = require(process.argv[1]);
    const owner = new DelegationOwnership(process.argv[2]);
    const wait = expected => new Promise(resolve => {
      const handler = message => {
        if (message === expected) { process.off('message', handler); resolve(); }
      };
      process.on('message', handler);
    });
    (async () => {
      await owner.acquire();
      const release = wait('release');
      const proceed = wait('continue');
      process.send({ type: 'acquired' });
      if (process.argv[3] === 'crash') {
        await wait('crash');
        process.exit(0);
      }
      if (process.argv[3] === 'repository' || process.argv[3] === 'repository-crash') {
        await owner.withRepository(process.argv[4], async () => {
          const crash = process.argv[3] === 'repository-crash' ? wait('crash') : undefined;
          process.send({ type: 'entered' });
          if (crash) { await crash; process.exit(0); }
          await proceed;
        });
        process.send({ type: 'completed' });
      }
      await release;
      await owner.release();
      process.send({ type: 'released' });
      process.disconnect();
    })().catch(error => {
      process.send({ type: 'failed', message: error.message });
      process.exitCode = 2;
      process.disconnect();
    });
  `;
  const child = spawn(process.execPath, ['-e', script, implementation, root, mode, repository], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages: Array<{ type: string; message?: string }> = [];
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const waiting = new Map<string, Array<(message: { type: string; message?: string }) => void>>();
  child.on('message', value => {
    const message = value as { type: string; message?: string };
    messages.push(message);
    for (const done of waiting.get(message.type) ?? []) done(message);
    waiting.delete(message.type);
  });
  const closed = new Promise<number | null>(resolve => {
    child.on('error', error => { stderr = error.message; });
    child.on('close', resolve);
  });
  children.push({ child, closed });
  return {
    child, closed, messages,
    wait(type: string): Promise<{ type: string; message?: string }> {
      const received = messages.find(message => message.type === type);
      if (received) return Promise.resolve(received);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Synthetic child did not send ${type}: ${stderr}`)), 5000);
        const done = (message: { type: string; message?: string }) => { clearTimeout(timer); resolve(message); };
        waiting.set(type, [...waiting.get(type) ?? [], done]);
        void closed.then(() => { clearTimeout(timer); reject(new Error(`Synthetic child closed before ${type}: ${stderr}`)); });
      });
    },
  };
}

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-ownership-test-')));
  common = path.join(directory, 'git-common');
  await fs.mkdir(common);
  implementation = path.join(directory, 'ownership.cjs');
  const source = await fs.readFile(path.resolve(__dirname, '../../src/delegation/DelegationOwnership.ts'), 'utf8');
  await fs.writeFile(implementation, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { child, closed } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
  await fs.rm(directory, { recursive: true, force: true });
});

describe('DelegationOwnership', () => {
  it('acquires once per instance, keeps metadata outside storage, and rejects independent owners', async () => {
    const root = path.join(directory, 'stores');
    const first = new DelegationOwnership(root);
    expect(await fs.readdir(directory)).not.toContain('stores');
    const acquiring = first.acquire();
    expect(first.acquire()).toBe(acquiring);
    await acquiring;
    await first.acquire();
    expect(await fs.readdir(root)).toEqual([]);
    const bytes = await fs.readFile(rootLock(root));
    const metadata = JSON.parse(bytes.toString());
    expect(metadata).toMatchObject({ version: 1, pid: process.pid });
    expect(metadata.token).toMatch(/^[a-f0-9-]{36}$/);
    const second = new DelegationOwnership(root);
    await expect(second.acquire()).rejects.toThrow(/already owned/);
    await second.release();
    expect(await fs.readFile(rootLock(root))).toEqual(bytes);
    await first.release();
    await first.release();
    await second.acquire();
    expect(JSON.parse(await fs.readFile(rootLock(root), 'utf8')).token).not.toBe(metadata.token);
    await second.release();
  });

  it.skipIf(!supportsDirectoryAlias)('canonicalizes storage aliases and trailing separators', async () => {
    const first = await owner('storage');
    const link = path.join(directory, 'storage-alias');
    await alias(first.root, link);
    const second = new DelegationOwnership(link + path.sep);
    await expect(second.acquire()).rejects.toThrow(/already owned/);
    await second.release();
    expect(await fs.readdir(first.root)).toEqual([]);
    await first.ownership.release();
    await second.acquire();
    await second.release();
  });

  it('uses the host filesystem identity for case variants', async () => {
    const first = await owner('MixedStorage');
    const variant = path.join(directory, 'mixedstorage');
    let aliasesExisting = false;
    try { aliasesExisting = await fs.realpath(variant) === await fs.realpath(first.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const second = new DelegationOwnership(variant);
    if (aliasesExisting) await expect(second.acquire()).rejects.toThrow(/already owned/);
    else await second.acquire();
    await second.release();
    if (process.platform === 'win32' && /^[a-z]:/i.test(first.root)) {
      const driveVariant = first.root[0] === first.root[0].toUpperCase()
        ? first.root[0].toLowerCase() + first.root.slice(1)
        : first.root[0].toUpperCase() + first.root.slice(1);
      await expect(new DelegationOwnership(driveVariant).acquire()).rejects.toThrow(/already owned/);
    }
    await first.ownership.release();
  });

  it('excludes a second real process and admits it only after release', async () => {
    const root = path.join(directory, 'shared-storage');
    const first = startChild(root);
    await first.wait('acquired');
    const second = startChild(root);
    expect((await second.wait('failed')).message).toMatch(/already owned.*controlled lock recovery/);
    expect(await second.closed).toBe(2);
    first.child.send('release');
    await first.wait('released');
    expect(await first.closed).toBe(0);
    const third = startChild(root);
    await third.wait('acquired');
    third.child.send('release');
    expect(await third.closed).toBe(0);
  });

  it('does not steal a lock after the owning process exits', async () => {
    const root = path.join(directory, 'abandoned-storage');
    const child = startChild(root, 'crash');
    await child.wait('acquired');
    const bytes = await fs.readFile(rootLock(root));
    child.child.send('crash');
    expect(await child.closed).toBe(0);
    const next = new DelegationOwnership(root);
    await expect(next.acquire()).rejects.toThrow(/confirm all of its delegated children have exited/);
    await next.release();
    expect(await fs.readFile(rootLock(root))).toEqual(bytes);
  });

  it('keeps abandoned repository ownership across storage roots after process exit', async () => {
    const root = path.join(directory, 'abandoned-storage');
    const child = startChild(root, 'repository-crash');
    await child.wait('entered');
    const bytes = await fs.readFile(repositoryLock(common));
    child.child.send('crash');
    expect(await child.closed).toBe(0);
    const next = await owner('new-storage');
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(30_001);
    try {
      await expect(next.ownership.withRepository(common, async () => undefined)).rejects.toThrow(/controlled lock recovery/);
    } finally { clock.mockRestore(); }
    await next.ownership.release();
    expect(await fs.readFile(repositoryLock(common))).toEqual(bytes);
  });

  it.skipIf(!supportsDirectoryAlias)('serializes real processes from different storage roots using the same canonical common directory', async () => {
    const commonAlias = path.join(directory, 'common-alias');
    await alias(common, commonAlias);
    const first = startChild(path.join(directory, 'first-storage'), 'repository');
    await first.wait('entered');
    const second = startChild(path.join(directory, 'second-storage'), 'repository', commonAlias);
    await second.wait('acquired');
    await second.wait('contended');
    expect(second.messages.some(message => message.type === 'entered')).toBe(false);
    first.child.send('continue');
    await first.wait('completed');
    await second.wait('entered');
    second.child.send('continue');
    await second.wait('completed');
    first.child.send('release');
    second.child.send('release');
    expect(await first.closed).toBe(0);
    expect(await second.closed).toBe(0);
    expect(await fs.readdir(common)).toEqual([]);
  });

  it('releases repository locks after success or thrown operations', async () => {
    const { ownership } = await owner('storage');
    expect(await ownership.withRepository(common, async () => 42)).toBe(42);
    const failure = new Error('Synthetic operation failure');
    await expect(ownership.withRepository(common, async () => { throw failure; })).rejects.toBe(failure);
    await expect(ownership.withRepository(common, async () => { throw undefined; })).rejects.toBeUndefined();
    expect(await fs.readdir(common)).toEqual([]);
    expect(await ownership.withRepository(common, async () => 'retry')).toBe('retry');
    await ownership.release();
  });

  it('drains running work, cancels waiters, and permits independent repositories while waiting', async () => {
    const first = await owner('first');
    const second = await owner('second');
    const other = path.join(directory, 'other-common');
    await fs.mkdir(other);
    const entered = deferred();
    const finish = deferred();
    const running = first.ownership.withRepository(common, async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    const callback = vi.fn(async () => undefined);
    const waiting = second.ownership.withRepository(common, callback);
    const rejected = expect(waiting).rejects.toThrow(/cancelled/);
    expect(await second.ownership.withRepository(other, async () => 'independent')).toBe('independent');
    await second.ownership.release();
    await rejected;
    expect(callback).not.toHaveBeenCalled();
    const release = first.ownership.release();
    let released = false;
    void release.then(() => { released = true; });
    await nextTurn();
    expect(released).toBe(false);
    await expect(first.ownership.withRepository(other, callback)).rejects.toThrow(/release/);
    finish.resolve();
    await running;
    await release;
    expect(await fs.readdir(common)).toEqual([]);
  });

  it('leaves a contended repository lock untouched on bounded timeout', async () => {
    const first = await owner('first');
    const second = await owner('second');
    const entered = deferred();
    const finish = deferred();
    const running = first.ownership.withRepository(common, async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    const bytes = await fs.readFile(repositoryLock(common));
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const originalOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      try { return await originalOpen(...args); }
      catch (error) {
        if (args[0] === repositoryLock(common) && (error as NodeJS.ErrnoException).code === 'EEXIST') clock.mockReturnValue(30_001);
        throw error;
      }
    });
    try {
      const callback = vi.fn(async () => undefined);
      await expect(second.ownership.withRepository(common, callback)).rejects.toThrow(/Timed out after 30000ms/);
      expect(callback).not.toHaveBeenCalled();
      expect(await fs.readFile(repositoryLock(common))).toEqual(bytes);
    } finally { open.mockRestore(); clock.mockRestore(); finish.resolve(); await running; }
    await first.ownership.release();
    await second.ownership.release();
  });

  it.skipIf(!supportsFileAlias)('refuses foreign lock symlinks without changing their targets', async () => {
    const root = path.join(directory, 'storage');
    const target = path.join(directory, 'foreign-data');
    await fs.writeFile(target, 'synthetic foreign content');
    await alias(target, rootLock(root), false);
    const ownership = new DelegationOwnership(root);
    await expect(ownership.acquire()).rejects.toThrow(/Unsafe delegation lock/);
    await ownership.release();
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic foreign content');
    expect((await fs.lstat(rootLock(root))).isSymbolicLink()).toBe(true);
    const other = await owner('other');
    await alias(target, repositoryLock(common), false);
    await expect(other.ownership.withRepository(common, async () => undefined)).rejects.toThrow(/Unsafe delegation lock/);
    await other.ownership.release();
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic foreign content');
  });

  it.each(['token', 'inode'])('refuses release after foreign %s replacement', async replacement => {
    const { ownership, root } = await owner('storage');
    const original = await fs.readFile(rootLock(root));
    if (replacement === 'inode') await fs.rename(rootLock(root), path.join(directory, 'retired-lock'));
    const contents = replacement === 'inode' ? original
      : Buffer.from(JSON.stringify({ ...JSON.parse(original.toString()), token: '00000000-0000-0000-0000-000000000000' }) + '\n');
    await fs.writeFile(rootLock(root), contents);
    await expect(ownership.acquire()).rejects.toThrow(/ownership changed|token changed/);
    const callback = vi.fn(async () => undefined);
    await expect(ownership.withRepository(common, callback)).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    await expect(ownership.release()).rejects.toThrow(/ownership changed|token changed/);
    expect(await fs.readFile(rootLock(root))).toEqual(contents);
    await expect(ownership.acquire()).rejects.toThrow(/releasing or requires recovery/);
  });

  it('retains foreign repository replacement and reports both operation and cleanup errors', async () => {
    const { ownership } = await owner('storage');
    const failure = new Error('Synthetic operation failure');
    const operation = ownership.withRepository(common, async () => {
      await fs.writeFile(repositoryLock(common), 'foreign repository lock');
      throw failure;
    });
    await expect(operation).rejects.toBeInstanceOf(AggregateError);
    expect(await fs.readFile(repositoryLock(common), 'utf8')).toBe('foreign repository lock');
    await expect(ownership.withRepository(common, async () => undefined)).rejects.toThrow(/release/);
    await ownership.release();
  });

  it('fails a successful callback if its repository lock was replaced', async () => {
    const { ownership } = await owner('storage');
    await expect(ownership.withRepository(common, async () => {
      await fs.writeFile(repositoryLock(common), 'foreign lock');
      return 'must not report success';
    })).rejects.toThrow(/ownership changed/);
    expect(await fs.readFile(repositoryLock(common), 'utf8')).toBe('foreign lock');
    await ownership.release();
  });

  it('refuses foreign lock directories without deleting their contents', async () => {
    const root = path.join(directory, 'storage');
    await fs.mkdir(rootLock(root));
    await fs.writeFile(path.join(rootLock(root), 'foreign.txt'), 'synthetic foreign content');
    const ownership = new DelegationOwnership(root);
    await expect(ownership.acquire()).rejects.toThrow(/Unsafe delegation lock/);
    await ownership.release();
    expect(await fs.readFile(path.join(rootLock(root), 'foreign.txt'), 'utf8')).toBe('synthetic foreign content');
  });

  it.skipIf(!supportsDirectoryAlias)('fences a repository alias retargeted after admission starts', async () => {
    const { ownership } = await owner('storage');
    const other = path.join(directory, 'other-common');
    const link = path.join(directory, 'common-link');
    await fs.mkdir(other);
    await alias(common, link);
    const originalOpen = fs.open.bind(fs);
    let retargeted = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === repositoryLock(common) && !retargeted) {
        retargeted = true;
        await fs.unlink(link);
        await alias(other, link);
      }
      return handle;
    });
    const callback = vi.fn(async () => undefined);
    await expect(ownership.withRepository(link, callback)).rejects.toThrow(/repository alias changed/);
    expect(callback).not.toHaveBeenCalled();
    expect(await fs.readdir(common)).toEqual([]);
    expect(await fs.readdir(other)).toEqual([]);
    await ownership.release();
  });

  it.skipIf(!supportsDirectoryAlias)('fences a retargeted storage alias while releasing only its original lock', async () => {
    const first = path.join(directory, 'first');
    const second = path.join(directory, 'second');
    await fs.mkdir(first);
    await fs.mkdir(second);
    const link = path.join(directory, 'alias');
    await alias(first, link);
    const ownership = new DelegationOwnership(link);
    await ownership.acquire();
    await fs.unlink(link);
    await alias(second, link);
    await expect(ownership.withRepository(common, async () => undefined)).rejects.toThrow(/alias changed/);
    await ownership.release();
    expect(await fs.readdir(second)).toEqual([]);
    await expect(fs.lstat(rootLock(first))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a partially initialized lock instead of unlocking after failed acquisition', async () => {
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(new Error('Synthetic write failure'));
      return handle;
    });
    const root = path.join(directory, 'storage');
    const ownership = new DelegationOwnership(root);
    await expect(ownership.acquire()).rejects.toThrow(/initialization failed/);
    await ownership.release();
    expect((await fs.lstat(rootLock(root))).isFile()).toBe(true);
    await expect(new DelegationOwnership(root).acquire()).rejects.toThrow(/abandoned lock/);
  });

  it('waits for in-flight acquisition when releasing and rejects use before acquisition', async () => {
    const ownership = new DelegationOwnership(path.join(directory, 'storage'));
    await expect(ownership.withRepository(common, async () => undefined)).rejects.toThrow(/Acquire/);
    const gate = deferred();
    const originalMkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, 'mkdir').mockImplementationOnce(async (...args) => { await gate.promise; return originalMkdir(...args); });
    const acquiring = ownership.acquire();
    const cancelled = expect(acquiring).rejects.toThrow(/cancelled by release/);
    const releasing = ownership.release();
    expect(ownership.release()).toBe(releasing);
    await expect(ownership.acquire()).rejects.toThrow(/releasing/);
    gate.resolve();
    await cancelled;
    await releasing;
    await ownership.acquire();
    await ownership.release();
    expect(() => new DelegationOwnership(' ')).toThrow(/empty/);
  });
});

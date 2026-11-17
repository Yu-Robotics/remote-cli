import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScheduledSessionGuard } from '../../../src/scheduling/dsh/ScheduledSessionGuard';
let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-guard-'))); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it('retains a permanent refusal across restart without blocking an unrelated ordinary session', () => {
  const guard = new ScheduledSessionGuard(root, 'thread');
  guard.assertResume('ordinary'); guard.mark('scheduled'); guard.mark('scheduled');
  expect(() => new ScheduledSessionGuard(root, 'thread').assertResume('scheduled')).toThrow('automatic resume is blocked');
  guard.assertResume('ordinary');
  expect(fs.readdirSync(root)).toHaveLength(1);
});
it('flushes duplicate markers with Windows-compatible access without truncating existing evidence', () => {
  const guard = new ScheduledSessionGuard(root, 'thread'); guard.mark('scheduled');
  const file = path.join(root, fs.readdirSync(root)[0]);
  const evidence = Buffer.from('Synthetic unresolved marker evidence\n'); fs.writeFileSync(file, evidence);
  const open = fs.openSync.bind(fs), sync = fs.fsyncSync.bind(fs);
  const access = new Map<number, string | number>();
  let fileFlushes = 0;
  vi.spyOn(fs, 'openSync').mockImplementation((filename, flags, mode) => {
    const fd = open(filename, flags, mode); access.set(fd, flags); return fd;
  });
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (fs.fstatSync(fd).isFile()) {
      // Reproduce Windows' read-only descriptor failure without spoofing the
      // host platform during real file/directory durability operations.
      if (access.get(fd) === 'r') throw Object.assign(new Error('Synthetic read-only flush'), { code: 'EPERM' });
      fileFlushes++;
    }
    sync(fd);
  });
  guard.mark('scheduled'); guard.mark('scheduled');
  expect(fileFlushes).toBe(2); expect(fs.readFileSync(file)).toEqual(evidence);
  expect(() => new ScheduledSessionGuard(root, 'thread').assertResume('scheduled')).toThrow('blocked');
  guard.assertResume('ordinary'); expect(fs.readdirSync(root)).toHaveLength(1);
});
it('rejects a symlink marker before reopening it for a flush', () => {
  const guard = new ScheduledSessionGuard(root, 'thread'); guard.mark('scheduled');
  const file = path.join(root, fs.readdirSync(root)[0]);
  vi.spyOn(fs, 'lstatSync').mockReturnValue({ isFile: () => true, isSymbolicLink: () => true } as fs.Stats);
  const open = vi.spyOn(fs, 'openSync');
  expect(() => guard.mark('scheduled')).toThrow('Unsafe scheduled session marker');
  expect(open).toHaveBeenCalledTimes(1); // Exclusive creation fails; no follow-up open.
  expect(fs.readFileSync(file)).toEqual(Buffer.alloc(0));
});
it('fails closed on durable marker write failure and unsafe markers', () => {
  const guard = new ScheduledSessionGuard(root, 'thread');
  const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('fixture ENOSPC'); });
  expect(() => guard.mark('scheduled')).toThrow('ENOSPC'); sync.mockRestore();
  expect(() => guard.assertResume('scheduled')).toThrow('blocked');
  const file = path.join(root, fs.readdirSync(root)[0]); fs.unlinkSync(file); fs.mkdirSync(file);
  expect(() => guard.mark('scheduled')).toThrow('Unsafe');
  expect(() => guard.assertResume('scheduled')).toThrow('blocked');
});
it('refuses legacy attributed or unattributed obligations, including compacted cleanup, without erasing history', () => {
  const catalog = path.join(root, 'catalog.json'), guard = new ScheduledSessionGuard(root, 'thread', catalog);
  guard.assertResume('session');
  const save = (row: object, cleanup = false) => fs.writeFileSync(catalog, JSON.stringify({ version: 6,
    records: cleanup ? [] : [row], cleanup: cleanup ? [row] : [] }));
  save({ backend: 'dsh', threadId: 'thread', recovery: { identity: JSON.stringify({ sessionId: 'session' }) } });
  expect(() => guard.assertResume('session')).toThrow('blocked'); guard.assertResume('other-session');
  save({ backend: 'dsh', threadId: 'thread', attribution: {} }, true);
  expect(() => guard.assertResume('session')).toThrow('blocked');
  save({ backend: 'dsh', threadId: 'thread', creationRefused: true }); guard.assertResume('session');
  save({ backend: 'dsh', threadId: 'sibling' }); guard.assertResume('session');
  save({ backend: 'claude', threadId: 'thread' }); guard.assertResume('session');
  fs.writeFileSync(catalog, '{'); expect(() => guard.assertResume('session')).toThrow();
  fs.writeFileSync(catalog, JSON.stringify({ version: 7, records: [] })); expect(() => guard.assertResume('session')).toThrow('Invalid');
});

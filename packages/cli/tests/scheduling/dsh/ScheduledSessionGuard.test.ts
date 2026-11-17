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

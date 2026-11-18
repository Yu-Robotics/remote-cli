import fs from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScheduledSessionGuard } from '../../../src/scheduling/dsh/ScheduledSessionGuard';
let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-guard-'))); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it('refuses a historical marker without rewriting it or blocking an unrelated session', () => {
  const marker = path.join(root, `scheduled-${createHash('sha256').update('scheduled').digest('hex')}.fence`);
  fs.writeFileSync(marker, 'Synthetic historical evidence');
  const guard = new ScheduledSessionGuard(root, 'thread');
  expect(() => guard.assertResume('scheduled')).toThrow('automatic resume is blocked');
  guard.assertResume('ordinary');
  expect(fs.readFileSync(marker, 'utf8')).toBe('Synthetic historical evidence');
  fs.unlinkSync(marker); fs.mkdirSync(marker);
  expect(() => guard.assertResume('scheduled')).toThrow('automatic resume is blocked');
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
it('does not treat host-owned schedules as legacy native reminders', () => {
  const catalog = path.join(root, 'catalog.json'), guard = new ScheduledSessionGuard(root, 'thread', catalog);
  fs.writeFileSync(catalog, JSON.stringify({ version: 6, records: [{ backend: 'dsh', engine: 'host', threadId: 'thread', state: 'active' }] }));
  expect(() => guard.assertResume('session')).not.toThrow();
});

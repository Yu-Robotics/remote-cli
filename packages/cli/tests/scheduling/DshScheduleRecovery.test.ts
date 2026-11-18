import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { SCHEDULE_CATALOG_FILE, ScheduleService } from '../../src/scheduling/ScheduleService';
import { ScheduledSessionGuard } from '../../src/scheduling/dsh/ScheduledSessionGuard';

it('honors historical DSH cleanup receipts and keeps unresolved sessions fenced after explicit purge', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-dsh-')));
  const catalog = path.join(directory, SCHEDULE_CATALOG_FILE);
  const owner = { threadId: 'thread', openId: 'owner', generation: 'generation' };
  const ids = ['confirmed', 'unresolved'];
  const records = ids.map(id => ({
    ...owner, id, backend: 'dsh', cwd: directory, prompt: 'Synthetic reminder',
    nativeId: id, createdAt: 1, state: 'cancelled', cancelRequested: true,
    ...(id === 'confirmed' && { cleanupConfirmed: true }),
    rule: { kind: 'cron', expression: '5 * * * *', timezone: 'UTC' },
    recovery: { version: 1, provider: 'dsh-session-orderly-v1', strategy: 'reconstruct', status: 'blocked',
      identity: JSON.stringify({ sessionId: id, cwd: directory, threadId: owner.threadId }) },
  }));
  const dispatch = vi.fn();
  const service = new ScheduleService({ directory, hostDispatch: dispatch, isOwnerCurrent: () => true, deliver: vi.fn() });
  const guard = new ScheduledSessionGuard(directory, owner.threadId, catalog);
  try {
    await fs.writeFile(catalog, JSON.stringify({ version: 6, records, pending: [], purged: [], cleanup: [] }));
    await service.initialize();
    for (const id of ids) expect(() => guard.assertResume(id)).toThrow('blocked');
    const foreign = await service.purge({ ...owner, openId: 'other-owner' }, { ids });
    expect(foreign.removedIds).toEqual([]);
    const result = await service.purge(owner, { ids });
    expect(result.historyRemovedIds).toEqual(ids);
    expect(result.nativeCleanupUnresolved).toMatchObject([{ id: 'unresolved', sessionId: 'unresolved' }]);
    expect(() => guard.assertResume('confirmed')).not.toThrow();
    expect(() => guard.assertResume('unresolved')).toThrow('blocked');
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    await service.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

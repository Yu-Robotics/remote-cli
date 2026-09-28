import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { DelegationStore, type DelegatedTaskRecord } from '../../src/delegation/DelegationStore';

describe('delegation record lifecycle', () => {
  let directory: string;
  const record = (overrides: Partial<DelegatedTaskRecord> = {}): DelegatedTaskRecord => ({ id: randomUUID(), threadId: 'owner',
    parentMessageId: 'parent', backend: 'codex', objective: 'Review', state: 'running', startedAt: Date.now(), ...overrides });
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-records-')); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it('marks interrupted work honestly after restart without scheduling another execution', async () => {
    const store = new DelegationStore(directory);
    await store.initialize();
    const active = record(); await store.write(active);
    const done = record({ state: 'succeeded', output: 'result' }); await store.write(done);
    const restored = new DelegationStore(directory); await restored.initialize();
    expect(JSON.parse(await fs.readFile(path.join(directory, `${active.id}.json`), 'utf8'))).toMatchObject({ state: 'interrupted' });
    expect(JSON.parse(await fs.readFile(path.join(directory, `${done.id}.json`), 'utf8'))).toMatchObject({ state: 'succeeded', output: 'result' });
  });

  it('bounds retained terminal records during a long-running CLI and keeps active work', async () => {
    const store = new DelegationStore(directory); await store.initialize();
    const active = record({ startedAt: Date.now() - 10000 }); await store.write(active);
    for (let i = 0; i < 205; i++) await store.write(record({ state: 'succeeded', startedAt: Date.now() - i }));
    await store.prune();
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.json'))).toHaveLength(201);
    expect(JSON.parse(await fs.readFile(path.join(directory, `${active.id}.json`), 'utf8')).state).toBe('running');
  });

  it('deletes only records owned by the deleted thread and keeps the last serialized write', async () => {
    const store = new DelegationStore(directory); await store.initialize();
    const own = record(); const other = record({ threadId: 'other' });
    await Promise.all([store.write(own), store.write({ ...own, state: 'succeeded' }), store.write(other)]);
    expect(JSON.parse(await fs.readFile(path.join(directory, `${own.id}.json`), 'utf8')).state).toBe('succeeded');
    await store.deleteThread('owner');
    expect(await fs.readdir(directory)).toEqual([`${other.id}.json`]);
  });
});

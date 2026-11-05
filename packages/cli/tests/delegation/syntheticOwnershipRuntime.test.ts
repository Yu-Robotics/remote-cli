import { describe, expect, it, vi } from 'vitest';
import * as actual from '../../src/delegation/OwnershipRuntime';
import { syntheticOwnershipRuntime } from './syntheticOwnershipRuntime';

describe('synthetic manager ownership identity', () => {
  it('creates fresh random tokens while preserving real process birth semantics', () => {
    const processBirth = vi.fn(actual.processBirth);
    const bootIdentity = vi.fn(() => { throw new Error('Native boot discovery must not run'); });
    const runtime = syntheticOwnershipRuntime({ ...actual, processBirth, bootIdentity });
    const first = runtime.ownerRecord();
    const second = runtime.ownerRecord();
    expect(first.token).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(second.token).not.toBe(first.token);
    expect(first).toMatchObject({ pid: process.pid, birth: actual.processBirth(process.pid),
      host: 'synthetic-manager-host', boot: 'synthetic-manager-boot', namespace: 'host' });
    expect(processBirth.mock.calls).toEqual([[process.pid], [process.pid]]);
    expect(bootIdentity).not.toHaveBeenCalled();
    expect(runtime.kernelGate).toBe(actual.kernelGate);
    expect(runtime.ProcessJournal).toBe(actual.ProcessJournal);
    expect(runtime.ownedSpawn).toBe(actual.ownedSpawn);
  });

  it('uses matching fixture identity without bypassing live-owner or corrupt-record checks', () => {
    const runtime = syntheticOwnershipRuntime(actual);
    const owner = runtime.ownerRecord();
    // A live owner is rejected before any journal path is opened.
    expect(() => runtime.assertRecoverable(actual.encodeOwner(owner), 'unused-journal'))
      .toThrow(actual.ActiveDelegationWriterError);
    expect(() => runtime.assertRecoverable(Buffer.from('{}'), 'unused-journal')).toThrow('Legacy ownership');
    expect(() => runtime.assertRecoverable(actual.encodeOwner(owner), 'unused-journal',
      { host: 'foreign-host', boot: owner.boot, namespace: owner.namespace })).toThrow('another host');
  });

  it('propagates process identity provider failures instead of inventing birth evidence', () => {
    const failure = Object.assign(new Error('Synthetic process identity unavailable'), { code: 'EACCES' });
    const runtime = syntheticOwnershipRuntime({ ...actual, processBirth: () => { throw failure; } });
    expect(() => runtime.ownerRecord()).toThrow(failure);
  });
});

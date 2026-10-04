import { describe, expect, it } from 'vitest';
import { boundExecutionMetadata, captureExecutionMetadata, configuredExecutionMetadata, mergeReportedExecutionMetadata } from '../src/executor/ExecutionMetadata';
import type { IExecutor } from '../src/executor/IExecutor';

const executor = (getExecutionMetadata?: () => unknown) => ({ getExecutionMetadata }) as IExecutor;

describe('execution metadata snapshots', () => {
  it('distinguishes configured values from defaults without guessing a model or effort', () => {
    expect(configuredExecutionMetadata('model-a', 'high')).toMatchObject({ model: 'model-a', modelSource: 'configured', reasoningEffort: 'high', effortSource: 'configured' });
    expect(configuredExecutionMetadata(undefined, 'auto')).toEqual({ model: undefined, modelSource: 'default', reasoningEffort: undefined, effortSource: 'default' });
  });

  it('copies only bounded fields, strips controls, and never forwards unrelated data', () => {
    const raw = { model: `model\n${'a'.repeat(200)}`, modelSource: 'reported', reasoningEffort: 'h'.repeat(100), effortSource: 'configured', credential: 'synthetic-not-a-secret' };
    const data = captureExecutionMetadata(executor(() => raw), 'codex')!;
    raw.model = 'changed';
    expect(data.model).toHaveLength(128);
    expect(data.model).not.toContain('\n');
    expect(data.reasoningEffort).toHaveLength(64);
    expect(data).not.toHaveProperty('credential');
  });

  it('keeps old executors and broken metadata getters nonfatal', () => {
    expect(captureExecutionMetadata(executor(), 'claude')).toBeUndefined();
    expect(captureExecutionMetadata(executor(() => { throw new Error('unavailable'); }), 'claude')).toBeUndefined();
    expect(captureExecutionMetadata(executor(() => null), 'claude')).toBeUndefined();
    expect(boundExecutionMetadata([], 'claude')).toBeUndefined();
    expect(boundExecutionMetadata(Object.defineProperty({}, 'model', { get() { throw new Error('invalid field'); } }), 'claude')).toBeUndefined();
  });

  it('preserves unknowns and discards values that have no trustworthy provenance', () => {
    expect(captureExecutionMetadata(executor(() => ({ model: 'invented', modelSource: 'invalid', reasoningEffort: '', effortSource: 'reported' })), 'kimi'))
      .toMatchObject({ model: undefined, modelSource: 'unknown', reasoningEffort: undefined, effortSource: 'unknown' });
    expect(captureExecutionMetadata(executor(() => ({ model: 'ignored', modelSource: 'default', reasoningEffort: 'ignored', effortSource: 'unknown' })), 'agy'))
      .toMatchObject({ model: undefined, modelSource: 'default', reasoningEffort: undefined, effortSource: 'unknown' });
  });

  it('retains launch preferences while accepting runtime reports for the same backend', () => {
    const launch = { backend: 'agy', ...configuredExecutionMetadata('old-model', 'low') };
    const next = { backend: 'agy', ...configuredExecutionMetadata('next-model', 'high') };
    expect(mergeReportedExecutionMetadata(launch, next)).toEqual(launch);
    const reported = { ...next, model: 'resolved-model', modelSource: 'reported' as const, reasoningEffort: 'medium', effortSource: 'reported' as const };
    expect(mergeReportedExecutionMetadata(launch, reported)).toEqual(reported);
    expect(mergeReportedExecutionMetadata(launch, { ...reported, backend: 'codex' })).toEqual(launch);
    expect(mergeReportedExecutionMetadata(launch, undefined)).toEqual(launch);
    expect(mergeReportedExecutionMetadata(undefined, reported)).toEqual(reported);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsCatalogReader, configuredBackendModel, metadataConfiguration } from '../../src/settings/SettingsCatalog';
import type { IExecutor } from '../../src/executor/IExecutor';
import type { DirectoryGuard } from '../../src/security/DirectoryGuard';
import type { Thread } from '../../src/thread/types';
import type { ExecutorConfig } from '../../src/types/config';

const policies = vi.hoisted(() => ({ codex: new Map<string, any>(), claude: new Map<string, any>(), reads: vi.fn() }));
vi.mock('../../src/executor/CodexSandbox', () => ({ CodexSandbox: class {
  constructor(_guard: unknown, private configured: any, private id: string) { policies.reads('codex', id); }
  getConfig() { return policies.codex.get(this.id) ?? this.configured; }
} }));
vi.mock('../../src/executor/claude/ClaudeSandbox', () => ({ ClaudeSandbox: class {
  constructor(_guard: unknown, private configured: any, private id: string) { policies.reads('claude', id); }
  getConfig() { return policies.claude.get(this.id) ?? this.configured; }
} }));

const guard = {} as DirectoryGuard;
const thread: Thread = { id: 'parent-thread', name: 'parent', workingDirectory: '/workspace/example-project', sessionId: null,
  createdAt: 0, lastActiveAt: 0, models: { codex: 'configured-codex', claude: 'configured-claude' },
  efforts: { codex: 'high', claude: 'medium' } };
const config: ExecutorConfig = { type: 'codex', codex: { model: 'global-codex' }, claude: { model: 'global-claude' } };

function fixture(overrides: Partial<IExecutor> = {}) {
  const executor = {
    destroy: vi.fn(async () => {}), waitForExit: vi.fn(async () => {}), deleteThreadData: vi.fn(async () => {}),
    execute: vi.fn(), setModel: vi.fn(), clearModel: vi.fn(), setEffort: vi.fn(),
    getExecutionMetadata: vi.fn(() => ({ model: 'model-b', modelSource: 'reported', reasoningEffort: 'high', effortSource: 'reported' })),
    listModels: vi.fn(async () => [
      { id: 'model-a', displayName: 'Model A', isDefault: true },
      { id: 'model-b', displayName: 'Model B', isCurrent: true, description: 'Native model' },
    ]),
    listEfforts: vi.fn(async () => ({ choices: [{ value: 'high', displayName: 'High' }], current: 'high', default: 'medium', supportsReset: true })),
    ...overrides,
  } as unknown as IExecutor;
  const factory = vi.fn(() => executor);
  const reader = new SettingsCatalogReader(guard, factory as any);
  return { executor, factory, reader };
}

beforeEach(() => { policies.codex.clear(); policies.claude.clear(); policies.reads.mockClear(); });
afterEach(() => { vi.useRealTimers(); });

describe('isolated native settings catalogs', () => {
  it('resolves saved policy using the real parent ID before creating an isolated synthetic identity', async () => {
    policies.codex.set(thread.id, { mode: 'workspace-write', networkAccess: false });
    const f = fixture();
    const menu = await f.reader.read(config, thread, 'codex', 'codex', 'model');
    const call = f.factory.mock.calls[0] as any[];
    expect(call[1].codex.sandbox).toEqual({ mode: 'workspace-write', networkAccess: false });
    expect(call[3]).toMatch(/^settings-meta-/);
    expect(call[3]).not.toBe(thread.id);
    expect(call[4]).toBe('configured-codex');
    expect(call[5]).toBe('high');
    expect(call[6]).toEqual({ lifecycleHooks: false, delegationWorker: true });
    expect(policies.reads.mock.calls.every(([, id]) => id === thread.id)).toBe(true);
    expect(menu).toMatchObject({ effectiveValue: 'model-b', effectiveSource: 'native', defaultValue: 'model-a', supportsReset: true });
    expect(f.executor.deleteThreadData).toHaveBeenCalledWith(call[3]);
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it.each(['codex', 'claude'] as const)('fails closed before a cross-backend query from a restricted %s parent', async backend => {
    policies[backend].set(thread.id, { mode: 'read-only' });
    const f = fixture();
    await expect(f.reader.read(config, thread, backend, 'agy', 'model')).rejects.toThrow('coordinator sandbox is enabled');
    expect(f.factory).not.toHaveBeenCalled();
  });

  it('injects the target policy without widening it or changing the original config', async () => {
    policies.claude.set(thread.id, { mode: 'workspace-write', networkAccess: true });
    const effective = metadataConfiguration(config, guard, thread.id, 'codex', 'claude');
    expect(effective.type).toBe('claude-persistent');
    expect(effective.claude?.sandbox).toEqual({ mode: 'workspace-write', networkAccess: true });
    expect(config.claude?.sandbox).toBeUndefined();
    expect(configuredBackendModel(effective, 'claude')).toBe('global-claude');
    expect(configuredBackendModel(effective, 'agy')).toBeUndefined();
  });

  it('uses distinct synthetic identities for concurrent previews and destroys before deleting their own data', async () => {
    const f = fixture();
    const events: string[] = [];
    vi.mocked(f.executor.destroy).mockImplementation(async () => { events.push('destroy'); });
    vi.mocked(f.executor.waitForExit!).mockImplementation(async () => { events.push('exit'); });
    vi.mocked(f.executor.deleteThreadData!).mockImplementation(async () => { events.push('delete'); });
    await f.reader.read(config, thread, 'codex', 'claude', 'model');
    await f.reader.read(config, thread, 'codex', 'codex', 'model');
    const ids = f.factory.mock.calls.map(call => (call as any[])[3]);
    expect(new Set(ids).size).toBe(2);
    expect(events).toEqual(['destroy', 'exit', 'delete', 'destroy', 'exit', 'delete']);
  });

  it('distinguishes configured preferences from native current/default metadata and never assumes first is current', async () => {
    const f = fixture({ listModels: vi.fn(async () => [{ id: 'first', displayName: 'First' }]) });
    expect(await f.reader.read(config, thread, 'codex', 'codex', 'model')).toMatchObject({
      effectiveValue: 'configured-codex', effectiveSource: 'configured', defaultValue: undefined,
    });
    const noPreference = { ...thread, models: undefined };
    expect(await f.reader.read({ type: 'agy' }, noPreference, 'agy', 'agy', 'model')).toMatchObject({
      effectiveValue: undefined, effectiveSource: 'unknown', defaultValue: undefined,
    });
    expect(await f.reader.read({ type: 'codex', codex: { model: 'global-codex' } }, noPreference, 'codex', 'codex', 'model')).toMatchObject({
      effectiveValue: 'global-codex', effectiveSource: 'configured',
    });
  });

  it('does not offer a model reset without native clear or a configured fallback setter', async () => {
    const f = fixture({ clearModel: undefined, setModel: undefined });
    expect((await f.reader.read(config, thread, 'codex', 'codex', 'model')).supportsReset).toBe(false);
    const fallback = fixture({ clearModel: undefined });
    expect((await fallback.reader.read(config, thread, 'codex', 'codex', 'model')).supportsReset).toBe(true);
  });

  it.each(['pi', 'opencode', 'kimi', 'zcode', 'dsh'] as const)('labels %s session effort metadata as native and preserves reset support', async backend => {
    const f = fixture();
    expect(await f.reader.read(config, thread, 'codex', backend, 'effort')).toMatchObject({
      choices: [{ value: 'high', label: 'High' }], effectiveValue: 'high', defaultValue: 'medium',
      effectiveSource: 'native', supportsReset: true,
    });
  });

  it('does not label configured-only effort as a reported native current value', async () => {
    const f = fixture({ getExecutionMetadata: () => ({ modelSource: 'configured', effortSource: 'configured' }) });
    expect((await f.reader.read(config, thread, 'codex', 'codex', 'effort')).effectiveSource).toBe('configured');
    vi.mocked(f.executor.listEfforts!).mockResolvedValue({ choices: [], supportsReset: false, unavailableReason: 'Not exposed' });
    expect(await f.reader.read(config, thread, 'codex', 'claude', 'effort')).toMatchObject({
      effectiveValue: undefined, effectiveSource: 'unknown', supportsReset: false, unavailableReason: 'Not exposed',
    });
  });

  it('does not relabel a configured model match as a native observation', async () => {
    const f = fixture({ getExecutionMetadata: () => ({ modelSource: 'configured', effortSource: 'unknown' }) });
    expect((await f.reader.read(config, thread, 'codex', 'agy', 'model')).effectiveSource).toBe('configured');
  });

  it.each(['listModels', 'listEfforts'] as const)('treats absent %s as unavailable rather than prompting the agent', async method => {
    const f = fixture({ [method]: undefined });
    await expect(f.reader.read(config, thread, 'codex', 'codex', method === 'listModels' ? 'model' : 'effort')).rejects.toThrow('does not expose');
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect(f.executor.destroy).toHaveBeenCalledTimes(1);
    expect(f.executor.deleteThreadData).toHaveBeenCalledTimes(1);
  });

  it('cleans up a settled catalog failure but retains data when native exit is uncertain', async () => {
    const f = fixture({ listModels: vi.fn(async () => { throw new Error('Catalog failed'); }) });
    await expect(f.reader.read(config, thread, 'codex', 'codex', 'model')).rejects.toThrow('Catalog failed');
    expect(f.executor.deleteThreadData).toHaveBeenCalledTimes(1);
    vi.mocked(f.executor.waitForExit!).mockRejectedValueOnce(new Error('Exit not confirmed'));
    await expect(f.reader.read(config, thread, 'codex', 'codex', 'model')).rejects.toThrow('Exit not confirmed');
    expect(f.executor.deleteThreadData).toHaveBeenCalledTimes(1);
  });

  it('bounds a hanging metadata RPC and retains unresolved preview data rather than deleting it', async () => {
    vi.useFakeTimers();
    const f = fixture({ listModels: vi.fn(() => new Promise(() => {})) });
    const opening = f.reader.read(config, thread, 'codex', 'codex', 'model');
    const failure = expect(opening).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_001);
    await failure;
    expect(f.executor.destroy).toHaveBeenCalledTimes(1);
    expect(f.executor.waitForExit).toHaveBeenCalledTimes(1);
    expect(f.executor.deleteThreadData).not.toHaveBeenCalled();
  });

  it('restores the configured model instead of a saved override when explicitly requested', async () => {
    const f = fixture();
    expect(await f.reader.withExecutor(config, thread, 'codex', 'claude', async () => 'checked', true)).toBe('checked');
    expect((f.factory.mock.calls[0] as any[])[4]).toBe('global-claude');
  });

  it.each(['destroy', 'waitForExit'] as const)('bounds a hanging %s and never deletes unconfirmed preview data', async method => {
    vi.useFakeTimers();
    const f = fixture({ [method]: vi.fn(() => new Promise(() => {})) });
    const opening = f.reader.read(config, thread, 'codex', 'codex', 'model');
    const failure = expect(opening).rejects.toThrow('Preview data was retained');
    await vi.advanceTimersByTimeAsync(10_001);
    await failure;
    expect(f.executor.deleteThreadData).not.toHaveBeenCalled();
  });

  it('releases a native metadata session before destroy and removes only confirmed own pointers', async () => {
    const order: string[] = [];
    const f = fixture({ releaseMetadataSession: vi.fn(async () => { order.push('release'); }),
      destroy: vi.fn(async () => { order.push('destroy'); }), waitForExit: vi.fn(async () => { order.push('exit'); }),
      deleteThreadData: vi.fn(async () => { order.push('remove'); }) });
    await f.reader.read(config, thread, 'codex', 'opencode', 'model');
    expect(order).toEqual(['release', 'destroy', 'exit', 'remove']);
    expect(f.executor.deleteThreadData).toHaveBeenCalledTimes(1);
  });

  it('bounds native deletion before shutdown even if the backend never answers it', async () => {
    vi.useFakeTimers();
    const f = fixture({ releaseMetadataSession: vi.fn(() => new Promise(() => {})) });
    const opening = f.reader.read(config, thread, 'codex', 'opencode', 'model');
    await vi.advanceTimersByTimeAsync(2_001);
    await opening;
    expect(f.executor.destroy).toHaveBeenCalledTimes(1);
    expect(f.executor.deleteThreadData).toHaveBeenCalledTimes(1);
  });

  it('defers own-pointer cleanup after timeout until both RPC settlement and exit are confirmed', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const f = fixture({ listModels: vi.fn(() => new Promise((_resolve, fail) => { reject = fail; })) });
    const opening = f.reader.read(config, thread, 'codex', 'codex', 'model');
    const failure = expect(opening).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_001);
    await failure;
    expect(f.executor.deleteThreadData).not.toHaveBeenCalled();
    reject(new Error('Transport stopped'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.executor.deleteThreadData).toHaveBeenCalledTimes(1);
  });
});

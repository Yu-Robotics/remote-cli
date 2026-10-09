import { describe, expect, it, vi } from 'vitest';
import { SettingsAdmission } from '../../src/settings/SettingsAdmission';
import { SettingsService, type SettingsCatalog, type SettingsDependencies, type SettingsState } from '../../src/settings/SettingsService';
import type { SettingsActionMessage, SettingsBackend, SettingsBackendInfo, SettingsMenu } from '../../src/types/Settings';

const BACKENDS: SettingsBackend[] = ['claude', 'codex', 'opencode', 'kimi', 'zcode', 'pi', 'agy', 'dsh'];

function fixture() {
  let time = 1_000;
  let sequence = 0;
  const states = new Map<string, SettingsState>(['thread-a', 'thread-b'].map(threadId => [threadId, {
    threadId, threadName: threadId, coordinatorBackend: 'codex', followsGlobal: true, revision: 'revision-a',
    configuredModels: { codex: 'saved-model' }, configuredEfforts: { codex: 'high' }, delegationEnabled: true,
  }]));
  const rows: SettingsBackendInfo[] = BACKENDS.map(value => ({ value, label: value,
    installed: value !== 'pi' && value !== 'zcode', reason: value === 'pi' || value === 'zcode' ? 'Not installed' : undefined }));
  const catalog: SettingsCatalog = { choices: [{ value: 'model-a', label: 'Model A' }, { value: 'model-b', label: 'Model B' }],
    effectiveValue: 'model-a', defaultValue: 'model-b', effectiveSource: 'native', supportsReset: true };
  const admission = new SettingsAdmission();
  const dependencies: SettingsDependencies = {
    state: vi.fn(id => states.get(id)), backends: vi.fn(async () => rows), catalog: vi.fn(async () => catalog),
    busy: vi.fn(() => false), threads: vi.fn(() => [...states.keys()]),
    exclusive: (target, body) => admission.mutation(target, body),
    backend: vi.fn(async () => ({ success: true })), preference: vi.fn(async () => ({ success: true })), now: () => time,
    delegationSupported: vi.fn(() => true),
    delegation: vi.fn(async (id, enabled) => { states.get(id)!.delegationEnabled = enabled; return { success: true }; }),
  };
  const service = new SettingsService(dependencies);
  const action = (menu: SettingsMenu, fields: Partial<SettingsActionMessage> = {}): SettingsActionMessage => ({
    type: 'settings_action', messageId: `request-${++sequence}`, openId: 'owner-a', threadId: menu.threadId,
    snapshotId: menu.snapshotId, operation: 'apply', value: 'model-a', timestamp: time, ...fields,
  });
  return { service, dependencies, states, rows, catalog, action, admission, advance: (ms: number) => { time += ms; } };
}

describe('immutable settings menus and acknowledged mutations', () => {
  it('offers thread-only delegation controls without querying native catalogs', async () => {
    const f = fixture();
    const menu = await f.service.open('delegation', 'thread-a', 'owner-a');
    expect(menu).toMatchObject({ configuredValue: 'on', effectiveValue: 'on', supportsReset: false });
    expect(menu.choices.map(choice => choice.value)).toEqual(['on', 'off']);
    const result = await f.service.action(f.action(menu, { value: 'off' }));
    expect(result).toMatchObject({ success: true, menu: { configuredValue: 'off' } });
    expect(f.dependencies.delegation).toHaveBeenCalledWith('thread-a', false);
    expect(f.states.get('thread-b')!.delegationEnabled).toBe(true);
    expect(f.dependencies.catalog).not.toHaveBeenCalled();
    expect(f.dependencies.backend).not.toHaveBeenCalled();
    expect(f.dependencies.preference).not.toHaveBeenCalled();
    const on = await f.service.action(f.action(result.menu!, { value: 'on' }));
    expect(on.menu!.configuredValue).toBe('on');
  });

  it('rejects delegation scopes, backend views, resets and invalid values', async () => {
    const f = fixture();
    const menu = await f.service.open('delegation', 'thread-a', 'owner-a');
    for (const fields of [
      { value: 'off', scope: 'all' }, { value: 'off', scope: 'thread' }, { value: 'other' },
      { operation: 'reset', value: undefined }, { operation: 'follow_global', value: undefined },
      { operation: 'view', value: undefined, targetBackend: 'agy' },
    ] as Partial<SettingsActionMessage>[]) expect((await f.service.action(f.action(menu, fields))).success).toBe(false);
    await expect(f.service.open('delegation', 'thread-a', 'owner-a', 'agy')).rejects.toThrow('another backend');
    expect(f.dependencies.delegation).not.toHaveBeenCalled();
    const refreshed = await f.service.action(f.action(menu, { operation: 'view', value: undefined }));
    expect(refreshed).toMatchObject({ success: true, menu: { kind: 'delegation', targetBackend: 'codex' } });
  });

  it('disables unsupported On without preventing Off or busy refresh', async () => {
    const f = fixture();
    vi.mocked(f.dependencies.delegationSupported).mockReturnValue(false);
    const menu = await f.service.open('delegation', 'thread-a', 'owner-a');
    expect(menu.choices[0]).toMatchObject({ value: 'on', disabled: true });
    expect((await f.service.action(f.action(menu, { value: 'on' }))).success).toBe(false);
    expect((await f.service.action(f.action(menu, { value: 'off' }))).success).toBe(true);
    vi.mocked(f.dependencies.busy).mockReturnValue(true);
    const busy = await f.service.open('delegation', 'thread-a', 'owner-a');
    expect(busy.busy).toBe(true);
    expect((await f.service.action(f.action(busy, { value: 'off' }))).success).toBe(false);
    expect((await f.service.action(f.action(busy, { operation: 'view', value: undefined }))).success).toBe(true);
  });

  it('requires the additive delegation-card capability for mutations', async () => {
    const f = fixture();
    const menu = await f.service.open('delegation', 'thread-a', 'owner-a');
    const result = await f.service.action(f.action(menu, { value: 'off' }), false);
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('not negotiated');
    expect(f.dependencies.delegation).not.toHaveBeenCalled();
    const request = f.action(menu, { value: 'off' });
    expect((await f.service.action(request)).success).toBe(true);
    expect((await f.service.action(request, false)).success).toBe(false);
    expect(f.dependencies.delegation).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a failed delegation persistence as applied', async () => {
    const f = fixture();
    vi.mocked(f.dependencies.delegation).mockRejectedValueOnce(new Error('Synthetic persistence failure'));
    const menu = await f.service.open('delegation', 'thread-a', 'owner-a');
    const result = await f.service.action(f.action(menu, { value: 'off' }));
    expect(result.success).toBe(false);
    expect(f.states.get('thread-a')!.delegationEnabled).toBe(true);
  });

  it('offers every stable backend, disables missing tools and defaults to the original thread', async () => {
    const f = fixture();
    const menu = await f.service.open('backend', 'thread-a', 'owner-a');
    expect(menu.choices.map(choice => choice.value)).toEqual(BACKENDS);
    expect(menu.choices.filter(choice => choice.disabled).map(choice => choice.value)).toEqual(['zcode', 'pi']);
    expect(menu).toMatchObject({ coordinatorBackend: 'codex', targetBackend: 'codex', effectiveValue: 'codex', followsGlobal: true });
    const result = await f.service.action(f.action(menu, { value: 'agy' }));
    expect(result.success).toBe(true);
    expect(f.dependencies.backend).toHaveBeenCalledWith('thread-a', 'agy', 'thread', false);
    expect(f.dependencies.catalog).not.toHaveBeenCalled();
  });

  it('allows explicit device-wide confirmation and following the global backend', async () => {
    const f = fixture();
    const menu = await f.service.open('backend', 'thread-a', 'owner-a');
    expect((await f.service.action(f.action(menu, { value: 'agy', scope: 'all' }))).success).toBe(true);
    expect(f.dependencies.backend).toHaveBeenCalledWith('thread-a', 'agy', 'all', false);
    const fresh = await f.service.open('backend', 'thread-a', 'owner-a');
    expect((await f.service.action(f.action(fresh, { operation: 'follow_global', value: undefined }))).success).toBe(true);
    expect(f.dependencies.backend).toHaveBeenLastCalledWith('thread-a', 'codex', 'thread', true);
  });

  it('views another backend without changing the coordinator and replaces the snapshot', async () => {
    const f = fixture();
    const menu = await f.service.open('model', 'thread-a', 'owner-a');
    const viewed = await f.service.action(f.action(menu, { operation: 'view', value: undefined, targetBackend: 'agy' }));
    expect(viewed.success).toBe(true);
    expect(viewed.menu).toMatchObject({ targetBackend: 'agy', coordinatorBackend: 'codex', configuredValue: undefined });
    expect(viewed.menu!.snapshotId).not.toBe(menu.snapshotId);
    expect(f.dependencies.preference).not.toHaveBeenCalled();
    expect((await f.service.action(f.action(menu))).error).toContain('stale');
    expect((await f.service.action(f.action(viewed.menu!))).success).toBe(true);
    expect(f.dependencies.preference).toHaveBeenCalledWith('thread-a', 'agy', 'model', 'model-a');
  });

  it.each(['model', 'effort'] as const)('applies and explicitly resets %s with no scope or backend interpolation', async kind => {
    const f = fixture();
    const menu = await f.service.open(kind, 'thread-a', 'owner-a');
    expect(menu).toMatchObject({ effectiveSource: 'native', defaultValue: 'model-b', supportsReset: true,
      configuredValue: kind === 'model' ? 'saved-model' : 'high' });
    const result = await f.service.action(f.action(menu, { operation: 'reset', value: undefined }));
    expect(result.success).toBe(true);
    expect(f.dependencies.preference).toHaveBeenCalledWith('thread-a', 'codex', kind, undefined);
  });

  it('keeps applied state acknowledged when its optional refresh fails', async () => {
    const f = fixture();
    const menu = await f.service.open('model', 'thread-a', 'owner-a');
    vi.mocked(f.dependencies.preference).mockImplementationOnce(async () => { f.states.delete('thread-a'); return { success: true }; });
    const result = await f.service.action(f.action(menu));
    expect(result).toMatchObject({ success: true, menu: undefined, error: undefined });
  });

  it('deduplicates in-flight clicks and lost-ACK retries before revalidating stale cards', async () => {
    const f = fixture();
    const menu = await f.service.open('model', 'thread-a', 'owner-a');
    let release!: () => void;
    vi.mocked(f.dependencies.preference).mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { success: true }; });
    const request = f.action(menu);
    const first = f.service.action(request);
    const retry = f.service.action({ ...request, timestamp: request.timestamp + 1 });
    await vi.waitFor(() => expect(f.dependencies.preference).toHaveBeenCalledTimes(1));
    release();
    expect(await retry).toEqual(await first);
    f.service.invalidate();
    expect(await f.service.action(request)).toEqual(await first);
    expect(f.dependencies.preference).toHaveBeenCalledTimes(1);
    expect((await f.service.action({ ...request, value: 'model-b' })).error).toContain('different settings action');
  });

  it.each([
    { openId: 'owner-b' }, { threadId: 'thread-b' }, { snapshotId: 'other-snapshot' },
  ])('rejects an action outside its original identity: %j', async changed => {
    const f = fixture();
    const menu = await f.service.open('model', 'thread-a', 'owner-a');
    expect((await f.service.action(f.action(menu, changed))).success).toBe(false);
    expect(f.dependencies.preference).not.toHaveBeenCalled();
  });

  it.each([
    { value: 'unlisted-model' }, { value: 'model-a', scope: 'all' }, { targetBackend: 'agy' },
    { operation: 'view', targetBackend: 'agy', value: 'model-a' },
    { operation: 'view', targetBackend: 'pi', value: undefined },
    { operation: 'view', scope: 'all', value: undefined },
    { operation: 'follow_global', value: undefined }, { operation: 'reset', value: 'model-a' },
  ] as Partial<SettingsActionMessage>[])('rejects invented or incompatible card payloads: %j', async fields => {
    const f = fixture();
    const menu = await f.service.open('model', 'thread-a', 'owner-a');
    expect((await f.service.action(f.action(menu, fields))).success).toBe(false);
    expect(f.dependencies.preference).not.toHaveBeenCalled();
  });

  it.each([
    { value: 'pi' }, { operation: 'reset', value: undefined },
    { operation: 'follow_global', value: undefined, scope: 'all' },
    { operation: 'follow_global', value: 'codex' }, { value: 'agy', scope: 'invalid' },
  ] as Partial<SettingsActionMessage>[])('rejects disabled and incompatible backend choices: %j', async fields => {
    const f = fixture();
    const menu = await f.service.open('backend', 'thread-a', 'owner-a');
    expect((await f.service.action(f.action(menu, fields))).success).toBe(false);
    expect(f.dependencies.backend).not.toHaveBeenCalled();
  });

  it('rejects disabled model choices and unsupported resets', async () => {
    const f = fixture();
    f.catalog.choices[0].disabled = true;
    f.catalog.supportsReset = false;
    const menu = await f.service.open('model', 'thread-a', 'owner-a');
    expect((await f.service.action(f.action(menu))).success).toBe(false);
    expect((await f.service.action(f.action(menu, { operation: 'reset', value: undefined }))).success).toBe(false);
  });

  it('rejects expired cards, deleted threads and changed revisions without a native write', async () => {
    const f = fixture();
    const menu = await f.service.open('model', 'thread-a', 'owner-a');
    f.advance(15 * 60_000);
    expect((await f.service.action(f.action(menu))).success).toBe(false);
    const fresh = await f.service.open('model', 'thread-a', 'owner-a');
    f.states.get('thread-a')!.revision = 'revision-b';
    expect((await f.service.action(f.action(fresh))).success).toBe(false);
    const latest = await f.service.open('model', 'thread-a', 'owner-a');
    f.states.delete('thread-a');
    expect((await f.service.action(f.action(latest))).success).toBe(false);
    expect(f.dependencies.preference).not.toHaveBeenCalled();
  });

  it('retains unknown, unavailable, missing and busy catalog states without querying a model', async () => {
    const f = fixture();
    expect((await f.service.open('model', 'thread-a', 'owner-a', 'pi')).unavailableReason).toContain('not installed');
    vi.mocked(f.dependencies.busy).mockReturnValue(true);
    const busy = await f.service.open('effort', 'thread-a', 'owner-a', 'codex', 'opening-request');
    expect(busy).toMatchObject({ busy: true, supportsReset: false, choices: [] });
    expect(f.dependencies.busy).toHaveBeenLastCalledWith('thread-a', 'opening-request', true);
    vi.mocked(f.dependencies.busy).mockReturnValue(false);
    expect((await f.service.action(f.action(busy))).error).toContain('busy');
    expect(f.dependencies.catalog).not.toHaveBeenCalled();
    vi.mocked(f.dependencies.catalog).mockRejectedValueOnce(new Error('Private native details'));
    const unavailable = await f.service.open('model', 'thread-a', 'owner-a');
    expect(unavailable.unavailableReason).toContain('usable native catalog');
    expect(unavailable.unavailableReason).not.toContain('authentication');
    expect(JSON.stringify(unavailable)).not.toContain('Private native details');
    f.catalog.choices = [];
    expect((await f.service.open('model', 'thread-a', 'owner-a')).unavailableReason).toContain('No selectable options');
  });

  it('rechecks all affected threads and installation under the admission barrier', async () => {
    const f = fixture();
    const menu = await f.service.open('backend', 'thread-a', 'owner-a');
    vi.mocked(f.dependencies.busy).mockImplementation(id => id === 'thread-b');
    expect((await f.service.action(f.action(menu, { value: 'agy', scope: 'all' }))).error).toContain('busy');
    vi.mocked(f.dependencies.busy).mockReturnValue(false);
    f.rows.find(row => row.value === 'agy')!.installed = false;
    expect((await f.service.action(f.action(menu, { value: 'agy' }))).error).toContain('no longer available');
    expect(f.dependencies.backend).not.toHaveBeenCalled();
  });

  it('rejects state or busy changes that happen while rechecking the backend list', async () => {
    const f = fixture();
    const menu = await f.service.open('model', 'thread-a', 'owner-a');
    vi.mocked(f.dependencies.backends).mockImplementationOnce(async () => {
      f.states.get('thread-a')!.revision = 'revision-b'; return f.rows;
    });
    expect((await f.service.action(f.action(menu))).success).toBe(false);
    const fresh = await f.service.open('model', 'thread-a', 'owner-a');
    vi.mocked(f.dependencies.busy).mockReturnValueOnce(false).mockReturnValueOnce(true);
    expect((await f.service.action(f.action(fresh))).error).toContain('became busy');
    expect(f.dependencies.preference).not.toHaveBeenCalled();
  });

  it('distinguishes queued preference changes from backend queue-clearing semantics', async () => {
    const f = fixture();
    const model = await f.service.open('model', 'thread-a', 'owner-a');
    expect(f.dependencies.busy).toHaveBeenLastCalledWith('thread-a', undefined, true);
    await f.service.action(f.action(model));
    const backend = await f.service.open('backend', 'thread-a', 'owner-a');
    expect(f.dependencies.busy).toHaveBeenLastCalledWith('thread-a', undefined, false);
    await f.service.action(f.action(backend, { value: 'agy' }));
    expect(f.dependencies.busy).toHaveBeenLastCalledWith('thread-a', undefined, false);
  });

  it('does not claim applied state after a partial failure or disclose backend exception details', async () => {
    const f = fixture();
    const menu = await f.service.open('model', 'thread-a', 'owner-a');
    vi.mocked(f.dependencies.preference).mockRejectedValueOnce(new Error('Native exception at /private/example/config'));
    const request = f.action(menu);
    const failure = await f.service.action(request);
    expect(failure).toMatchObject({ success: false });
    expect(failure.error).not.toContain('/private');
    expect(await f.service.action(request)).toEqual(failure);
    expect((await f.service.action(f.action(menu))).error).toContain('stale');
    const fresh = await f.service.open('model', 'thread-a', 'owner-a');
    vi.mocked(f.dependencies.preference).mockResolvedValueOnce({ success: false, error: 'Provider error' });
    expect((await f.service.action(f.action(fresh))).error).toContain('not confirmed');
  });

  it('retains immutable original values and bounds labels, choices and omission accounting', async () => {
    const f = fixture();
    f.catalog.choices = [
      { value: 'opaque  model', label: '<b>Model</b>', description: 'x'.repeat(300) },
      { value: 'opaque  model', label: 'Duplicate' }, { value: 'bad\nvalue', label: 'Bad' },
      ...Array.from({ length: 520 }, (_, i) => ({ value: `model-${i}`, label: '\u{1f600}'.repeat(180) })),
    ];
    const menu = await f.service.open('model', 'thread-a', 'owner-a');
    expect(menu.choices).toHaveLength(512);
    expect(menu.omittedChoices).toBe(9);
    expect(menu.choices[0]).toMatchObject({ value: 'opaque  model', label: '<b>Model</b>' });
    expect(menu.choices[0].description).toHaveLength(240);
    expect(Array.from(menu.choices[1].label)).toHaveLength(120);
    menu.choices.push({ value: 'injected', label: 'Injected' });
    expect((await f.service.action(f.action(menu, { value: 'injected' }))).success).toBe(false);
    expect((await f.service.action(f.action(menu, { value: 'opaque  model' }))).success).toBe(true);
    expect(f.dependencies.preference).toHaveBeenCalledWith('thread-a', 'codex', 'model', 'opaque  model');
  });

  it.each(['invalidate', 'destroy'] as const)('does not publish in-flight menus after %s', async operation => {
    const f = fixture();
    let resolve!: (value: SettingsCatalog) => void;
    vi.mocked(f.dependencies.catalog).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const opening = f.service.open('model', 'thread-a', 'owner-a');
    await vi.waitFor(() => expect(f.dependencies.catalog).toHaveBeenCalled());
    f.service[operation]();
    resolve(f.catalog);
    await expect(opening).rejects.toThrow('Settings changed');
    if (operation === 'destroy') await expect(f.service.open('backend', 'thread-a', 'owner-a')).rejects.toThrow('no longer available');
  });

  it('rejects a changed query revision and invalid opening identities', async () => {
    const f = fixture();
    vi.mocked(f.dependencies.catalog).mockImplementationOnce(async () => { f.states.get('thread-a')!.revision = 'revision-b'; return f.catalog; });
    await expect(f.service.open('model', 'thread-a', 'owner-a')).rejects.toThrow('Settings changed');
    await expect(f.service.open('model', 'missing-thread', 'owner-a')).rejects.toThrow('no longer exists');
    await expect(f.service.open('model', 'thread-a', '')).rejects.toThrow('Invalid settings owner');
    await expect(f.service.open('model', 'thread-a', 'owner-a', 'invalid' as SettingsBackend)).rejects.toThrow('Invalid settings backend');
  });

  it('caps both open and concurrent reserved menus, and releases expired capacity', async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 200 }, () => f.service.open('backend', 'thread-a', 'owner-a')));
    await expect(f.service.open('backend', 'thread-a', 'owner-a')).rejects.toThrow('Too many settings cards');
    f.advance(15 * 60_000);
    expect((await f.service.open('backend', 'thread-a', 'owner-a')).choices).toHaveLength(8);
  });

  it('caps retained action receipts without evicting valid deduplication records', async () => {
    const f = fixture();
    const menu = await f.service.open('backend', 'thread-a', 'owner-a');
    for (let i = 0; i < 1_000; i++) await f.service.action(f.action(menu, { value: 'pi' }));
    expect((await f.service.action(f.action(menu, { value: 'agy' }))).error).toContain('storage is full');
    f.advance(20 * 60_000);
    const fresh = await f.service.open('backend', 'thread-a', 'owner-a');
    expect((await f.service.action(f.action(fresh, { value: 'agy' }))).success).toBe(true);
  });

  it.each([{ messageId: '' }, { openId: '' }, { threadId: 'bad\nthread' }, { snapshotId: '' }, { operation: 'invalid' }])('rejects malformed envelopes: %j', async fields => {
    const f = fixture();
    const menu = await f.service.open('model', 'thread-a', 'owner-a');
    expect((await f.service.action({ ...f.action(menu), ...fields } as SettingsActionMessage)).error).toBe('Invalid settings action.');
    expect(f.dependencies.preference).not.toHaveBeenCalled();
  });
});

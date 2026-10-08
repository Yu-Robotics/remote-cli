import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsCards, sanitizeSettingsMenu } from '../src/feishu/SettingsCards';
import type { SettingsMenu } from '../src/types/Settings';
import { SettingsService } from '../../cli/src/settings/SettingsService';

const BACKENDS = [
  ['claude', 'Claude Code'], ['codex', 'Codex CLI'], ['opencode', 'OpenCode'], ['kimi', 'Kimi Code'],
  ['zcode', 'ZCode'], ['pi', 'Pi'], ['agy', 'AGY'], ['dsh', 'DSH'],
] as const;

function backendMenu(overrides: Partial<SettingsMenu> = {}): SettingsMenu {
  return {
    snapshotId: 'snap-backend', kind: 'backend', threadId: 'thread-1', threadName: 'default',
    coordinatorBackend: 'claude', targetBackend: 'claude',
    backends: BACKENDS.map(([value, label]) => ({ value, label, installed: value !== 'pi' && value !== 'zcode',
      ...((value === 'pi' || value === 'zcode') ? { reason: 'Executable is missing' } : {}) })),
    choices: [], effectiveSource: 'configured', supportsReset: false, followsGlobal: false,
    busy: false, expiresAt: Date.now() + 60_000, ...overrides,
  };
}

function modelMenu(overrides: Partial<SettingsMenu> = {}): SettingsMenu {
  return {
    snapshotId: 'snap-model', kind: 'model', threadId: 'thread-1', threadName: 'default',
    coordinatorBackend: 'claude', targetBackend: 'claude',
    backends: BACKENDS.map(([value, label]) => ({ value, label, installed: true })),
    choices: [
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet **bold** <at id=all>x</at>' },
      { value: 'haiku', label: 'Haiku', disabled: true, reason: 'Not entitled' },
    ],
    configuredValue: 'opus', effectiveValue: 'opus', defaultValue: 'sonnet',
    effectiveSource: 'native', supportsReset: true, busy: false, expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function taggedNodes(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  let count = (value as any).tag ? 1 : 0;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (Array.isArray(child)) for (const item of child) count += taggedNodes(item);
    else if (child && typeof child === 'object') count += taggedNodes(child);
  }
  return count;
}

function buttonsOf(elements: any[]): any[] {
  const found: any[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'button') found.push(node);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  };
  elements.forEach(visit);
  return found;
}

describe('SettingsCards', () => {
  let cards: SettingsCards;
  let transport: any;
  const flush = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    transport = {
      ownsDevice: vi.fn(async () => true),
      available: vi.fn(() => true),
      send: vi.fn(async () => true),
      update: vi.fn(async () => {}),
    };
    cards = new SettingsCards(transport);
  });
  afterEach(() => { cards.destroy(); vi.useRealTimers(); });

  function present(menu: SettingsMenu, cardId = 'card-1') {
    const prepared = cards.present({ openId: 'owner', deviceId: 'device', menu, requestMessageId: 'req-1' });
    expect(prepared).toBeDefined();
    prepared!.deliver([cardId]);
    return prepared!;
  }

  function clickPayload(elements: any[], op: string, value?: string) {
    const button = buttonsOf(elements).find(candidate => {
      const behavior = candidate.behaviors?.[0]?.value;
      return behavior?.op === op && (value === undefined || behavior?.value === value) && !candidate.disabled;
    });
    expect(button, `enabled ${op} button${value ? ` (${value})` : ''}`).toBeDefined();
    return button!.behaviors[0].value;
  }

  it('renders all backend rows with unavailable entries disabled, current-thread default and confirm', () => {
    const { elements } = present(backendMenu());
    expect(taggedNodes(elements)).toBeLessThanOrEqual(90);
    expect(Buffer.byteLength(JSON.stringify(elements))).toBeLessThanOrEqual(16 * 1024);
    const buttons = buttonsOf(elements);
    const backendButtons = buttons.filter(button => button.behaviors[0].value.op === 'draft_backend');
    expect(backendButtons).toHaveLength(8);
    const pi = backendButtons.find(button => button.behaviors[0].value.value === 'pi')!;
    expect(pi.disabled).toBe(true);
    const json = JSON.stringify(elements);
    expect(json).toContain('Executable is missing');
    // Draft defaults to the current backend and Current thread scope.
    expect(backendButtons.find(button => button.behaviors[0].value.value === 'claude')!.type).toBe('primary');
    const scopeButtons = buttons.filter(button => button.behaviors[0].value.op === 'draft_scope');
    expect(scopeButtons.find(button => button.behaviors[0].value.value === 'thread')!.type).not.toBe('primary');
    expect(scopeButtons.find(button => button.behaviors[0].value.value === 'thread')!.text.content).toContain('✓');
    expect(buttons.some(button => button.behaviors[0].value.op === 'apply' && button.text.content === 'Confirm')).toBe(true);
    expect(buttons.some(button => button.behaviors[0].value.op === 'draft_follow_global')).toBe(true);
    // Fallback of the warning about global scope only after opting in.
    expect(json).not.toContain('clears per-thread');
  });

  it('keeps draft toggles local and requires Confirm for the apply action', async () => {
    const { elements } = present(backendMenu());
    let toast = await cards.click('owner', 'card-1', clickPayload(elements, 'draft_backend', 'codex'));
    expect(toast).toContain('Confirm');
    toast = await cards.click('owner', 'card-1', clickPayload(elements, 'draft_scope', 'all'));
    expect(toast).toContain('all threads');
    expect(transport.send).not.toHaveBeenCalled();
    await flush();
    // The re-rendered card shows the global-scope warning and new revision.
    const patched = transport.update.mock.calls.at(-1);
    expect(patched[0]).toBe('card-1');
    expect(JSON.stringify(patched[1])).toContain('clears per-thread backend overrides');
    const confirm = clickPayload(patched[1], 'apply');
    toast = await cards.click('owner', 'card-1', confirm);
    expect(toast).toContain('Applying');
    expect(transport.send).toHaveBeenCalledTimes(1);
    const action = transport.send.mock.calls[0][1];
    expect(action).toMatchObject({ type: 'settings_action', openId: 'owner', threadId: 'thread-1',
      snapshotId: 'snap-backend', operation: 'apply', value: 'codex', scope: 'all' });
    expect(typeof action.messageId).toBe('string');
  });

  it('hides the global warning for thread scope and offers follow-global only with an override', async () => {
    const withGlobal = present(backendMenu({ followsGlobal: true }));
    expect(buttonsOf(withGlobal.elements).some(button => button.behaviors[0].value.op === 'draft_follow_global')).toBe(false);
    const { elements } = present(backendMenu({ followsGlobal: false, threadId: 'thread-2' }), 'card-2');
    const toast = await cards.click('owner', 'card-2', clickPayload(elements, 'draft_follow_global'));
    expect(toast).toContain('global');
    expect(transport.send).not.toHaveBeenCalled();
    await flush();
    await cards.click('owner', 'card-2', clickPayload(transport.update.mock.calls.at(-1)[1], 'apply'));
    const action = transport.send.mock.calls.at(-1)[1];
    expect(action).toMatchObject({ operation: 'follow_global', threadId: 'thread-2' });
    expect(action.value).toBeUndefined();
    expect(action.scope).toBeUndefined();
  });

  it('applies native choices immediately, emits view for target backends and honors reset support', async () => {
    const { elements } = present(modelMenu());
    // Immediate choice submission without a confirmation step.
    const toast = await cards.click('owner', 'card-1', clickPayload(elements, 'apply', 'sonnet'));
    expect(toast).toContain('Applying');
    const action = transport.send.mock.calls.at(-1)[1];
    expect(action).toMatchObject({ type: 'settings_action', operation: 'apply', value: 'sonnet', snapshotId: 'snap-model' });
    await cards.resolve('device', { type: 'settings_result', messageId: action.messageId, openId: 'owner',
      threadId: 'thread-1', snapshotId: 'snap-model', success: true,
      menu: modelMenu({ targetBackend: 'codex', configuredValue: 'gpt-5', choices: [{ value: 'gpt-5', label: 'GPT-5' }] }), timestamp: Date.now() });
    await flush();
    const patched = JSON.stringify(transport.update.mock.calls.at(-1)[1]);
    expect(patched).toContain('GPT-5');
    // Fresh menu state replaced the old target; effort lists/buttons from the old model are gone.
    expect(patched).not.toContain('"value":"haiku"');
    // Target backend switch emits a view, not a mutation.
    const viewPayload = clickPayload(transport.update.mock.calls.at(-1)[1], 'view', 'kimi');
    await cards.click('owner', 'card-1', viewPayload);
    expect(transport.send.mock.calls.at(-1)[1]).toMatchObject({ operation: 'view', targetBackend: 'kimi' });
  });

  it('omits the reset control without support and rejects forged reset clicks', async () => {
    const { elements } = present(modelMenu({ supportsReset: false }));
    expect(buttonsOf(elements).some(button => button.behaviors[0].value.op === 'reset')).toBe(false);
    const anyButton = buttonsOf(elements)[0].behaviors[0].value;
    await expect(cards.click('owner', 'card-1', { ...anyButton, op: 'reset' })).rejects.toThrow('not available');
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('binds callbacks to the owner, current device, delivered card and snapshot values only', async () => {
    const { elements } = present(modelMenu());
    const choice = clickPayload(elements, 'apply', 'opus');
    await expect(cards.click('stranger', 'card-1', choice)).rejects.toThrow('another user');
    await expect(cards.click('owner', 'forged-card', choice)).rejects.toThrow('expired');
    await expect(cards.click('owner', 'card-1', { ...choice, id: 'forged' })).rejects.toThrow('expired');
    // A value outside the stored snapshot is never sent.
    await expect(cards.click('owner', 'card-1', { ...choice, value: 'invented-model' })).rejects.toThrow('not available');
    // A revision from the future or past cannot drive a mutation.
    await expect(cards.click('owner', 'card-1', { ...choice, rev: choice.rev + 1 })).rejects.toThrow('outdated');
    await expect(cards.click('owner', 'card-1', { ...choice, rev: choice.rev - 1 })).rejects.toThrow('outdated');
    transport.ownsDevice.mockResolvedValue(false);
    await expect(cards.click('owner', 'card-1', choice)).rejects.toThrow('another user');
    transport.ownsDevice.mockResolvedValue(true);
    transport.available.mockReturnValue(false);
    await expect(cards.click('owner', 'card-1', choice)).rejects.toThrow('offline');
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('suppresses double-clicks while pending and applies only the matching result', async () => {
    const { elements } = present(modelMenu());
    await cards.click('owner', 'card-1', clickPayload(elements, 'apply', 'opus'));
    const request = transport.send.mock.calls[0][1];
    const again = await cards.click('owner', 'card-1', clickPayload(elements, 'apply', 'opus'));
    expect(again).toContain('Waiting');
    expect(transport.send).toHaveBeenCalledTimes(1);
    // A result with a mismatched snapshot cannot resolve the pending request.
    await cards.resolve('device', { type: 'settings_result', messageId: request.messageId, openId: 'owner',
      threadId: 'thread-1', snapshotId: 'other-snapshot', success: true, timestamp: Date.now() });
    const stillPending = await cards.click('owner', 'card-1', clickPayload(elements, 'apply', 'opus'));
    expect(stillPending).toContain('Waiting');
    await cards.resolve('device', { type: 'settings_result', messageId: request.messageId, openId: 'owner',
      threadId: 'thread-1', snapshotId: 'snap-model', success: false, error: 'Model not available for this account', timestamp: Date.now() });
    await flush();
    expect(JSON.stringify(transport.update.mock.calls.at(-1)[1])).toContain('Model not available for this account');
  });

  it('treats a timeout as unknown and retries confirmation with the same immutable request ID', async () => {
    const { elements } = present(modelMenu());
    await cards.click('owner', 'card-1', clickPayload(elements, 'apply', 'opus'));
    const request = transport.send.mock.calls[0][1];
    await vi.advanceTimersByTimeAsync(20_000);
    expect(JSON.stringify(transport.update.mock.calls.at(-1)[1])).toContain('may or may not have been applied');
    const unknown = transport.update.mock.calls.at(-1)[1];
    expect(buttonsOf(unknown).filter(button => button.behaviors[0].value.op === 'apply').every(button => button.disabled)).toBe(true);
    await cards.click('owner', 'card-1', clickPayload(unknown, 'retry'));
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(transport.send.mock.calls[1][1]).toEqual(request);
    await cards.resolve('device', { type: 'settings_result', messageId: request.messageId, openId: 'owner',
      threadId: 'thread-1', snapshotId: 'snap-model', success: true, timestamp: Date.now() });
    await flush();
    expect(JSON.stringify(transport.update.mock.calls.at(-1)[1])).toContain('Applied.');
    expect(buttonsOf(transport.update.mock.calls.at(-1)[1])).toHaveLength(0);
  });

  it('fails honestly when the CLI cannot be reached and never claims success', async () => {
    const { elements } = present(modelMenu());
    transport.send.mockResolvedValue(false);
    await expect(cards.click('owner', 'card-1', clickPayload(elements, 'apply', 'opus'))).rejects.toThrow('Could not contact');
    await flush();
    expect(JSON.stringify(transport.update.mock.calls.at(-1)[1])).toContain('Could not contact');
  });

  it('deduplicates a lost-ACK retry through the actual CLI settings service', async () => {
    let revision = 'before';
    let configured = 'opus';
    let acknowledge = false;
    const preference = vi.fn(async (_thread: string, _backend: string, _kind: string, value: string | undefined) => {
      configured = value!; revision = 'after'; return { success: true };
    });
    const service = new SettingsService({
      state: () => ({ threadId: 'thread-1', threadName: 'default', coordinatorBackend: 'claude', followsGlobal: true,
        revision, configuredModels: { claude: configured }, configuredEfforts: {} }),
      backends: async () => modelMenu().backends,
      catalog: async () => ({ choices: modelMenu().choices, effectiveSource: 'configured', supportsReset: true }),
      busy: () => false, threads: () => ['thread-1'], exclusive: (_target, body) => body(),
      backend: async () => ({ success: true }), preference,
    });
    transport.send.mockImplementation(async (_device: string, request: any) => {
      const result = await service.action(request);
      if (acknowledge) await cards.resolve('device', result);
      return true;
    });
    const menu = await service.open('model', 'thread-1', 'owner');
    const { elements } = present(menu);
    await cards.click('owner', 'card-1', clickPayload(elements, 'apply', 'sonnet'));
    expect(preference).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    const original = transport.send.mock.calls[0][1];
    acknowledge = true;
    await cards.click('owner', 'card-1', clickPayload(transport.update.mock.calls.at(-1)[1], 'retry'));
    await flush();
    expect(preference).toHaveBeenCalledTimes(1);
    expect(transport.send.mock.calls[1][1]).toEqual(original);
    expect(JSON.stringify(transport.update.mock.calls.at(-1)[1])).toContain('Setting applied.');
    expect(JSON.stringify(transport.update.mock.calls.at(-1)[1])).toContain('sonnet');
    service.destroy();
  });

  it('accepts a matching late acknowledgement but never revives a superseded card', async () => {
    const first = present(modelMenu());
    await cards.click('owner', 'card-1', clickPayload(first.elements, 'apply', 'opus'));
    const request = transport.send.mock.calls[0][1];
    await vi.advanceTimersByTimeAsync(20_000);
    await cards.resolve('device', { type: 'settings_result', messageId: request.messageId, openId: 'owner',
      threadId: 'thread-1', snapshotId: 'snap-model', success: true, timestamp: Date.now() });
    await flush();
    expect(JSON.stringify(transport.update.mock.calls.at(-1)[1])).toContain('Applied.');
    const second = present(modelMenu({ snapshotId: 'new-snapshot' }), 'card-2');
    const before = JSON.stringify(second.elements);
    await cards.resolve('device', { type: 'settings_result', messageId: request.messageId, openId: 'owner',
      threadId: 'thread-1', snapshotId: 'snap-model', success: true, menu: modelMenu(), timestamp: Date.now() });
    await flush();
    expect(JSON.stringify(second.elements)).toBe(before);
    await expect(cards.click('owner', 'card-1', clickPayload(first.elements, 'apply', 'opus'))).rejects.toThrow('Applied.');
  });

  it('revalidates binding after asynchronous ownership lookup races with disconnect', async () => {
    const { elements } = present(modelMenu());
    let release!: (allowed: boolean) => void;
    transport.ownsDevice.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
    const clicking = cards.click('owner', 'card-1', clickPayload(elements, 'apply', 'opus'));
    const failure = expect(clicking).rejects.toThrow('expired');
    cards.disconnect('device');
    release(true);
    await failure;
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('lets a busy preference menu refresh while keeping all mutations disabled', async () => {
    const { elements } = present(modelMenu({ busy: true, choices: [] }));
    const refresh = buttonsOf(elements).find(button => button.text.content === 'Refresh');
    expect(refresh.disabled).toBe(false);
    expect(buttonsOf(elements).filter(button => ['apply', 'reset'].includes(button.behaviors[0].value.op)).every(button => button.disabled)).toBe(true);
    await cards.click('owner', 'card-1', refresh.behaviors[0].value);
    const request = transport.send.mock.calls[0][1];
    expect(request).toMatchObject({ operation: 'view', targetBackend: 'claude' });
    await cards.resolve('device', { type: 'settings_result', messageId: request.messageId, openId: 'owner',
      threadId: 'thread-1', snapshotId: 'snap-model', success: true, menu: modelMenu({ snapshotId: 'idle-snapshot' }), timestamp: Date.now() });
    await flush();
    expect(buttonsOf(transport.update.mock.calls.at(-1)[1]).some(button => button.behaviors[0].value.op === 'apply' && !button.disabled)).toBe(true);
  });

  it('paginates large catalogs locally without CLI round-trips', async () => {
    const choices = Array.from({ length: 20 }, (_, index) => ({ value: `model-${index}`, label: `Model ${index}` }));
    const { elements } = present(modelMenu({ choices, omittedChoices: 5 }));
    expect(JSON.stringify(elements)).toContain('5 more via the text command');
    expect(JSON.stringify(elements)).toContain('Model 0');
    expect(JSON.stringify(elements)).not.toContain('Model 9"');
    await cards.click('owner', 'card-1', clickPayload(elements, 'page', '1'));
    expect(transport.send).not.toHaveBeenCalled();
    await flush();
    const patched = transport.update.mock.calls.at(-1)[1];
    expect(JSON.stringify(patched)).toContain('Model 9');
    expect(JSON.stringify(patched)).not.toContain('Model 0"');
    await expect(cards.click('owner', 'card-1', { ...clickPayload(patched, 'page', '2'), value: '9' })).rejects.toThrow('page');
  });

  it('renders markup-shaped labels literally and escapes markdown sections', async () => {
    const { elements } = present(modelMenu());
    const button = buttonsOf(elements).find(candidate => candidate.behaviors[0].value.value === 'sonnet')!;
    expect(button.text.tag).toBe('plain_text');
    expect(button.text.content).toBe('Sonnet **bold** <at id=all>x</at>');
    const markdown = JSON.stringify(elements.filter(element => element.tag === 'markdown'));
    expect(markdown).not.toContain('<at id=all>');
  });

  it('supersedes older cards for the same thread and kind', async () => {
    present(backendMenu());
    const newer = cards.present({ openId: 'owner', deviceId: 'device', menu: backendMenu({ snapshotId: 'snap-2' }), requestMessageId: 'req-2' });
    newer!.deliver(['card-2']);
    await flush();
    expect(JSON.stringify(transport.update.mock.calls.at(-1)[1])).toContain('Superseded');
    await expect(cards.click('owner', 'card-1', { id: 'forged', rev: 1, op: 'apply' })).rejects.toThrow('expired');
  });

  it('invalidates live controls on disconnect and rejects expired menus at presentation', () => {
    expect(cards.present({ openId: 'owner', deviceId: 'device', menu: backendMenu({ expiresAt: Date.now() - 1 }), requestMessageId: 'req-x' })).toBeUndefined();
    const { elements } = present(backendMenu());
    const confirm = clickPayload(elements, 'apply');
    cards.disconnect('device');
    return expect(cards.click('owner', 'card-1', confirm)).rejects.toThrow('expired');
  });

  it('never evicts a menu with a pending request under capacity pressure', async () => {
    const { elements } = present(modelMenu());
    await cards.click('owner', 'card-1', clickPayload(elements, 'apply', 'opus'));
    for (let index = 0; index < 150; index++) {
      cards.present({ openId: 'owner', deviceId: 'device', menu: modelMenu({ snapshotId: `s-${index}`, threadId: `t-${index % 90}` }), requestMessageId: `r-${index}` });
    }
    await cards.resolve('device', { type: 'settings_result', messageId: transport.send.mock.calls[0][1].messageId,
      openId: 'owner', threadId: 'thread-1', snapshotId: 'snap-model', success: true, notice: 'Done', timestamp: Date.now() });
    await flush();
    expect(JSON.stringify(transport.update.mock.calls.at(-1)[1])).toContain('Done');
  });

  it('degrades to a static card when a delivery split across chunks', async () => {
    const prepared = cards.present({ openId: 'owner', deviceId: 'device', menu: backendMenu(), requestMessageId: 'req-1' })!;
    prepared.deliver(['card-a', 'card-b']);
    await flush();
    for (const call of transport.update.mock.calls) {
      expect(JSON.stringify(call[1])).toContain('could not stay interactive');
      expect(buttonsOf(call[1])).toHaveLength(0);
    }
  });
});

describe('sanitizeSettingsMenu', () => {
  it('rejects malformed menus and bounds untrusted fields', () => {
    expect(sanitizeSettingsMenu(undefined)).toBeUndefined();
    expect(sanitizeSettingsMenu({ kind: 'backend' })).toBeUndefined();
    expect(sanitizeSettingsMenu(modelMenu({ kind: 'nope' as any }))).toBeUndefined();
    expect(sanitizeSettingsMenu(modelMenu({ backends: [] }))).toBeUndefined();
    expect(sanitizeSettingsMenu(modelMenu({ expiresAt: Number.NaN }))).toBeUndefined();
    const huge = sanitizeSettingsMenu(modelMenu({
      choices: Array.from({ length: 500 }, (_, index) => ({ value: `v-${index}`, label: `L${index}`.repeat(200) })),
    }))!;
    expect(huge.choices).toHaveLength(500);
    expect(huge.choices[0].label.length).toBeLessThanOrEqual(80);
    const duplicate = sanitizeSettingsMenu(modelMenu({
      choices: [{ value: 'same', label: 'One' }, { value: 'same', label: 'Two' }],
    }))!;
    expect(duplicate.choices).toHaveLength(1);
  });

  it('preserves complete opaque values without collapsing whitespace or truncating shared prefixes', () => {
    const prefix = 'p'.repeat(240);
    const a = `${prefix}  model-a`;
    const b = `${prefix}  model-b`;
    const menu = sanitizeSettingsMenu(modelMenu({ choices: [{ value: a, label: 'A' }, { value: b, label: 'B' }],
      configuredValue: a, effectiveValue: b, defaultValue: a }))!;
    expect(menu.choices.map(choice => choice.value)).toEqual([a, b]);
    expect(menu).toMatchObject({ configuredValue: a, effectiveValue: b, defaultValue: a });
    expect(sanitizeSettingsMenu(modelMenu({ snapshotId: 's'.repeat(101) }))).toBeUndefined();
    const invalid = sanitizeSettingsMenu(modelMenu({ choices: [
      { value: 'v'.repeat(513), label: 'Overlong' }, { value: 'bad\nvalue', label: 'Control' },
    ] }))!;
    expect(invalid.choices).toEqual([]);
  });

  it('reports bounded catalog omissions and does not split Unicode labels', () => {
    const menu = sanitizeSettingsMenu(modelMenu({ omittedChoices: 3, choices: Array.from({ length: 600 }, (_, index) => ({
      value: `model-${index}`, label: '\u{1f600}'.repeat(120),
    })) }))!;
    expect(menu.choices).toHaveLength(512);
    expect(menu.omittedChoices).toBe(91);
    expect(Array.from(menu.choices[0].label)).toHaveLength(80);
    expect(menu.choices[0].label).not.toContain('\ufffd');
  });
});

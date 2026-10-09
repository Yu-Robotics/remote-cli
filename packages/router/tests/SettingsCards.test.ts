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

function delegationMenu(overrides: Partial<SettingsMenu> = {}): SettingsMenu {
  const base = backendMenu();
  return { ...base, kind: 'delegation', snapshotId: 'snap-delegation', configuredValue: 'on', effectiveValue: 'on',
    choices: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }],
    backends: base.backends.map(backend => ({ ...backend, worker: backend.installed, version: '1.0.0' })), ...overrides };
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

  it('separates delegation controls and availability and changes selection only after ACK', async () => {
    const { elements } = present(delegationMenu());
    const buttons = buttonsOf(elements);
    expect(buttons.filter(button => button.behaviors[0].value.op === 'apply').map(button => button.text.content)).toEqual(['✓ On', 'Off']);
    expect(buttons.find(button => button.text.content === '✓ On')!.type).toBe('primary');
    expect(JSON.stringify(elements)).toContain('**1 · Delegation**');
    expect(JSON.stringify(elements)).toContain('**2 · Backend availability**');
    expect(JSON.stringify(elements)).toContain('Current thread only');
    expect(buttons.some(button => /draft_|reset/.test(button.behaviors[0].value.op) || button.text.content === 'Confirm')).toBe(false);
    await cards.click('owner', 'card-1', clickPayload(elements, 'apply', 'off'));
    await flush();
    const request = transport.send.mock.calls.at(-1)[1];
    expect(request).toMatchObject({ operation: 'apply', value: 'off', threadId: 'thread-1' });
    expect(request).not.toHaveProperty('scope');
    expect(request).not.toHaveProperty('targetBackend');
    let patched = transport.update.mock.calls.at(-1)[1];
    expect(buttonsOf(patched).find(button => button.text.content === '✓ On')!.type).toBe('primary');
    expect(buttonsOf(patched).every(button => button.disabled)).toBe(true);
    await cards.resolve('device', { type: 'settings_result', messageId: request.messageId, openId: 'owner', threadId: 'thread-1',
      snapshotId: 'snap-delegation', success: true, menu: delegationMenu({ snapshotId: 'fresh', configuredValue: 'off', effectiveValue: 'off' }), timestamp: Date.now() });
    await flush();
    const [, body, header] = transport.update.mock.calls.at(-1);
    patched = body;
    expect(buttonsOf(patched).find(button => button.text.content === '✓ Off')!.type).toBe('primary');
    expect(header.title.content).toBe('🤝 Agent delegation');
    expect(taggedNodes({ schema: '2.0', header, body: { elements: body } })).toBeLessThanOrEqual(90);
    expect(Buffer.byteLength(JSON.stringify({ schema: '2.0', header, body: { elements: body } }))).toBeLessThanOrEqual(16 * 1024);
  });

  it('retains the confirmed delegation selection on failure and retries unknown outcomes with the same request', async () => {
    const { elements } = present(delegationMenu());
    await cards.click('owner', 'card-1', clickPayload(elements, 'apply', 'off'));
    const request = transport.send.mock.calls.at(-1)[1];
    await cards.resolve('device', { ...request, type: 'settings_result', success: false, error: 'Synthetic failure' });
    await flush();
    let patched = transport.update.mock.calls.at(-1)[1];
    expect(buttonsOf(patched).find(button => button.text.content === '✓ On')!.type).toBe('primary');
    await cards.click('owner', 'card-1', clickPayload(patched, 'apply', 'off'));
    const pending = transport.send.mock.calls.at(-1)[1];
    await vi.advanceTimersByTimeAsync(20_001);
    await flush();
    patched = transport.update.mock.calls.at(-1)[1];
    expect(JSON.stringify(patched)).toContain('may or may not have been applied');
    await cards.click('owner', 'card-1', clickPayload(patched, 'retry'));
    expect(transport.send.mock.calls.at(-1)[1]).toEqual(pending);
  });

  it('allows delegation refresh while busy without backend targeting and rejects unnegotiated cards', async () => {
    const { elements } = present(delegationMenu({ busy: true }));
    const buttons = buttonsOf(elements);
    expect(buttons.filter(button => button.behaviors[0].value.op === 'apply').every(button => button.disabled)).toBe(true);
    await expect(cards.click('owner', 'card-1', { ...buttons[0].behaviors[0].value, value: 'off' })).rejects.toThrow();
    await cards.click('owner', 'card-1', clickPayload(elements, 'view'));
    expect(transport.send.mock.calls.at(-1)[1]).toMatchObject({ operation: 'view' });
    expect(transport.send.mock.calls.at(-1)[1]).not.toHaveProperty('targetBackend');
    transport.available.mockReturnValue(false);
    expect(cards.present({ openId: 'owner', deviceId: 'device', menu: delegationMenu(), requestMessageId: 'later' })).toBeUndefined();
    expect(transport.available).toHaveBeenCalledWith('device', 'delegation');
  });

  it('renders bounded worker policy details literally and never guesses missing availability', () => {
    const { elements } = present(delegationMenu({ coordinatorBackend: 'zcode', targetBackend: 'zcode', backends: [
      { value: 'zcode', label: 'ZCode', installed: true, worker: false, reason: 'Sandbox <at id=all>blocked</at>' },
      { value: 'opencode', label: 'OpenCode', installed: true, worker: false, reason: 'Sandbox is enabled' },
      { value: 'pi', label: 'Pi', installed: false, reason: 'Executable is missing' },
      { value: 'codex', label: 'Codex', installed: true },
    ] }));
    const output = JSON.stringify(elements);
    expect(output).toContain("<text_tag color='blue'>Coordinator</text_tag> **ZCode**");
    expect(output).toContain("<text_tag color='orange'>Blocked</text_tag> **OpenCode**");
    expect(output).toContain("<text_tag color='red'>Unavailable</text_tag> **Pi**");
    expect(output).toContain("<text_tag color='neutral'>Availability unknown</text_tag> **Codex**");
    expect(output).toContain('&lt;at id=all&gt;');
    expect(output).not.toContain('<at id=all>');
    expect(output).toContain('Off restores the normal MCP configuration');
    expect(sanitizeSettingsMenu(delegationMenu({ configuredValue: undefined }))).toBeUndefined();
    expect(sanitizeSettingsMenu(delegationMenu({ targetBackend: 'codex' }))).toBeUndefined();
    expect(sanitizeSettingsMenu(delegationMenu({ supportsReset: true }))!.supportsReset).toBe(false);
  });

  it('restores colored delegation badges without adding controls or card elements', async () => {
    const { elements } = present(delegationMenu({ backends: [
      { value: 'claude', label: 'Claude Code', installed: true, worker: true, version: '1.0.0' },
      { value: 'codex', label: 'Codex CLI', installed: true, worker: true, version: '1.0.0' },
      { value: 'opencode', label: 'OpenCode', installed: true, worker: false, reason: 'Sandbox is enabled' },
      { value: 'kimi', label: 'Kimi Code', installed: false, worker: true, reason: 'Executable is missing' },
      { value: 'zcode', label: 'ZCode', installed: false, worker: false, reason: 'Executable is missing' },
      { value: 'pi', label: 'Pi', installed: true },
      { value: 'agy', label: 'AGY <text_tag color=red>fake</text_tag>', installed: true, worker: true,
        version: '<at id=all>fake</at>' },
      { value: 'dsh', label: 'DSH', installed: true, worker: false, reason: '<text_tag color=green>fake</text_tag>' },
    ] }));
    const rows = elements.filter(element => element.tag === 'markdown' && element.content.startsWith('<text_tag'));
    expect(rows).toHaveLength(8);
    expect(rows.map(row => row.content.match(/^<text_tag color='([^']+)'>([^<]+)<\/text_tag>/)?.slice(1))).toEqual([
      ['blue', 'Coordinator + Worker'], ['green', 'Installed'], ['orange', 'Blocked'], ['red', 'Unavailable'],
      ['red', 'Unavailable'], ['neutral', 'Availability unknown'], ['green', 'Installed'], ['orange', 'Blocked'],
    ]);
    expect(rows.every(row => (row.content.match(/<text_tag/g) ?? []).length === 1)).toBe(true);
    expect(rows[6].content).toContain('&lt;text\\_tag color=red&gt;fake&lt;/text\\_tag&gt;');
    expect(rows[6].content).toContain('&lt;at id=all&gt;fake&lt;/at&gt;');
    expect(rows[7].content).toContain('&lt;text\\_tag color=green&gt;fake&lt;/text\\_tag&gt;');
    expect(buttonsOf(elements).map(button => button.text.content)).toEqual(['✓ On', 'Off', 'Refresh']);
    expect(rows.every(row => taggedNodes(row) === 1)).toBe(true);
    await cards.click('owner', 'card-1', clickPayload(elements, 'view'));
    await flush();
    const [, body, header] = transport.update.mock.calls.at(-1);
    expect(header.title.content).toBe('🤝 Agent delegation');
    const payload = { schema: '2.0', header, body: { elements: body } };
    expect(taggedNodes(payload)).toBeLessThanOrEqual(90);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(16 * 1024);
  });

  it.each([
    { installed: true, worker: false },
    { installed: true, worker: undefined },
    { installed: false, worker: true },
  ])('does not advertise coordinator worker eligibility without confirmed installation and policy: %j', backend => {
    const { elements } = present(delegationMenu({ backends: [
      { value: 'claude', label: 'Claude Code', ...backend, reason: 'Worker eligibility is not confirmed' },
    ] }));
    const output = JSON.stringify(elements);
    expect(output).toContain("<text_tag color='blue'>Coordinator</text_tag> **Claude Code**");
    expect(output).not.toContain('Coordinator + Worker');
    expect(output).toContain('Worker eligibility is not confirmed');
  });

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
    expect(scopeButtons.find(button => button.behaviors[0].value.value === 'thread')!.type).toBe('primary');
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
        revision, configuredModels: { claude: configured }, configuredEfforts: {}, delegationEnabled: true }),
      backends: async () => modelMenu().backends,
      catalog: async () => ({ choices: modelMenu().choices, effectiveSource: 'configured', supportsReset: true }),
      busy: () => false, threads: () => ['thread-1'], exclusive: (_target, body) => body(),
      backend: async () => ({ success: true }), preference,
      delegationSupported: () => true, delegation: async () => ({ success: true }),
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

  it.each(['model', 'effort'] as const)('shows every %s choice that fits, including more than eight', async kind => {
    const choices = Array.from({ length: 12 }, (_, index) => ({ value: `choice-${index}`, label: `Choice ${index}` }));
    const { elements } = present(modelMenu({ kind, choices }));
    const buttons = buttonsOf(elements);
    expect(buttons.filter(button => button.behaviors[0].value.op === 'apply').map(button => button.behaviors[0].value.value))
      .toEqual(choices.map(choice => choice.value));
    expect(buttons.some(button => button.behaviors[0].value.op === 'page')).toBe(false);
    // Include the real header, not just top-level body elements.
    const header = { title: { tag: 'plain_text', content: kind === 'model' ? '🎯 Model settings' : '⚡ Effort settings' }, template: 'blue' };
    expect(taggedNodes({ header, elements })).toBeLessThanOrEqual(90);
    expect(Buffer.byteLength(JSON.stringify({ header, elements }))).toBeLessThanOrEqual(16 * 1024);
    await cards.click('owner', 'card-1', clickPayload(elements, 'apply', 'choice-11'));
    expect(transport.send.mock.calls.at(-1)[1]).toMatchObject({ operation: 'apply', value: 'choice-11' });
  });

  it.each([false, true])('packs every choice within complete node/byte budgets (long native values=%s)', async longValues => {
    const choices = Array.from({ length: 40 }, (_, index) => ({
      value: longValues ? `value-${index}-${'\u6a21'.repeat(500)}` : `value-${index}`,
      label: `Choice ${index}`,
    }));
    const { elements: initial } = present(modelMenu({ choices, threadName: 't'.repeat(80) }));
    let elements = initial;
    const seen: string[] = [];
    const pageSizes: number[] = [];
    for (let iteration = 0; iteration < choices.length; iteration++) {
      const header = { title: { tag: 'plain_text', content: '🎯 Model settings' }, template: 'blue' };
      expect(taggedNodes({ header, elements })).toBeLessThanOrEqual(90);
      expect(Buffer.byteLength(JSON.stringify({ header, elements }))).toBeLessThanOrEqual(16 * 1024);
      const buttons = buttonsOf(elements);
      const onPage = buttons.filter(button => button.behaviors[0].value.op === 'apply');
      expect(onPage.length).toBeGreaterThan(0);
      seen.push(...onPage.map(button => button.behaviors[0].value.value));
      pageSizes.push(onPage.length);
      const next = buttons.find(button => button.text.content === 'Next ▶' && !button.disabled);
      if (!next) break;
      await cards.click('owner', 'card-1', next.behaviors[0].value);
      await flush();
      elements = transport.update.mock.calls.at(-1)[1];
    }
    expect(seen).toEqual(choices.map(choice => choice.value));
    expect(transport.send).not.toHaveBeenCalled();
    if (longValues) expect(Math.max(...pageSizes)).toBeLessThan(9);
    else expect(pageSizes[0]).toBeGreaterThan(8);
    // Applying an option from the final page retains its exact opaque value.
    await cards.click('owner', 'card-1', clickPayload(elements, 'apply', choices.at(-1)!.value));
    expect(transport.send.mock.calls.at(-1)[1].value).toBe(choices.at(-1)!.value);
  });

  it('rechecks complete capacity for pending, rejected and timed-out states without losing controls', async () => {
    const { elements } = present(modelMenu({ choices: Array.from({ length: 12 }, (_, index) => ({ value: `m-${index}`, label: `Model ${index}` })) }));
    const oldChoice = clickPayload(elements, 'apply', 'm-11');
    await cards.click('owner', 'card-1', oldChoice);
    await flush();
    const request = transport.send.mock.calls.at(-1)[1];
    const checkBudget = () => {
      const [, body, header] = transport.update.mock.calls.at(-1);
      expect(taggedNodes({ header, elements: body })).toBeLessThanOrEqual(90);
      expect(Buffer.byteLength(JSON.stringify({ header, elements: body }))).toBeLessThanOrEqual(16 * 1024);
      expect(buttonsOf(body).length).toBeGreaterThan(0);
      return body;
    };
    expect(buttonsOf(checkBudget()).filter(button => button.behaviors[0].value.op === 'apply').every(button => button.disabled)).toBe(true);
    await cards.resolve('device', { type: 'settings_result', messageId: request.messageId, openId: 'owner', threadId: 'thread-1',
      snapshotId: 'snap-model', success: false, error: '<&'.repeat(150), timestamp: Date.now() });
    await flush();
    const rejected = checkBudget();
    await expect(cards.click('owner', 'card-1', oldChoice)).rejects.toThrow('outdated');
    await cards.click('owner', 'card-1', clickPayload(rejected, 'apply', 'm-0'));
    await vi.advanceTimersByTimeAsync(20_001);
    await flush();
    expect(buttonsOf(checkBudget()).some(button => button.text.content === 'Retry confirmation')).toBe(true);
  });

  it('keeps byte-limited page boundaries stable when callback revisions gain digits', async () => {
    const choices = Array.from({ length: 60 }, (_, index) => ({
      value: `v-${index}-${'\u6a21'.repeat(433)}`, label: `Choice ${index}`,
    }));
    let { elements } = present(modelMenu({ choices, threadName: 'Example', configuredValue: undefined,
      effectiveValue: undefined, defaultValue: undefined, effectiveSource: 'unknown',
      backends: BACKENDS.map(([value]) => ({ value, label: value, installed: true })) }));
    const seen: string[] = [];
    let lastRevision = 0;
    for (let iteration = 0; iteration < choices.length; iteration++) {
      const buttons = buttonsOf(elements);
      seen.push(...buttons.filter(button => button.behaviors[0].value.op === 'apply').map(button => button.behaviors[0].value.value));
      lastRevision = buttons[0].behaviors[0].value.rev;
      const next = buttons.find(button => button.text.content === 'Next ▶' && !button.disabled);
      if (!next) break;
      await cards.click('owner', 'card-1', next.behaviors[0].value);
      await flush();
      const [, body, header] = transport.update.mock.calls.at(-1);
      expect(taggedNodes({ header, elements: body })).toBeLessThanOrEqual(90);
      expect(Buffer.byteLength(JSON.stringify({ schema: '2.0', header, body: { elements: body } }))).toBeLessThanOrEqual(16 * 1024);
      elements = body;
    }
    expect(lastRevision).toBeGreaterThanOrEqual(10);
    expect(seen).toEqual(choices.map(choice => choice.value));
    expect(new Set(seen).size).toBe(choices.length);
    expect(transport.send).not.toHaveBeenCalled();
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

  it('separates the backend card into headed sections with subtitles and dividers', () => {
    const { elements } = present(backendMenu());
    const sectionIndex = (title: string) => elements.findIndex(element => element.tag === 'markdown' && element.content === title);
    const choose = sectionIndex('**1 · Choose backend**');
    const scope = sectionIndex('**2 · Apply to**');
    const confirm = sectionIndex('**3 · Confirm**');
    expect(choose).toBeGreaterThan(-1);
    expect(choose).toBeLessThan(scope);
    expect(scope).toBeLessThan(confirm);
    // Every section opens with a divider and a brief notation-size subtitle.
    for (const index of [choose, scope, confirm]) {
      expect(elements[index - 1]).toEqual({ tag: 'hr' });
      expect(elements[index + 1]).toMatchObject({ tag: 'markdown', text_size: 'notation' });
    }
    expect(elements[choose + 1].content).toContain('Current: **Claude Code**');
    expect(elements[scope + 1].content).toContain('only this thread');
    expect(elements[scope + 1].content).toContain('device-wide backend for this thread only');
    expect(elements[confirm + 1].content).toContain('Only Confirm applies');
    // Controls live inside their own sections, not stacked together.
    const between = (from: number, to: number) => buttonsOf(elements.slice(from + 1, to));
    expect(between(choose, scope).every(button => button.behaviors[0].value.op === 'draft_backend')).toBe(true);
    expect(new Set(between(scope, confirm).map(button => button.behaviors[0].value.op))).toEqual(new Set(['draft_scope', 'draft_follow_global']));
    expect(between(confirm, elements.length).map(button => button.text.content)).toEqual(['Confirm']);
  });

  it('checks Current thread by default and moves the explicit check with the scope draft', async () => {
    const { elements } = present(backendMenu());
    const scopeOf = (root: any[]) => buttonsOf(root).filter(button => button.behaviors[0].value.op === 'draft_scope');
    expect(scopeOf(elements).find(button => button.behaviors[0].value.value === 'thread')!.text.content).toBe('✓ Current thread');
    expect(scopeOf(elements).find(button => button.behaviors[0].value.value === 'all')!.text.content).toBe('All threads');
    expect(scopeOf(elements).find(button => button.behaviors[0].value.value === 'thread')!.type).toBe('primary');
    expect(scopeOf(elements).find(button => button.behaviors[0].value.value === 'all')!.type).toBe('default');
    await cards.click('owner', 'card-1', clickPayload(elements, 'draft_scope', 'all'));
    await flush();
    const patched = transport.update.mock.calls.at(-1)[1];
    expect(scopeOf(patched).find(button => button.behaviors[0].value.value === 'thread')!.text.content).toBe('Current thread');
    expect(scopeOf(patched).find(button => button.behaviors[0].value.value === 'all')!.text.content).toBe('✓ All threads');
    expect(scopeOf(patched).find(button => button.behaviors[0].value.value === 'thread')!.type).toBe('default');
    expect(scopeOf(patched).find(button => button.behaviors[0].value.value === 'all')!.type).toBe('primary');
    expect(JSON.stringify(patched)).toContain('clears per-thread backend overrides');
    await cards.click('owner', 'card-1', { ...clickPayload(patched, 'draft_scope', 'thread') });
    await flush();
    const restored = transport.update.mock.calls.at(-1)[1];
    expect(scopeOf(restored).find(button => button.behaviors[0].value.value === 'thread')!.text.content).toBe('✓ Current thread');
    expect(scopeOf(restored).find(button => button.behaviors[0].value.value === 'thread')!.type).toBe('primary');
    expect(scopeOf(restored).find(button => button.behaviors[0].value.value === 'all')!.type).toBe('default');
    expect(transport.send).not.toHaveBeenCalled();
    expect(JSON.stringify(restored)).not.toContain('clears per-thread');
  });

  it('distinguishes the currently-effective backend from the draft selection', async () => {
    const { elements } = present(backendMenu());
    const backendsOf = (root: any[]) => buttonsOf(root).filter(button => button.behaviors[0].value.op === 'draft_backend');
    const initial = backendsOf(elements).find(button => button.behaviors[0].value.value === 'claude')!;
    expect(initial.text.content).toBe('✓ Claude Code (current)');
    expect(initial.type).toBe('primary');
    await cards.click('owner', 'card-1', clickPayload(elements, 'draft_backend', 'codex'));
    await flush();
    const patched = transport.update.mock.calls.at(-1)[1];
    const draft = backendsOf(patched).find(button => button.behaviors[0].value.value === 'codex')!;
    expect(draft.text.content).toBe('✓ Codex CLI');
    expect(draft.type).toBe('primary');
    const current = backendsOf(patched).find(button => button.behaviors[0].value.value === 'claude')!;
    expect(current.text.content).toBe('Claude Code (current)');
    expect(current.type).not.toBe('primary');
    expect(JSON.stringify(patched)).toContain('Draft: **Codex CLI** — applies after Confirm.');
  });

  it('marks follow-global as the draft while keeping scope on the current thread', async () => {
    const { elements } = present(backendMenu({ followsGlobal: false }));
    await cards.click('owner', 'card-1', clickPayload(elements, 'draft_follow_global'));
    await flush();
    const patched = transport.update.mock.calls.at(-1)[1];
    const json = JSON.stringify(patched);
    expect(json).toContain('Draft: follow the global backend — applies after Confirm.');
    expect(json).toContain('device-wide backend for this thread only');
    const follow = buttonsOf(patched).find(button => button.behaviors[0].value.op === 'draft_follow_global')!;
    expect(follow.text.content).toBe('✓ Follow global');
    expect(follow.type).toBe('primary');
    const scope = buttonsOf(patched).filter(button => button.behaviors[0].value.op === 'draft_scope');
    expect(scope.find(button => button.behaviors[0].value.value === 'thread')!.text.content).toBe('✓ Current thread');
    const backends = buttonsOf(patched).filter(button => button.behaviors[0].value.op === 'draft_backend');
    expect(backends.every(button => !button.text.content.startsWith('✓'))).toBe(true);
    expect(backends.find(button => button.behaviors[0].value.value === 'claude')!.text.content).toBe('Claude Code (current)');
  });

  it('orders the model card as target backend, choices for that target, then secondary actions', () => {
    const { elements } = present(modelMenu());
    const sectionIndex = (title: string) => elements.findIndex(element => element.tag === 'markdown' && typeof element.content === 'string' && element.content.startsWith(title));
    const target = sectionIndex('**1 · Target backend**');
    const choices = sectionIndex('**2 · Model for');
    const actions = sectionIndex('**3 · More actions**');
    expect(target).toBeGreaterThan(-1);
    expect(target).toBeLessThan(choices);
    expect(choices).toBeLessThan(actions);
    expect(elements[choices].content).toBe('**2 · Model for Claude Code**');
    expect(elements[target + 1].content).toContain("never switches the conversation's backend");
    expect(elements[choices + 1].content).toContain('apply it immediately');
    expect(elements[choices + 1].content).toContain('future workers');
    for (const index of [target, choices, actions]) expect(elements[index - 1]).toEqual({ tag: 'hr' });
    // The target backend and the configured choice carry explicit checks.
    const targetButtons = buttonsOf(elements).filter(button => button.behaviors[0].value.op === 'view');
    expect(targetButtons.find(button => button.behaviors[0].value.value === 'claude')!.text.content).toBe('✓ Claude Code');
    const opus = buttonsOf(elements).find(button => button.behaviors[0].value.value === 'opus')!;
    expect(opus.text.content).toBe('✓ Opus');
    expect(opus.type).toBe('primary');
    // Disabled choices keep their literal reason on the button.
    expect(buttonsOf(elements).find(button => button.behaviors[0].value.value === 'haiku')!.text.content).toBe('Haiku (Not entitled)');
  });

  it.each(['model', 'effort'] as const)('separates the main backend from other %s targets, even while viewing a worker backend', async kind => {
    const { elements } = present(modelMenu({ kind, coordinatorBackend: 'claude', targetBackend: 'codex',
      backends: backendMenu().backends }));
    const main = elements.findIndex(element => element.content === '**Main backend · current thread**');
    const others = elements.findIndex(element => element.content === '**Other backends · worker preferences**');
    const choices = elements.findIndex(element => element.content === `**2 · ${kind === 'model' ? 'Model' : 'Effort'} for Codex CLI**`);
    expect(main).toBeGreaterThan(-1);
    expect(others).toBeGreaterThan(main);
    expect(choices).toBeGreaterThan(others);
    expect(elements[others - 1]).toEqual({ tag: 'hr' });
    const mainButtons = buttonsOf(elements.slice(main, others));
    expect(mainButtons.map(button => button.behaviors[0].value.value)).toEqual(['claude']);
    expect(mainButtons[0].type).toBe('default');
    const workerButtons = buttonsOf(elements.slice(others, choices));
    expect(workerButtons.map(button => button.behaviors[0].value.value)).toEqual(BACKENDS.filter(([value]) => value !== 'claude').map(([value]) => value));
    expect(workerButtons.find(button => button.behaviors[0].value.value === 'codex')!.type).toBe('primary');
    expect(workerButtons.find(button => button.behaviors[0].value.value === 'pi')!.disabled).toBe(true);
    await cards.click('owner', 'card-1', mainButtons[0].behaviors[0].value);
    expect(transport.send.mock.calls.at(-1)[1]).toMatchObject({ operation: 'view', targetBackend: 'claude' });
    expect(transport.send.mock.calls.at(-1)[1]).not.toHaveProperty('value');
  });

  it('does not invent a selectable main backend absent from the snapshot', () => {
    const { elements } = present(modelMenu({ coordinatorBackend: 'claude', targetBackend: 'codex',
      backends: [{ value: 'codex', label: 'Codex CLI', installed: true }] }));
    expect(JSON.stringify(elements)).toContain('claude is not available in this menu');
    expect(buttonsOf(elements).some(button => button.behaviors[0].value.value === 'claude')).toBe(false);
  });

  it('separates native effort choices from the target backend and applies without Confirm', async () => {
    const { elements } = present(modelMenu({ kind: 'effort', targetBackend: 'codex',
      configuredValue: 'medium', effectiveValue: 'medium', defaultValue: 'low',
      choices: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] }));
    const target = elements.findIndex(element => element.content === '**1 · Target backend**');
    const choices = elements.findIndex(element => element.content === '**2 · Effort for Codex CLI**');
    const actions = elements.findIndex(element => element.content === '**3 · More actions**');
    expect(target).toBeGreaterThan(-1);
    expect(choices).toBeGreaterThan(target);
    expect(actions).toBeGreaterThan(choices);
    expect(elements[choices - 1]).toEqual({ tag: 'hr' });
    const medium = buttonsOf(elements.slice(choices, actions)).find(button => button.behaviors[0].value.value === 'medium')!;
    expect(medium.text.content).toBe('✓ Medium');
    expect(medium.type).toBe('primary');
    expect(buttonsOf(elements).some(button => button.text.content === 'Confirm')).toBe(false);
    await cards.click('owner', 'card-1', clickPayload(elements, 'apply', 'high'));
    const action = transport.send.mock.calls.at(-1)[1];
    expect(action).toMatchObject({ type: 'settings_action', operation: 'apply', snapshotId: 'snap-model', value: 'high' });
    // The CLI's immutable snapshot supplies kind and target; apply does not override either.
    expect(action).not.toHaveProperty('kind');
    expect(action).not.toHaveProperty('targetBackend');
  });

  it.each([
    { configuredValue: undefined, effectiveValue: 'opus', selected: 'opus' },
    { configuredValue: 'sonnet', effectiveValue: 'opus', selected: 'sonnet' },
    { configuredValue: undefined, effectiveValue: undefined, selected: undefined },
  ])('marks only a known model selection without guessing (%j)', ({ configuredValue, effectiveValue, selected }) => {
    const { elements } = present(modelMenu({ configuredValue, effectiveValue,
      choices: [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }] }));
    const choices = buttonsOf(elements).filter(button => button.behaviors[0].value.op === 'apply');
    const checked = choices.filter(button => button.text.content.startsWith('✓ '));
    expect(checked.map(button => button.behaviors[0].value.value)).toEqual(selected ? [selected] : []);
    expect(choices.filter(button => button.type === 'primary')).toEqual(checked);
  });

  it('keeps sectioned cards within node and byte budgets under long labels and pagination', async () => {
    const long = 'x'.repeat(78);
    const model = present(modelMenu({
      backends: BACKENDS.map(([value]) => ({ value, label: `${value}-${long}`, installed: value !== 'pi',
        ...(value === 'pi' ? { reason: long } : {}) })),
      choices: Array.from({ length: 20 }, (_, index) => ({ value: `m-${index}`, label: `${index}-${long}`,
        ...(index === 3 ? { disabled: true, reason: long } : {}) })),
      omittedChoices: 7, supportsReset: true,
    }));
    expect(taggedNodes(model.elements)).toBeLessThanOrEqual(90);
    expect(Buffer.byteLength(JSON.stringify(model.elements))).toBeLessThanOrEqual(16 * 1024);
    await cards.click('owner', 'card-1', clickPayload(model.elements, 'page', '1'));
    await flush();
    const pageTwo = transport.update.mock.calls.at(-1)[1];
    expect(taggedNodes(pageTwo)).toBeLessThanOrEqual(90);
    expect(Buffer.byteLength(JSON.stringify(pageTwo))).toBeLessThanOrEqual(16 * 1024);

    const backend = present(backendMenu({
      backends: BACKENDS.map(([value]) => ({ value, label: `${value}-${long}`, installed: value !== 'pi' && value !== 'zcode',
        ...((value === 'pi' || value === 'zcode') ? { reason: long } : {}) })),
    }), 'card-2');
    expect(taggedNodes(backend.elements)).toBeLessThanOrEqual(90);
    expect(Buffer.byteLength(JSON.stringify(backend.elements))).toBeLessThanOrEqual(16 * 1024);
    // Long labels stay bounded; the effective backend is still named in the subtitle.
    expect(JSON.stringify(backend.elements)).toContain('Current: **claude-');
    for (const button of buttonsOf(backend.elements)) expect(button.text.content.length).toBeLessThanOrEqual(80);
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

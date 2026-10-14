import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionControl, type PiBindingState, type SessionControlDeps } from '../../src/session/SessionControl';
import { SessionMenuStore, parseSessionBindingCommand, parseSessionMenuCommand, SESSION_MENU_TTL_MS } from '../../src/session/SessionMenu';
import type { SessionCatalog } from '../../src/session/SessionCatalog';
import type { BackendKey } from '../../src/types/config';

const CWD = '/workspace/example';
const ID = 'session-01';
const catalog: SessionCatalog = {
  candidates: [
    { id: ID, name: 'Fix login', source: 'native-local', modifiedAt: 1_700_000_000_000, messageCount: 4, countComplete: true },
    { id: 'session-02', source: 'native-local', modifiedAt: 1_699_000_000_000, messageCount: 0, countComplete: false },
  ],
  complete: true, notes: [],
};

describe('SessionControl', () => {
  let backend: BackendKey;
  let sharing: unknown;
  let busy: boolean;
  let binding: PiBindingState | undefined;
  let holder: string | undefined;
  let revision: string;
  let executor: any;
  let deps: SessionControlDeps;
  let now: number;
  let control: SessionControl;
  const ctx = { openId: 'owner-example', threadId: 'thread-a' };
  const send = (content: string, context = ctx) => control.handle(content, context);
  const token = (text: string, verb: string) => new RegExp(`/${verb} ([A-Za-z0-9_-]{12})`).exec(text)![1];

  beforeEach(() => {
    backend = 'pi';
    sharing = { enabled: true };
    busy = false;
    binding = undefined;
    holder = undefined;
    revision = 'rev-1';
    now = 1_000;
    executor = {
      adoptNativeSession: vi.fn(async () => ({ success: true })),
      detachNativeSession: vi.fn(async () => ({ success: true })),
    };
    deps = {
      sharingConfig: () => sharing,
      backendOf: () => backend,
      workingDirectory: () => CWD,
      threadName: id => (id === 'thread-b' ? 'other' : undefined),
      isBusy: () => busy,
      setBusy: vi.fn(),
      executor: vi.fn(() => executor),
      readCatalog: vi.fn(() => catalog),
      resolvePi: vi.fn((_cwd, id) => (catalog.candidates.some(c => c.id === id) ? { id, file: `/native/${id}.jsonl`, revision } : undefined)),
      piHolder: vi.fn(() => holder),
      piBinding: () => binding,
    };
    control = new SessionControl(deps, new SessionMenuStore(() => now));
  });

  async function confirmToken(row = 1): Promise<string> {
    const list = await send('/resume');
    const selected = await send(`/resume select ${token(list.output!, 'resume select')} ${row}`);
    expect(selected.success).toBe(true);
    return token(selected.output!, 'resume confirm');
  }

  it('lists a selectable Pi catalog and connects only after confirmation', async () => {
    const list = await send('/resume');
    expect(list.output).toContain('Select: `/resume select');
    const selected = await send(`/resume select ${token(list.output!, 'resume select')} 1`);
    expect(selected.output).toContain('Fix login');
    expect(selected.output).toContain('4 messages');
    expect(selected.output).toContain('Local Pi may stay open');
    expect(selected.output).not.toContain('/native/');
    expect(deps.executor).not.toHaveBeenCalled();

    const confirmed = await send(`/resume confirm ${token(selected.output!, 'resume confirm')}`);
    expect(confirmed).toMatchObject({ success: true, output: expect.stringContaining('Connected to Pi session') });
    expect(executor.adoptNativeSession).toHaveBeenCalledWith({ sessionId: ID, sessionFile: `/native/${ID}.jsonl` });
    expect(deps.setBusy).toHaveBeenNthCalledWith(1, 'thread-a', true);
    expect(deps.setBusy).toHaveBeenNthCalledWith(2, 'thread-a', false);
  });

  it('reserves one native file before async startup across different threads', async () => {
    const other = { ...ctx, threadId: 'thread-b' };
    const firstToken = token((await send(`/resume id ${ID}`)).output!, 'resume confirm');
    const secondToken = token((await send(`/resume id ${ID}`, other)).output!, 'resume confirm');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    executor.adoptNativeSession.mockImplementation(async () => { await gate; holder = 'thread-a'; return { success: true }; });
    const first = send(`/resume confirm ${firstToken}`);
    try {
      expect(await send(`/resume confirm ${secondToken}`, other)).toMatchObject({ success: false, error: expect.stringContaining('being connected') });
      expect(executor.adoptNativeSession).toHaveBeenCalledTimes(1);
    } finally { release(); }
    expect((await first).success).toBe(true);
    expect((await send(`/resume id ${ID}`, other)).error).toContain('already used');
  });

  it('allows different native files to connect independently', async () => {
    const other = { ...ctx, threadId: 'thread-b' };
    const a = token((await send(`/resume id ${ID}`)).output!, 'resume confirm');
    const b = token((await send('/resume id session-02', other)).output!, 'resume confirm');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    executor.adoptNativeSession.mockImplementation(async () => { await gate; return { success: true }; });
    const first = send(`/resume confirm ${a}`), second = send(`/resume confirm ${b}`, other);
    try { expect(executor.adoptNativeSession).toHaveBeenCalledTimes(2); }
    finally { release(); }
    expect((await Promise.all([first, second])).every(result => result.success)).toBe(true);
  });

  it('releases a failed reservation only after confirmed cleanup', async () => {
    executor.adoptNativeSession.mockResolvedValueOnce({ success: false, error: 'Synthetic verification failure' });
    expect((await send(`/resume confirm ${await confirmToken()}`)).success).toBe(false);
    expect((await send(`/resume confirm ${await confirmToken()}`)).success).toBe(true);
  });

  it.each(['uncertain', 'throw'])('quarantines the native file after an %s outcome', async outcome => {
    const pending = await confirmToken();
    if (outcome === 'throw') executor.adoptNativeSession.mockRejectedValueOnce(new Error('Synthetic unknown outcome'));
    else executor.adoptNativeSession.mockResolvedValueOnce({ success: false, error: 'Synthetic cleanup failure', recoveryRequired: true });
    if (outcome === 'throw') await expect(send(`/resume confirm ${pending}`)).rejects.toThrow('unknown outcome');
    else expect((await send(`/resume confirm ${pending}`)).success).toBe(false);
    expect((await send(`/resume id ${ID}`, { ...ctx, threadId: 'thread-b' })).error).toContain('requires process cleanup');
    expect(deps.setBusy).toHaveBeenLastCalledWith('thread-a', false);
    expect(executor.adoptNativeSession).toHaveBeenCalledTimes(1);
  });

  it.each(['claude', 'codex'] as const)('keeps %s discovery read-only without constructing any executor', async target => {
    backend = target;
    expect((await send('/resume')).success).toBe(true);
    expect((await send(`/resume id ${ID}`)).success).toBe(false);
    expect((await send('/session detach')).success).toBe(false);
    expect(deps.executor).not.toHaveBeenCalled();
    expect(executor.adoptNativeSession).not.toHaveBeenCalled();
    expect(executor.detachNativeSession).not.toHaveBeenCalled();
    expect(deps.setBusy).not.toHaveBeenCalled();
  });

  it('makes confirmations single use, scope bound, expiring and cancellable', async () => {
    const pending = await confirmToken();
    expect((await send(`/resume confirm ${pending}`, { ...ctx, openId: 'someone-else' })).error).toContain('expired, was already used');
    expect((await send(`/resume cancel ${pending}`)).output).toContain('Cancelled');
    expect((await send(`/resume confirm ${pending}`)).success).toBe(false);

    const late = await confirmToken();
    now += SESSION_MENU_TTL_MS;
    expect((await send(`/resume confirm ${late}`)).success).toBe(false);

    const first = await confirmToken(1);
    const second = await confirmToken(2);
    expect((await send(`/resume confirm ${first}`)).success).toBe(false); // superseded
    expect((await send(`/resume confirm ${second}`)).success).toBe(true);
    expect(executor.adoptNativeSession).toHaveBeenCalledTimes(1);
  });

  it('revalidates sharing, backend, busy state, ownership and revision at confirmation', async () => {
    const cases: Array<[() => void, string]> = [
      [() => { sharing = { enabled: false }; }, 'disabled'],
      [() => { backend = 'codex'; }, 'backend or workspace changed'],
      [() => { busy = true; }, 'running a task'],
      [() => { holder = 'thread-b'; }, 'thread "other"'],
      [() => { revision = 'rev-2'; }, 'changed after you selected it'],
      [() => { (deps.resolvePi as any).mockReturnValue(undefined); }, 'no longer listed'],
    ];
    for (const [mutate, message] of cases) {
      const pending = await confirmToken();
      mutate();
      expect((await send(`/resume confirm ${pending}`)).error).toContain(message);
      sharing = { enabled: true }; backend = 'pi'; busy = false; holder = undefined; revision = 'rev-1';
      (deps.resolvePi as any).mockImplementation((_cwd: string, id: string) => ({ id, file: `/native/${id}.jsonl`, revision }));
    }
    expect(executor.adoptNativeSession).not.toHaveBeenCalled();
  });

  it('states that a confirmed connection replaces the previous binding and keeps its history', async () => {
    binding = { id: 'session-02', adopted: true };
    const selected = await send(`/resume select ${token((await send('/resume')).output!, 'resume select')} 1`);
    expect(selected.output).toContain('This replaces this thread\'s current connection to session `session-02`');
    const confirmed = await send(`/resume confirm ${token(selected.output!, 'resume confirm')}`);
    expect(confirmed.output).toContain('The previous connection to `session-02` was replaced');
  });

  it('reports adoption failures and clears the busy flag', async () => {
    executor.adoptNativeSession.mockResolvedValue({ success: false, error: 'Pi opened a different session.' });
    expect((await send(`/resume confirm ${await confirmToken()}`)).error).toBe('Pi opened a different session.');
    expect(deps.setBusy).toHaveBeenLastCalledWith('thread-a', false);
    executor.adoptNativeSession = undefined;
    expect((await send(`/resume confirm ${await confirmToken()}`)).error).toContain('cannot connect');
  });

  it('refuses selections that cannot be connected, without confirmation', async () => {
    const list = await send('/resume');
    const menu = token(list.output!, 'resume select');
    expect((await send(`/resume select ${menu} 9`)).error).toContain('Row 9');
    holder = 'thread-b';
    expect((await send(`/resume select ${menu} 1`)).error).toContain('already used by thread "other"');
    holder = undefined;
    binding = { id: ID, adopted: true };
    expect((await send(`/resume select ${menu} 1`)).error).toContain('already connected');
    binding = undefined;
    backend = 'codex';
    expect((await send(`/resume select ${menu} 1`)).error).toContain('Switch this thread to Pi');
    expect((await send('/resume select AAAAAAAAAAAA 1')).error).toContain('expired or belongs');
  });

  it('shows Codex and Claude lists without a select entry and refuses selecting them', async () => {
    backend = 'codex';
    const list = await send('/resume');
    expect(list.output).not.toContain('Select:');
    expect(list.output).toContain('not available yet');
    expect((await send(`/resume select ${/menu `([^`]+)`/.exec(list.output!)![1]} 1`)).error).toContain('Codex native resume is not available');
    expect((await send('/resume backend pi')).output).not.toContain('Select:'); // Pi list on a Codex thread
  });

  it('resolves /resume id against a fresh catalog', async () => {
    const found = await send(`/resume id ${ID}`);
    expect(found.output).toContain('/resume confirm');
    expect((await send('/resume id missing-id')).error).toContain('No Pi session with that ID');
    sharing = undefined;
    expect((await send(`/resume id ${ID}`)).error).toContain('disabled');
    sharing = { enabled: true };
    backend = 'claude';
    expect((await send(`/resume id ${ID}`)).error).toContain('Claude Code native resume is not available');
    expect((await send('/resume id')).error).toContain('Expected /resume id');
  });

  it('keeps paging and search behavior and the read-only list errors', async () => {
    const list = await send('/resume');
    const menu = token(list.output!, 'resume select');
    expect((await send(`/resume page ${menu} 1`)).output).toContain('Page 1/1');
    expect((await send(`/resume page ${menu} 2`)).error).toContain('has 1 page.');
    expect((await send(`/resume search ${menu} login`)).output).toContain('Fix login');
    sharing = { enabled: true, backends: { pi: { enabled: false } } };
    expect((await send(`/resume page ${menu} 1`)).error).toContain('disabled for Pi');
    sharing = { enabled: true };
    (deps.readCatalog as any).mockReturnValue(undefined);
    expect((await send('/resume')).error).toContain('working directory');
    expect((await send('/resume backend nope')).error).toContain('Expected a backend key');
  });

  it('reports automatic reload status, rejects release and supports confirmed detach', async () => {
    expect((await send('/session')).error).toContain('No native session is bound');
    expect((await send('/session release')).error).toContain('Expected /session');
    binding = { id: ID, adopted: true };
    expect((await send('/session')).output).toContain('reloads before every remote turn');
    expect((await send('/session')).output).not.toContain('/session release');
    const prompt = await send('/session detach');
    expect(prompt.output).toContain('is not deleted');
    expect(executor.detachNativeSession).not.toHaveBeenCalled();
    const again = token(prompt.output!, 'session confirm');
    expect((await send('/resume confirm ' + again)).success).toBe(false);
    expect((await send('/session confirm ' + again)).output).toContain('Detached');
    expect(executor.detachNativeSession).toHaveBeenCalledTimes(1);
    expect((await send('/session confirm ' + again)).error).toContain('expired');
  });

  it('allows status and detach after sharing is disabled, and guards busy or failing operations', async () => {
    binding = { id: ID, adopted: true };
    sharing = undefined;
    expect((await send('/session')).success).toBe(true);
    const pending = token((await send('/session detach')).output!, 'session confirm');
    busy = true;
    expect((await send('/session confirm ' + pending)).error).toContain('running a task');
    busy = false;
    executor.detachNativeSession.mockResolvedValue({ success: false, error: 'still connected' });
    const retry = token((await send('/session detach')).output!, 'session confirm');
    expect((await send('/session confirm ' + retry)).error).toBe('still connected');
    executor.detachNativeSession = undefined;
    const unavailable = token((await send('/session detach')).output!, 'session confirm');
    expect((await send('/session confirm ' + unavailable)).error).toContain('cannot detach');
    const cancel = token((await send('/session detach')).output!, 'session cancel');
    expect((await send('/session cancel ' + cancel)).output).toContain('Cancelled');
    binding = undefined;
    sharing = { enabled: true };
    expect((await send('/session confirm AAAAAAAAAAAA')).error).toContain('not connected');
    expect((await send('/session bogus')).error).toContain('Expected /session');
    backend = 'codex';
    binding = { id: ID, adopted: true };
    expect((await send('/session')).success).toBe(false);
  });
});

describe('session command grammar', () => {
  it('parses select, id, confirm and cancel', () => {
    expect(parseSessionMenuCommand('/resume select abcdefghijkl 3')).toEqual({ kind: 'select', token: 'abcdefghijkl', row: 3 });
    expect(parseSessionMenuCommand('/r id 0190-abc_def.1:2')).toEqual({ kind: 'id', id: '0190-abc_def.1:2' });
    expect(parseSessionMenuCommand('/resume confirm abcdefghijkl')).toEqual({ kind: 'confirm', token: 'abcdefghijkl' });
    expect(parseSessionMenuCommand('/resume cancel abcdefghijkl')).toEqual({ kind: 'cancel', token: 'abcdefghijkl' });
    for (const bad of ['/resume select abcdefghijkl', '/resume select abcdefghijkl 0', '/resume id a b', '/resume id ../x y',
      '/resume id `x`', '/resume confirm abcdefghijkl extra', '/resume confirm short']) {
      expect(parseSessionMenuCommand(bad)).toMatchObject({ kind: 'invalid' });
    }
  });

  it('parses /session subcommands', () => {
    expect(parseSessionBindingCommand('/session')).toEqual({ kind: 'status' });
    expect(parseSessionBindingCommand('/session release')).toMatchObject({ kind: 'invalid' });
    expect(parseSessionBindingCommand('/session detach')).toEqual({ kind: 'detach' });
    expect(parseSessionBindingCommand('/session confirm abcdefghijkl')).toEqual({ kind: 'confirm', token: 'abcdefghijkl' });
    expect(parseSessionBindingCommand('/session cancel abcdefghijkl')).toEqual({ kind: 'cancel', token: 'abcdefghijkl' });
    expect(parseSessionBindingCommand('/session release now')).toMatchObject({ kind: 'invalid' });
    expect(parseSessionBindingCommand('/sessions')).toBeUndefined();
  });
});

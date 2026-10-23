import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerExecutor, type CodexAppServerTransport } from '../../src/executor/CodexAppServerExecutor';
import type { ExecutorGoal, ExecutorGoalStatus } from '../../src/executor/IExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { assertNativeGoalsVersion, nativeGoalError, parseNativeGoal, validateGoalRequest } from '../../src/executor/codex/CodexGoals';

class GoalTransport implements CodexAppServerTransport {
  running = false;
  version: string | null = '0.163.0';
  goal: ExecutorGoal | null = null;
  requests: Array<{ method: string; params: any }> = [];
  responses: Array<{ id: number | string; result: any }> = [];
  errors: Array<{ id: number | string; message: string }> = [];
  handler?: (message: any) => void;
  hook?: (method: string, params: any) => Promise<any> | undefined;
  stopError = false;
  stopDisconnects = false;
  interruptCompletes = true;
  async start() { this.running = true; }
  async stop() {
    if (this.stopError) throw new Error('Synthetic exit could not be confirmed');
    this.running = false;
    if (this.stopDisconnects) this.emit('client/disconnected', { error: 'Codex app-server stopped' });
  }
  async waitForExit() { if (this.running) throw new Error('Synthetic process still running'); }
  isRunning() { return this.running; }
  getServerVersion() { return this.version; }
  setWorkingDirectory() {}
  onMessage(handler: (message: any) => void) { this.handler = handler; return () => { this.handler = undefined; }; }
  emit(method: string, params: any) { this.handler?.({ method, params: { threadId: 'native-thread', ...params } }); }
  respond(id: number | string, result: any) { this.responses.push({ id, result }); }
  respondError(id: number | string, message: string) { this.errors.push({ id, message }); }
  makeGoal(status: ExecutorGoalStatus = 'active'): ExecutorGoal {
    return { threadId: 'native-thread', objective: 'Verify synthetic evidence', status, tokenBudget: null,
      tokensUsed: 12, timeUsedSeconds: 3, createdAt: 1, updatedAt: 2 };
  }
  update(status: ExecutorGoalStatus, turnId: string | null = null) {
    this.goal = { ...(this.goal ?? this.makeGoal()), status, updatedAt: (this.goal?.updatedAt ?? 2) + 1 };
    this.emit('thread/goal/updated', { turnId, goal: this.goal });
  }
  async request(method: string, params?: any): Promise<any> {
    this.requests.push({ method, params });
    const override = this.hook?.(method, params);
    if (override) return override;
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'native-thread' } };
    if (method === 'turn/start') return { turn: { id: 'ordinary-turn' } };
    if (method === 'thread/goal/get') return { goal: this.goal ? { ...this.goal } : null };
    if (method === 'thread/goal/set') {
      if (!this.goal && !params.objective) throw new Error('No existing native goal');
      const replaced = params.objective && params.objective !== this.goal?.objective;
      this.goal = { ...(this.goal ?? this.makeGoal()),
        ...(params.objective !== undefined ? { objective: params.objective } : {}),
        ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
        ...(replaced ? { tokensUsed: 0, timeUsedSeconds: 0 } : {}), status: params.status,
      };
      this.emit('thread/goal/updated', { turnId: null, goal: this.goal });
      return { goal: { ...this.goal } };
    }
    if (method === 'thread/goal/clear') {
      const cleared = this.goal !== null;
      this.goal = null;
      this.emit('thread/goal/cleared', {});
      return { cleared };
    }
    if (method === 'turn/interrupt' && this.interruptCompletes) {
      this.emit('turn/completed', { turn: { id: params.turnId, status: 'interrupted' } });
    }
    return {};
  }
}

describe('native Codex goal lifecycle', () => {
  let home: string;
  let previousHome: string | undefined;
  let project: string;
  let client: GoalTransport;
  let executor: CodexAppServerExecutor;
  const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const pointer = () => path.join(home, '.remote-cli', 'codex-sessions', 'remote-thread.json');
  const create = (worker = false, settings: { model?: string; effort?: string } = {}) => new CodexAppServerExecutor(new DirectoryGuard([project]), {
    threadId: 'remote-thread', initialWorkingDirectory: project, autoApprove: false,
    delegationWorker: worker, clientFactory: () => client, inactivityTimeoutMs: 60_000,
    ...settings,
  });
  const begin = async (options: any = {}) => {
    const done = executor.executeGoal({ objective: 'Verify synthetic evidence' }, options);
    await tick();
    expect(client.requests.some(request => request.method === 'thread/goal/set')).toBe(true);
    return { done };
  };
  const started = (id: string) => client.emit('turn/started', { turn: { id, status: 'inProgress' } });
  const completed = (id: string) => client.emit('turn/completed', { turn: { id, status: 'completed' } });

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-native-goals-')));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    project = path.join(home, 'project');
    await fs.mkdir(project);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(os, 'tmpdir').mockReturnValue(home);
    client = new GoalTransport();
    executor = create();
  });

  afterEach(async () => {
    client.stopError = false;
    await executor.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it('does not create a session when reading or resuming without a saved ID', async () => {
    expect(await executor.getGoal()).toBeNull();
    expect(await executor.executeGoal({}, {})).toMatchObject({ success: false, error: expect.stringContaining('no saved') });
    expect(client.requests).toEqual([]);
  });

  it('reads saved native state without thread/start or thread/resume', async () => {
    await executor.destroy();
    await fs.writeFile(pointer(), JSON.stringify({ id: 'native-thread', savedAt: 'synthetic' }));
    client = new GoalTransport(); client.goal = client.makeGoal('paused'); executor = create();
    expect(await executor.getGoal()).toEqual(client.goal);
    expect(client.requests).toEqual([{ method: 'thread/goal/get', params: { threadId: 'native-thread' } }]);
    expect(executor.isBusy()).toBe(false);
  });

  it.each([undefined, 250])('sets native user provenance and only an explicit budget (%s)', async tokenBudget => {
    const pending = executor.executeGoal({ objective: 'Verify synthetic evidence', ...(tokenBudget ? { tokenBudget } : {}) }, {});
    expect(executor.isGoalRunning()).toBe(true);
    expect(executor.isBusy()).toBe(true);
    await tick();
    expect(client.requests.find(request => request.method === 'thread/goal/set')?.params).toEqual({
      threadId: 'native-thread', objective: 'Verify synthetic evidence', origin: 'user', status: 'active',
      ...(tokenBudget ? { tokenBudget } : {}),
    });
    expect(client.requests.some(request => request.method === 'turn/start')).toBe(false);
    expect(JSON.parse(await fs.readFile(pointer(), 'utf8')).goalManaged).toBe(true);
    client.update('complete');
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it.each([{ objective: '' }, { objective: 'x'.repeat(4001) }, { tokenBudget: 0 }, { tokenBudget: -2 },
    { tokenBudget: 1.5 }, { tokenBudget: Number.MAX_SAFE_INTEGER + 1 }, { tokenBudget: NaN }])('rejects invalid inputs without native mutation: %j', async request => {
    expect(await executor.executeGoal(request, {})).toMatchObject({ success: false });
    expect(client.requests).toHaveLength(0);
    expect(executor.isGoalRunning()).toBe(false);
  });

  it('counts Unicode characters rather than UTF-16 code units', async () => {
    const pending = executor.executeGoal({ objective: '🧪'.repeat(4000) }, {});
    await tick();
    expect(client.requests.find(request => request.method === 'thread/goal/set')?.params.objective).toHaveLength(8000);
    client.update('complete');
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it('applies selected model and effort to native continuations before activation', async () => {
    await executor.destroy();
    client = new GoalTransport(); executor = create(false, { model: 'fixture-model', effort: 'high' });
    const { done } = await begin();
    expect(client.requests.find(request => request.method === 'thread/start')?.params).toMatchObject({
      model: 'fixture-model', config: { model_reasoning_effort: 'high' },
    });
    const settings = client.requests.findIndex(request => request.method === 'thread/settings/update');
    expect(client.requests[settings].params).toEqual({ threadId: 'native-thread', model: 'fixture-model', effort: 'high' });
    expect(settings).toBeLessThan(client.requests.findIndex(request => request.method === 'thread/goal/set'));
    client.update('complete'); await expect(done).resolves.toMatchObject({ success: true });
  });

  it.each(['read-only', 'on'])('syncs network-off sandbox policy before activating a goal (%s)', async mode => {
    expect((await executor.configureSandbox(mode)).success).toBe(true);
    expect((await executor.configureSandbox('network off')).success).toBe(true);
    const { done } = await begin();
    const settings = client.requests.findIndex(request => request.method === 'thread/settings/update');
    expect(client.requests[settings].params).toMatchObject({
      threadId: 'native-thread', approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandboxPolicy: { type: mode === 'read-only' ? 'readOnly' : 'workspaceWrite', networkAccess: false },
    });
    expect(settings).toBeLessThan(client.requests.findIndex(request => request.method === 'thread/goal/set'));
    client.update('complete'); await done;
  });

  it('pauses a saved active goal before loading and applies policy before reactivation', async () => {
    await executor.destroy(); await fs.writeFile(pointer(), JSON.stringify({ id: 'native-thread', goalManaged: true }));
    client = new GoalTransport(); client.goal = client.makeGoal(); executor = create();
    await executor.configureSandbox('read-only'); await executor.configureSandbox('network off');
    client.hook = method => {
      if (method === 'thread/resume') expect(client.goal?.status).toBe('paused');
      return undefined;
    };
    const pending = executor.executeGoal({}, {}); await tick();
    const methods = client.requests.map(request => request.method);
    const pause = client.requests.findIndex(request => request.method === 'thread/goal/set' && request.params.status === 'paused');
    const activate = client.requests.findIndex(request => request.method === 'thread/goal/set' && request.params.status === 'active');
    expect(pause).toBeLessThan(methods.indexOf('thread/resume'));
    expect(methods.indexOf('thread/settings/update')).toBeLessThan(activate);
    expect(client.goal?.tokensUsed).toBe(12);
    client.update('complete'); await pending;
  });

  it('keeps callbacks, tools and approvals through multiple automatic native turns', async () => {
    const text = vi.fn(); const tools = vi.fn(); const approvals = vi.fn(() => true); const resolved = vi.fn();
    const { done } = await begin({ onDisplayText: text, onToolUse: tools, onApprovalRequest: approvals, onApprovalResolved: resolved });
    let finished = false; void done.then(() => { finished = true; });
    for (const id of ['one', 'two']) {
      started(id);
      client.emit('item/agentMessage/delta', { turnId: id, delta: id });
      client.emit('item/started', { turnId: id, item: { type: 'commandExecution', id: 'reused-tool-id', command: 'echo fixture' } });
      client.handler?.({ id: `approval-${id}`, method: 'item/commandExecution/requestApproval', params: {
        threadId: 'native-thread', turnId: id, itemId: 'reused-tool-id', command: 'echo fixture',
      } });
      expect(executor.sendInput('yes')).toBe(true);
      completed(id);
      await tick();
      expect(finished).toBe(false);
      expect(executor.isBusy()).toBe(true);
    }
    expect(text.mock.calls).toEqual([['one'], ['\n\n'], ['two']]);
    expect(tools).toHaveBeenCalledTimes(2);
    expect(approvals).toHaveBeenCalledTimes(2);
    expect(resolved).toHaveBeenCalledTimes(2);
    client.update('complete', 'one'); // A goal notification is not restricted to the current turn.
    await expect(done).resolves.toMatchObject({ success: true, output: 'one\n\ntwo\n\nNative goal complete.\n' });
    expect(client.requests.filter(request => request.method === 'turn/start')).toHaveLength(0);
  });

  it.each(['complete', 'blocked', 'usageLimited', 'budgetLimited', 'paused', 'cleared'])('waits for the last native turn after goal becomes %s', async status => {
    const stream = vi.fn();
    const { done } = await begin({ onStream: stream, onActivity: vi.fn() }); started('one');
    let finished = false; void done.then(() => { finished = true; });
    if (status === 'cleared') { client.goal = null; client.emit('thread/goal/cleared', {}); }
    else client.update(status as ExecutorGoalStatus);
    await tick();
    expect(finished).toBe(false);
    completed('one');
    await expect(done).resolves.toMatchObject({ success: ['complete', 'paused', 'cleared'].includes(status) });
    expect(stream).toHaveBeenCalledWith(`\n\nNative goal ${status}.\n`);
    expect(executor.isGoalRunning()).toBe(false);
  });

  it('reconciles a terminal goal whose update notification was missed', async () => {
    const { done } = await begin(); started('one');
    client.goal = { ...client.goal!, status: 'complete' };
    completed('one');
    await expect(done).resolves.toMatchObject({ success: true });
  });

  it('ignores stale turn starts, wrong threads, and events after cleanup', async () => {
    const text = vi.fn(); const { done } = await begin({ onDisplayText: text });
    started('one'); completed('one'); await tick();
    started('two'); started('one');
    client.emit('item/agentMessage/delta', { threadId: 'wrong-thread', turnId: 'two', delta: 'wrong' });
    client.emit('item/agentMessage/delta', { turnId: 'one', delta: 'late' });
    client.emit('thread/goal/updated', { threadId: 'wrong-thread', goal: { ...client.goal!, status: 'complete' } });
    client.emit('item/agentMessage/delta', { turnId: 'two', delta: 'current' });
    client.update('complete'); completed('two'); await done;
    started('late-three'); client.emit('item/agentMessage/delta', { turnId: 'late-three', delta: 'after' });
    expect(text.mock.calls).toEqual([['current'], ['\n\nNative goal complete.\n']]);
    expect(executor.isBusy()).toBe(false);
  });

  it('owns callbacks before native resume can dispatch automatically and preserves resume accounting', async () => {
    await executor.destroy(); await fs.writeFile(pointer(), JSON.stringify({ id: 'native-thread', goalManaged: true }));
    client = new GoalTransport(); client.goal = client.makeGoal(); executor = create(false, { effort: 'high' });
    client.hook = (method, params) => {
      if (method !== 'thread/resume') return;
      expect(executor.isGoalRunning()).toBe(true); expect(executor.isBusy()).toBe(true);
      expect(params.config).toMatchObject({ model_reasoning_effort: 'high' });
      started('early'); client.emit('item/agentMessage/delta', { turnId: 'early', delta: 'during resume' });
      return Promise.resolve({ thread: { id: 'native-thread' } });
    };
    const text = vi.fn(); const pending = executor.executeGoal({}, { onDisplayText: text }); await tick();
    expect(text).toHaveBeenCalledWith('during resume');
    expect(client.requests.find(request => request.method === 'thread/goal/set' && request.params.status === 'active')?.params).toEqual({ threadId: 'native-thread', status: 'active', origin: 'user' });
    expect(client.goal?.tokensUsed).toBe(12);
    client.update('complete'); completed('early'); await pending;
  });

  it.each([null, 'complete'])('does not resume a missing or completed saved goal (%s)', async status => {
    await executor.destroy(); await fs.writeFile(pointer(), JSON.stringify({ id: 'native-thread' }));
    client = new GoalTransport(); client.goal = status ? client.makeGoal(status as ExecutorGoalStatus) : null; executor = create();
    expect(await executor.executeGoal({}, {})).toMatchObject({ success: false, error: expect.stringContaining('unfinished') });
    expect(client.requests.some(request => request.method === 'thread/resume' || request.method === 'thread/goal/set')).toBe(false);
  });

  it('allows an explicit new objective after a completed goal', async () => {
    await executor.destroy(); await fs.writeFile(pointer(), JSON.stringify({ id: 'native-thread', goalManaged: true }));
    client = new GoalTransport(); client.goal = client.makeGoal('complete'); executor = create();
    const pending = executor.executeGoal({ objective: 'A new explicit objective', tokenBudget: 500 }, {}); await tick();
    expect(client.requests.find(request => request.method === 'thread/goal/set')?.params).toEqual({
      threadId: 'native-thread', objective: 'A new explicit objective', tokenBudget: 500, status: 'active', origin: 'user',
    });
    expect(client.goal?.tokensUsed).toBe(0);
    client.update('complete'); await pending;
  });

  it('owns the first native turn even when it starts and completes inside the activation RPC', async () => {
    const text = vi.fn();
    client.hook = (method, params) => {
      if (method !== 'thread/goal/set' || params.status !== 'active') return;
      expect(executor.isBusy()).toBe(true);
      expect(executor.isGoalRunning()).toBe(true);
      started('early'); client.emit('item/agentMessage/delta', { turnId: 'early', delta: 'activation output' });
      client.goal = { ...client.makeGoal('complete'), objective: params.objective };
      client.update('complete', 'early'); completed('early');
      return Promise.resolve({ goal: { ...client.goal, status: 'active' } });
    };
    const pending = executor.executeGoal({ objective: 'Verify synthetic evidence' }, { onDisplayText: text });
    await expect(pending).resolves.toMatchObject({ success: true, output: 'activation output\n\nNative goal complete.\n' });
    expect(text).toHaveBeenCalledWith('activation output');
  });

  it('does not load an old active goal to replace its objective', async () => {
    await executor.destroy(); await fs.writeFile(pointer(), JSON.stringify({ id: 'native-thread', goalManaged: true }));
    client = new GoalTransport(); client.goal = client.makeGoal(); executor = create();
    expect(await executor.executeGoal({ objective: 'Different objective' }, {})).toMatchObject({
      success: false, error: expect.stringContaining('Pause or clear'),
    });
    expect(client.requests.some(request => request.method === 'thread/resume' || request.method === 'thread/goal/set')).toBe(false);
  });

  it('serializes different stop controls without treating pause as clear', async () => {
    const { done } = await begin();
    const paused = executor.pauseGoal(); const cleared = executor.clearGoal();
    expect((await paused).success).toBe(true); expect((await cleared).success).toBe(true); await done;
    expect(client.goal).toBeNull();
    expect(client.requests.filter(request => request.method === 'thread/goal/clear')).toHaveLength(1);
  });

  it.each(['pause', 'clear', 'abort'])('does not treat the intentional shutdown notification as a failed %s', async action => {
    const { done } = await begin();
    client.stopDisconnects = true;
    const result = action === 'abort' ? { success: await executor.abort() }
      : action === 'clear' ? await executor.clearGoal() : await executor.pauseGoal();
    expect(result.success).toBe(true);
    await expect(done).resolves.toMatchObject({ success: true });
    expect(executor.isBusy()).toBe(false);
  });

  it('cancels startup before activation when pause arrives while the thread is loading', async () => {
    let release!: (value: any) => void;
    client.hook = method => method === 'thread/start' ? new Promise(resolve => { release = resolve; }) : undefined;
    const pending = executor.executeGoal({ objective: 'Verify synthetic evidence' }, {}); await tick();
    const paused = executor.pauseGoal();
    release({ thread: { id: 'native-thread' } });
    expect((await paused).success).toBe(true); await pending;
    expect(client.requests.some(request => request.method === 'thread/goal/set')).toBe(false);
  });

  it('does not let a concurrent ordinary startup replace goal ownership', async () => {
    let release!: (value: any) => void;
    client.hook = method => method === 'thread/start' && !release ? new Promise(resolve => { release = resolve; }) : undefined;
    const ordinary = executor.execute('ordinary', {}); await tick();
    const goal = executor.executeGoal({ objective: 'Verify synthetic evidence' }, {});
    await expect(goal).resolves.toMatchObject({ success: false });
    release({ thread: { id: 'native-thread' } });
    await tick();
    client.emit('turn/completed', { turn: { id: 'ordinary-turn', status: 'completed' } });
    await expect(ordinary).resolves.toMatchObject({ success: true });
    expect(executor.isGoalRunning()).toBe(false);
    expect(client.requests.some(request => request.method === 'thread/goal/set')).toBe(false);
  });

  it.each(['pause', 'clear', 'abort'])('stops between turns using explicit user provenance (%s)', async action => {
    const { done } = await begin(); started('one'); completed('one'); await tick();
    const result = action === 'pause' ? await executor.pauseGoal() : action === 'clear' ? await executor.clearGoal() : await executor.abort();
    expect(result).toEqual(action === 'abort' ? true : expect.objectContaining({ success: true }));
    await expect(done).resolves.toMatchObject({ success: true });
    const mutations = client.requests.filter(request => request.method === 'thread/goal/set' || request.method === 'thread/goal/clear');
    expect(mutations.every(request => request.params.origin === 'user')).toBe(true);
    expect(mutations[1]).toMatchObject({ method: 'thread/goal/set', params: { status: 'paused' } });
    expect(client.requests.some(request => request.method === 'turn/interrupt')).toBe(false);
  });

  it.each(['pause', 'clear', 'abort'])('does not acknowledge stopping before the native turn completes (%s)', async action => {
    const { done } = await begin(); started('one'); client.interruptCompletes = false;
    let stopped = false;
    const control = (action === 'pause' ? executor.pauseGoal() : action === 'clear' ? executor.clearGoal() : executor.abort()).then(result => { stopped = true; return result; });
    await tick(); expect(stopped).toBe(false); expect(executor.isBusy()).toBe(true);
    expect(client.requests.find(request => request.method === 'turn/interrupt')?.params).toEqual({ threadId: 'native-thread', turnId: 'one' });
    client.emit('turn/completed', { turn: { id: 'one', status: 'interrupted' } });
    expect(await control).toEqual(action === 'abort' ? true : expect.objectContaining({ success: true }));
    await done;
  });

  it('prevents auto-approval of unowned requests between native turns', async () => {
    const { done } = await begin();
    client.handler?.({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread', turnId: 'unowned' } });
    expect(client.errors).toContainEqual({ id: 7, message: expect.stringContaining('running native goal turn') });
    expect(client.responses).toHaveLength(0);
    await executor.pauseGoal(); await done;
  });

  it('rejects other runs and conversation reset while a goal owns the executor', async () => {
    const { done } = await begin();
    expect(await executor.executeGoal({ objective: 'Competing goal' }, {})).toMatchObject({ success: false });
    expect(await executor.execute('ordinary', {})).toMatchObject({ success: false });
    expect(() => executor.resetContext()).toThrow('Stop the native goal');
    await executor.clearGoal(); await done;
  });

  it('ignores unknown notifications but fails closed for a malformed goal notification', async () => {
    const { done } = await begin();
    client.emit('future/notification', {});
    expect(executor.isGoalRunning()).toBe(true);
    client.emit('thread/goal/updated', { goal: null });
    await expect(done).resolves.toMatchObject({ success: false, error: expect.stringContaining('empty native goal') });
    expect(client.running).toBe(false);
  });

  it('keeps readonly goal controls available during native work', async () => {
    const { done } = await begin(); started('one');
    expect(await executor.getGoal()).toEqual(client.goal);
    expect(executor.isBusy()).toBe(true);
    expect((await executor.pauseGoal()).success).toBe(true); await done;
  });

  it('confirms process exit before settling a disconnected goal', async () => {
    const { done } = await begin();
    let release!: () => void;
    vi.spyOn(client, 'stop').mockImplementationOnce(() => new Promise<void>(resolve => { release = () => { client.running = false; resolve(); }; }));
    client.emit('client/disconnected', { error: 'Synthetic disconnect' }); await tick();
    expect(executor.isBusy()).toBe(true);
    release(); await expect(done).resolves.toMatchObject({ success: false, error: expect.stringContaining('/goal resume') });
    expect(client.running).toBe(false);
  });

  it('bounds an unresponsive native mutation and prevents its late result from reviving execution', async () => {
    vi.useFakeTimers();
    let release!: (value: any) => void;
    client.hook = method => method === 'thread/goal/set' ? new Promise(resolve => { release = resolve; }) : undefined;
    const pending = executor.executeGoal({ objective: 'Verify synthetic evidence' }, {}); await tick();
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(pending).resolves.toMatchObject({ success: false, error: expect.stringContaining('timed out') });
    release({ goal: client.makeGoal() }); await tick();
    expect(executor.isBusy()).toBe(false); expect(client.running).toBe(false);
  });

  it('bounds a stop whose interrupt never produces a completion', async () => {
    vi.useFakeTimers();
    const { done } = await begin(); started('one'); client.interruptCompletes = false;
    const stopping = executor.pauseGoal(); await tick();
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await stopping).success).toBe(false);
    await expect(done).resolves.toMatchObject({ success: false });
    expect(client.running).toBe(false);
  });

  it('retries goal destruction after an unconfirmed native exit', async () => {
    const { done } = await begin(); client.stopError = true;
    await expect(executor.destroy()).rejects.toThrow('exit could not be confirmed');
    expect(executor.isGoalRunning()).toBe(true);
    client.stopError = false; await executor.destroy();
    await expect(done).resolves.toMatchObject({ success: false });
    expect(executor.isGoalRunning()).toBe(false);
  });

  it.each(['old', 'missing-rpc', 'disabled'])('fails honestly for unsupported native goals (%s)', async mode => {
    if (mode === 'old') client.version = '0.162.0';
    else client.hook = method => method === 'thread/goal/set' ? Promise.reject(mode === 'missing-rpc'
      ? { code: -32601, message: 'Method not found' } : new Error('Goals feature disabled')) : undefined;
    const result = await executor.executeGoal({ objective: 'Verify synthetic evidence' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Upgrade Codex|goals are unavailable/);
    expect(client.requests.some(request => request.method === 'turn/start')).toBe(false);
    expect(client.running).toBe(false);
  });

  it('stops the process before settling a failed native mutation, and retains recovery metadata', async () => {
    const { done } = await begin();
    client.hook = (method, params) => method === 'thread/goal/set' && params.status === 'paused' ? Promise.reject(new Error('Synthetic RPC failure')) : undefined;
    const control = await executor.pauseGoal();
    expect(control).toMatchObject({ success: false, error: 'Synthetic RPC failure' });
    await expect(done).resolves.toMatchObject({ success: false });
    expect(client.running).toBe(false);
    expect(JSON.parse(await fs.readFile(pointer(), 'utf8')).goalManaged).toBe(true);
    const requestCount = client.requests.length;
    expect(await executor.execute('ordinary request', {})).toMatchObject({ success: false, error: expect.stringContaining('/goal resume') });
    expect(client.requests.slice(requestCount).every(request => request.method === 'thread/goal/get')).toBe(true);
  });

  it('does not release ownership when native process exit is unconfirmed', async () => {
    const { done } = await begin();
    client.stopError = true;
    client.hook = (method, params) => method === 'thread/goal/set' && params.status === 'paused' ? Promise.reject(new Error('Synthetic RPC failure')) : undefined;
    expect(await executor.pauseGoal()).toMatchObject({ success: false });
    expect(executor.isGoalRunning()).toBe(true);
    expect(executor.isBusy()).toBe(true);
    client.stopError = false; client.hook = undefined;
    await executor.pauseGoal(); await done;
  });

  it('uses inactivity timeout for an active idle/no-tool goal without manufacturing continuation prompts', async () => {
    vi.useFakeTimers();
    const notices = vi.fn();
    const { done } = await begin({ inactivityTimeout: 100, onActivity: notices });
    started('one'); completed('one'); await tick();
    client.emit('thread/status/changed', { status: { type: 'idle' } });
    expect(executor.isBusy()).toBe(true);
    await vi.advanceTimersByTimeAsync(101);
    await expect(done).resolves.toMatchObject({ success: false, error: expect.stringContaining('inactivity timeout') });
    expect(client.running).toBe(false);
    expect(notices.mock.calls.some(([notice]) => notice.text.includes('waiting for native continuation'))).toBe(true);
    expect(client.requests.some(request => request.method === 'turn/start')).toBe(false);
  });

  it('retains native state across destroy and requires explicit recovery before ordinary execution', async () => {
    const { done } = await begin(); await executor.destroy();
    await expect(done).resolves.toMatchObject({ success: false });
    const nativeGoal = client.goal;
    client = new GoalTransport(); client.goal = nativeGoal; executor = create();
    expect(await executor.execute('ordinary', {})).toMatchObject({ success: false, error: expect.stringContaining('/goal resume') });
    expect(client.requests.some(request => request.method === 'thread/resume')).toBe(false);
    expect(await executor.pauseGoal()).toMatchObject({ success: true });
    const ordinary = executor.execute('ordinary', {}); await tick();
    client.emit('turn/completed', { turn: { id: 'ordinary-turn', status: 'completed' } });
    await expect(ordinary).resolves.toMatchObject({ success: true });
    executor.resetContext(); expect(await executor.getGoal()).toBeNull();
    expect(await fs.stat(pointer()).catch(() => null)).toBeNull();
  });

  it('leaves legacy ordinary execution free of goal RPCs and markers', async () => {
    const ordinary = executor.execute('ordinary', {}); await tick();
    client.emit('turn/completed', { turn: { id: 'ordinary-turn', status: 'completed' } }); await ordinary;
    expect(client.requests.map(request => request.method)).toEqual(['thread/start', 'turn/start']);
    expect(JSON.parse(await fs.readFile(pointer(), 'utf8'))).not.toHaveProperty('goalManaged');
  });

  it.each(['worker', 'delegation'])('rejects managed delegation before native loading (%s)', async kind => {
    if (kind === 'worker') { await executor.destroy(); executor = create(true); }
    else await executor.configureDelegation({ endpoint: 'http://127.0.0.1:1', token: 'synthetic-token' } as any);
    expect(await executor.executeGoal({ objective: 'Verify synthetic evidence' }, {})).toMatchObject({ success: false, error: expect.stringContaining('delegation') });
    expect(client.requests).toHaveLength(0);
  });
});

describe('native goal wire validation', () => {
  it('accepts only finite native accounting and matching thread identities', () => {
    const goal = new GoalTransport().makeGoal();
    expect(parseNativeGoal(goal, goal.threadId)).toEqual(goal);
    for (const patch of [{ threadId: 'other' }, { objective: '' }, { status: 'madeUp' }, { tokensUsed: Infinity },
      { timeUsedSeconds: -1 }, { tokenBudget: -1 }, { updatedAt: NaN }]) {
      expect(() => parseNativeGoal({ ...goal, ...patch }, goal.threadId)).toThrow('invalid native goal');
    }
    expect(() => parseNativeGoal(undefined, goal.threadId)).toThrow();
    expect(parseNativeGoal(null, goal.threadId)).toBeNull();
  });
  it('does not treat missing version metadata as a simulated capability', () => {
    expect(() => assertNativeGoalsVersion(null)).not.toThrow();
    expect(() => assertNativeGoalsVersion('0.163.0+build')).not.toThrow();
    expect(() => assertNativeGoalsVersion('0.164.0')).not.toThrow();
    expect(() => assertNativeGoalsVersion('0.163.0-preview')).toThrow();
    expect(() => assertNativeGoalsVersion('invalid')).toThrow();
    expect(nativeGoalError(new Error('Synthetic error'))).toBe('Synthetic error');
    expect(() => validateGoalRequest({ objective: 7 as any })).toThrow('Unicode');
  });
});

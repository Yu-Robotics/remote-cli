import { describe, expect, it, vi } from 'vitest';
import { ScheduleToolOperations } from '../src/scheduling/ScheduleToolScope';
const owner = { openId: 'user', threadId: 'thread', generation: 'generation' };
const args = { requestId: 'request', when: { kind: 'after', amount: 5, unit: 'm' }, prompt: 'Synthetic task' };
function fixture() {
  const operations = new ScheduleToolOperations();
  const options = { owner, messageId: 'foreground', backend: 'claude' as const, current: vi.fn(() => true), waitMs: 1,
    run: vi.fn(async () => []), present: vi.fn(async () => 'card delivered') };
  return { operations, options, scope: operations.scope(options) };
}
describe('ScheduleToolScope', () => {
  it('does not initialize scheduling for capabilities and returns current native capability separately', async () => {
    const f = fixture();
    expect(await f.scope.invoke('remote_cli_schedule_capabilities', {})).toMatchObject({ backend: 'claude', capability: { supported: true }, now: expect.any(String) });
    expect(f.options.run).not.toHaveBeenCalled();
    await expect(f.scope.invoke('remote_cli_schedule_capabilities', { backend: 'claude' })).rejects.toThrow('cannot be supplied');
    const other = f.operations.scope({ ...f.options, backend: 'codex' });
    expect(await other.invoke('remote_cli_schedule_capabilities', {})).toMatchObject({ backend: 'codex', capability: { supported: false } });
  });
  it('returns pending quickly and joins lost replies across a new scope without duplicating native creation', async () => {
    const f = fixture(); let finish!: () => void;
    f.options.run.mockImplementation(() => new Promise(resolve => { finish = () => resolve([]); }));
    const first: any = await f.scope.invoke('remote_cli_schedule_create', args);
    expect(first.status).toBe('pending'); expect(first.scheduleId).toMatch(/^managed-/);
    const repeated = f.operations.scope(f.options);
    expect(await repeated.invoke('remote_cli_schedule_create', { ...args, when: { unit: 'm', amount: 5, kind: 'after' } })).toEqual(first);
    expect(f.options.run).toHaveBeenCalledOnce();
    await expect(repeated.invoke('remote_cli_schedule_create', { ...args, prompt: 'Different task' })).rejects.toThrow('different');
    finish(); await f.scope.drain();
    const inspection = f.operations.scope(f.options);
    expect(await inspection.invoke('remote_cli_schedule_operation', { requestId: 'request' })).toMatchObject({ status: 'succeeded', card: 'card delivered' });
    expect(inspection.hasSideEffects).toBe(true);
    expect(f.options.present).toHaveBeenCalledOnce();
    await f.scope.close(); await expect(f.scope.invoke('remote_cli_schedule_list', { requestId: 'later' })).rejects.toThrow('no longer active');
  });
  it.each([
    { backend: 'dsh' }, { owner: 'foreign' }, { cwd: '.' }, { generation: 'other' }, { requestId: '' },
    { when: { kind: 'after', amount: 0, unit: 'm' } }, { when: { kind: 'after', amount: 1, unit: 'x' } },
    { when: { kind: 'at', at: 'tomorrow morning' } }, { when: { kind: 'at', at: '2030-99-99T00:00:00Z' } },
    { when: { kind: 'cron', expression: 'bad', timezone: 'UTC' } },
    { when: { kind: 'cron', expression: '* * * * *', timezone: 'not a zone' } },
    { when: { kind: 'cron', expression: '"', timezone: 'UTC' } }, { when: { kind: 'unknown' } },
    { when: [] }, { prompt: '' }, { prompt: 42 },
  ])('rejects malformed or caller-authority input %j', async change => {
    const f = fixture(); await expect(f.scope.invoke('remote_cli_schedule_create', { ...args, ...change })).rejects.toThrow();
    expect(f.options.run).not.toHaveBeenCalled();
  });
  it('uses the same normalized parser for explicit dates, cron, list and cancel', async () => {
    const f = fixture();
    for (const when of [{ kind: 'at', at: new Date(Date.now() + 3600_000).toISOString() }, { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' }]) {
      expect(await f.scope.invoke('remote_cli_schedule_create', { ...args, when, requestId: when.kind })).toMatchObject({ status: 'succeeded' });
    }
    expect(await f.scope.invoke('remote_cli_schedule_list', { requestId: 'list' })).toMatchObject({ status: 'succeeded' });
    expect(await f.scope.invoke('remote_cli_schedule_cancel', { requestId: 'cancel', scheduleId: 'schedule' })).toMatchObject({ status: 'succeeded' });
    await expect(f.scope.invoke('remote_cli_schedule_cancel', { requestId: 'bad', scheduleId: '../x' })).rejects.toThrow();
    await expect(f.scope.invoke('unknown', { requestId: 'unknown' })).rejects.toThrow('Unknown');
    await expect(f.scope.invoke('remote_cli_schedule_operation', { requestId: 'unknown' })).rejects.toThrow('Unknown');
  });
  it('keeps native success distinct from card failure and reports cleanup failure without success', async () => {
    const f = fixture(); f.options.present.mockRejectedValue(new Error('offline'));
    expect(await f.scope.invoke('remote_cli_schedule_create', args)).toMatchObject({ status: 'succeeded', card: expect.stringContaining('do not recreate') });
    f.options.run.mockRejectedValue(new Error('Native exit unconfirmed'));
    expect(await f.scope.invoke('remote_cli_schedule_cancel', { requestId: 'cancel', scheduleId: 'schedule' })).toMatchObject({ status: 'failed', error: 'Native exit unconfirmed' });
  });
  it('rechecks context before dispatch and before returning any receipt, and drains accepted work', async () => {
    const f = fixture();
    const task = f.scope.invoke('remote_cli_schedule_create', args); f.options.current.mockReturnValue(false);
    await expect(task).rejects.toThrow('context changed'); expect(f.options.run).not.toHaveBeenCalled();
    await f.scope.close();
  });
  it('exposes a late failure until the model observes its terminal receipt, without exposing retired context', async () => {
    const f = fixture(); let fail!: (error: Error) => void;
    f.options.run.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    expect(await f.scope.invoke('remote_cli_schedule_create', args)).toMatchObject({ status: 'pending' });
    fail(new Error('Synthetic late native failure')); await f.scope.drain();
    expect(f.scope.unreportedFailures()).toMatchObject([{ status: 'failed', error: 'Synthetic late native failure' }]);
    f.options.current.mockReturnValue(false);
    expect(f.scope.unreportedFailures()).toEqual([]);
    f.options.current.mockReturnValue(true);
    await f.scope.invoke('remote_cli_schedule_operation', { requestId: args.requestId });
    expect(f.scope.unreportedFailures()).toEqual([]);
  });
  it('bounds simultaneous operations and keeps stable IDs across handler receipt loss', async () => {
    const f = fixture(); const finishes: (() => void)[] = [];
    f.options.run.mockImplementation(() => new Promise(resolve => { finishes.push(() => resolve([])); }));
    const pending = [];
    for (let i = 0; i < 5; i++) pending.push(await f.scope.invoke('remote_cli_schedule_create', { ...args, requestId: `op-${i}` }));
    await expect(f.scope.invoke('remote_cli_schedule_create', { ...args, requestId: 'overflow' })).rejects.toThrow('limit');
    finishes.forEach(finish => finish()); await f.scope.close();
    const recovered = new ScheduleToolOperations().scope({ ...f.options, run: vi.fn(async () => []) });
    expect((await recovered.invoke('remote_cli_schedule_create', { ...args, requestId: 'op-0' }) as any).scheduleId).toBe((pending[0] as any).scheduleId);
  });

  it('redacts records, bounds retained receipts and does not mix users, generations or foreground requests', async () => {
    const f = fixture();
    f.options.run.mockResolvedValue([{ ...owner, id: 'task', state: 'active', backend: 'claude', cwd: 'private',
      prompt: 'x'.repeat(500), rule: { kind: 'once', at: '2030-01-01T00:00:00Z' }, error: 'y'.repeat(500), createdAt: 0 }] as any);
    const receipt: any = await f.scope.invoke('remote_cli_schedule_create', args);
    expect(receipt.records[0].prompt).toHaveLength(240); expect(receipt.records[0].error).toHaveLength(240);
    for (const field of ['openId', 'threadId', 'generation', 'cwd', 'createdAt']) expect(receipt.records[0]).not.toHaveProperty(field);
    for (const options of [{ ...f.options, owner: { ...owner, openId: 'other' } },
      { ...f.options, owner: { ...owner, generation: 'other' } }, { ...f.options, messageId: 'other' }]) {
      await expect(f.operations.scope(options).invoke('remote_cli_schedule_operation', { requestId: args.requestId })).rejects.toThrow('Unknown');
    }
    receipt.records[0].prompt = 'mutated';
    expect((await f.scope.invoke('remote_cli_schedule_operation', { requestId: args.requestId }) as any).records[0].prompt).toHaveLength(240);
    for (let i = 1; i < 200; i++) await f.scope.invoke('remote_cli_schedule_list', { requestId: `list-${i}` });
    await expect(f.scope.invoke('remote_cli_schedule_list', { requestId: 'full' })).rejects.toThrow('limit');
    const next = f.operations.scope({ ...f.options, messageId: 'next-foreground' });
    expect(await next.invoke('remote_cli_schedule_list', { requestId: 'next-list' })).toMatchObject({ status: 'succeeded' });
    await expect(f.scope.invoke('remote_cli_schedule_operation', { requestId: args.requestId })).rejects.toThrow('Unknown');
    expect(await next.invoke('remote_cli_schedule_list', { requestId: 'next-list' })).toMatchObject({ status: 'succeeded' });
    await expect(f.scope.invoke('remote_cli_schedule_list', null as any)).rejects.toThrow('arguments');
  });

  it('returns bounded receipts while a sixty-second native operation outlives the MCP timeout', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.options.run.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve([]), 60_000)));
      const scope = f.operations.scope({ ...f.options, waitMs: undefined });
      const create = scope.invoke('remote_cli_schedule_create', args);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await create).toMatchObject({ status: 'pending' });
      const inspection = scope.invoke('remote_cli_schedule_operation', { requestId: args.requestId });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await inspection).toMatchObject({ status: 'pending' });
      let closed = false;
      const close = scope.close().then(() => { closed = true; });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(closed).toBe(false);
      await expect(scope.invoke('remote_cli_schedule_create', args)).rejects.toThrow('no longer active');
      await vi.advanceTimersByTimeAsync(24_000);
      await close;
      expect(f.options.run).toHaveBeenCalledOnce(); expect(f.options.present).toHaveBeenCalledOnce();
      expect(await f.operations.scope(f.options).invoke('remote_cli_schedule_operation', { requestId: args.requestId })).toMatchObject({ status: 'succeeded' });
    } finally { vi.useRealTimers(); }
  });
});

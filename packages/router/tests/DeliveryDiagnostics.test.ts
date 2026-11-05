import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardDeliveryDiagnostics, deliveryEvent, safeCardError, safeSdkLogger, taskCorrelation } from '../src/utils/DeliveryDiagnostics';

const card = (text: string, count = 1) => JSON.stringify({ schema: '2.0', body: { elements:
  Array.from({ length: count }, () => ({ tag: 'markdown', content: text })) } });
const context = { operation: 'update' as const, cardId: 'synthetic-card', taskId: 'synthetic-task' };
const failure = { response: { status: 400, data: { code: 230099, msg: 'ErrCode: 200800; private-error-sentinel', error: { log_id: 'trace-123' } } },
  config: { headers: { Authorization: 'credential-sentinel' }, data: 'request-body-sentinel' } };

describe('delivery diagnostics', () => {
  let diagnostics: CardDeliveryDiagnostics;
  const events = (name?: string) => vi.mocked(console.info).mock.calls.map(call => call[1] as any).filter(e => !name || e.event === name);
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    diagnostics = new CardDeliveryDiagnostics();
  });
  afterEach(() => { diagnostics.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('measures exact serialized UTF8 bytes separately from UTF16 and never invents HTTP success', async () => {
    const content = card('\u00e9\ud83d\ude80');
    const response = { code: 0 };
    expect(await diagnostics.deliver(context, content, async () => response)).toBe(response);
    const event = events('card_delivery')[0];
    expect(event).toMatchObject({ sequence: 1, status: 'success', apiCode: 0,
      payload: { utf8Bytes: Buffer.byteLength(content), utf16Units: content.length, schema: '2.0', taggedNodes: 1 } });
    expect(event.httpStatus).toBeUndefined();
    expect(event.payload.utf8Bytes).toBeGreaterThan(event.payload.utf16Units);
    expect(events('card_attempt')).toHaveLength(1);
    await diagnostics.deliver(context, content, async () => ({}));
    expect(events('card_delivery').at(-1).status).toBe('unknown');
  });

  it('normalizes nested and top-level trace IDs and never exports arbitrary errors', () => {
    expect(safeCardError(failure)).toMatchObject({ httpStatus: 400, apiCode: 230099, subCode: 200800, traceId: 'trace-123' });
    expect(safeCardError({ code: 5, log_id: 'top-level' }).traceId).toBe('top-level');
    expect(safeCardError({ response: { data: { error: { log_id: 'invalid/trace' } } }, log_id: 'outer-trace' }).traceId).toBe('outer-trace');
    expect(safeCardError({ error: { log_id: 'https://example.com/private' } }).traceId).toBeUndefined();
    expect(safeCardError({ error: { log_id: 'x'.repeat(129) } }).traceId).toBeUndefined();
    expect(safeCardError({ code: '0', response: { status: '200' } }).apiCode).toBeUndefined();
    expect(safeCardError(new Error('password-sentinel')).category).toBe('Error');
    expect(safeCardError({ code: 'ECONNRESET' }).category).toBe('ECONNRESET');
    expect(safeCardError({ get response() { throw new Error('unsafe'); } })).toEqual({});
  });

  it('compares only the first failure to last explicit success and aggregates repeated errors', async () => {
    await diagnostics.deliver(context, card('old', 12), async () => ({ code: 0 }));
    await diagnostics.deliver(context, card('unknown', 12), async () => ({}));
    for (let i = 0; i < 184; i++) {
      await expect(diagnostics.deliver(context, card('tool-command-sentinel', 12), async () => { throw failure; })).rejects.toBe(failure);
    }
    const rejected = events('card_delivery').filter(e => e.status === 'failure');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].lastSuccess.utf8Bytes).toBe(Buffer.byteLength(card('old', 12)));
    expect(rejected[0].lastSuccessSequence).toBe(1);
    expect(rejected[0].changedComponents).toHaveLength(8);
    expect(rejected[0].changedCount).toBe(12);
    vi.advanceTimersByTime(30_000);
    await expect(diagnostics.deliver(context, card('next'), async () => { throw failure; })).rejects.toBe(failure);
    expect(events('card_failure_summary').at(-1)).toMatchObject({ count: 185, firstAt: 1_000_000, lastAt: 1_030_000 });
    const serialized = JSON.stringify(events());
    for (const sentinel of ['private-error-sentinel', 'credential-sentinel', 'request-body-sentinel', 'tool-command-sentinel', context.cardId, context.taskId]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(rejected[0].changedComponents.every((c: any) => /^0(?:\.\d+)*$/.test(c.path))).toBe(true);
  });

  it('separates hash skips from sends and flushes aggregates on recovery and close', async () => {
    diagnostics.skip(context); diagnostics.skip(context);
    expect(events('card_delivery')).toHaveLength(0);
    expect(events('card_hash_skip')).toHaveLength(1);
    await diagnostics.deliver(context, card('a'), async () => ({ code: 1 }));
    await diagnostics.deliver(context, card('a'), async () => ({ code: 2 }));
    await diagnostics.deliver(context, card('a'), async () => ({ code: 0 }));
    expect(events('card_hash_skips')[0].count).toBe(2);
    expect(events('card_failure_summary')).toHaveLength(2);
    diagnostics.skip(context); diagnostics.close();
    expect(events('card_hash_skips').at(-1).count).toBe(1);
  });

  it('bounds tracked cards, bindings, traversal and component manifests and expires idle entries', async () => {
    for (let i = 0; i < 70; i++) {
      diagnostics.bind(`card-${i}`, `task-${i}`);
      await diagnostics.deliver({ ...context, cardId: `card-${i}` }, card('x', 300), async () => ({ code: 0 }));
    }
    expect((diagnostics as any).cards.size).toBe(64);
    expect((diagnostics as any).bindings.size).toBe(64);
    const manifest = [...(diagnostics as any).cards.values()][0].success;
    expect(manifest.components).toHaveLength(256);
    expect(manifest.truncated).toBe(true);
    vi.advanceTimersByTime(30 * 60_000 + 1);
    diagnostics.skip(context);
    expect((diagnostics as any).cards.size).toBe(1);
    expect((diagnostics as any).bindings.size).toBe(0);
    await diagnostics.deliver(context, card('x'.repeat(4 * 1024 * 1024)), async () => ({ code: 0 }));
    expect(events('card_delivery').at(-1).payload).toMatchObject({ truncated: true, largestBlocks: [] });
    await diagnostics.deliver(context, card('x', 5000), async () => ({ code: 0 }));
    expect(events('card_delivery').at(-1).payload.truncated).toBe(true);
    let deep: any = { tag: 'markdown', content: 'x' };
    for (let i = 0; i < 40; i++) deep = { elements: [deep] };
    await diagnostics.deliver(context, JSON.stringify(deep), async () => ({ code: 0 }));
    expect(events('card_delivery').at(-1).payload).toMatchObject({ maxDepth: 32, truncated: true });
  });

  it('also bounds detailed manifests while many requests await their outcomes', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const requests = Array.from({ length: 70 }, (_, index) => diagnostics.deliver(
      { ...context, cardId: `pending-${index}` }, card('x'), async () => { await gate; return { code: 0 }; }));
    try { expect((diagnostics as any).detailedInFlight).toBe(64); }
    finally { release(); await Promise.all(requests); }
    expect((diagnostics as any).detailedInFlight).toBe(0);
    expect(events('card_delivery').filter(event => event.payload.truncated)).toHaveLength(6);
  });

  it('counts format features and uses keyed content fingerprints independently of structural hashes', async () => {
    const content = card('**Copyable diff preview**\n```diff\n+added\n-removed\n```\n<font color="red">x</font>\n| a | b |');
    await diagnostics.deliver(context, content, async () => ({ code: 0 }));
    const first = events('card_delivery').at(-1).payload;
    expect(first).toMatchObject({ fontTags: 1, fences: 2, diffLines: 2, copyableDiffPreviews: 1, markdownTableRows: 1 });
    const other = new CardDeliveryDiagnostics();
    await other.deliver(context, content, async () => ({ code: 0 }));
    const second = events('card_delivery').at(-1).payload;
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(first.largestBlocks[0].structure).toBe(second.largestBlocks[0].structure);
    other.close();
  });

  it('counts line-local features across long blank runs without consuming adjacent lines', async () => {
    const text = '```diff\n' + '\n'.repeat(40_000)
      + ' \t```\n| first | row |\n' + '\n'.repeat(40_000)
      + ' \t| second | row |\r\n';
    const send = vi.fn().mockResolvedValue({ code: 0 });
    await diagnostics.deliver(context, card(text), send);
    expect(send).toHaveBeenCalledOnce();
    expect(events('card_delivery').at(-1).payload).toMatchObject({
      fences: 2, markdownTableRows: 2, truncated: false,
    });
  });

  it('binds initial and continuation cards to tasks without emitting their identifiers', async () => {
    await diagnostics.deliver({ operation: 'create', taskId: 'task' }, card('x'), async () => ({ code: 0, data: { message_id: 'root' } }));
    await diagnostics.deliver({ operation: 'create', rootId: 'root', index: 1 }, card('x'), async () => ({ code: 0, data: { message_id: 'child' } }));
    expect(events('card_delivery').map(e => e.task)).toEqual([taskCorrelation('task'), taskCorrelation('task')]);
    await diagnostics.deliver({ operation: 'tail-clear', rootId: 'root', cardId: 'child', index: 1 }, card(''), async () => ({ code: 0 }));
    expect(events('card_delivery').at(-1)).toMatchObject({ task: taskCorrelation('task'), operation: 'tail-clear' });
    expect(taskCorrelation('x'.repeat(513))).toBeUndefined();
    expect(taskCorrelation(undefined)).toBeUndefined();
  });

  it('survives invalid diagnostic input and throwing loggers without changing results or errors', async () => {
    const send = vi.fn().mockResolvedValue({ code: 0 });
    await diagnostics.deliver(context, 'not JSON', send);
    expect(send).toHaveBeenCalledOnce();
    vi.mocked(console.info).mockImplementation(() => { throw new Error('logger broken'); });
    expect(() => deliveryEvent('safe')).not.toThrow();
    await expect(diagnostics.deliver(context, card('x'), send)).resolves.toEqual({ code: 0 });
    await expect(diagnostics.deliver(context, card('x'), async () => { throw failure; })).rejects.toBe(failure);
    expect(() => diagnostics.skip(context)).not.toThrow();
  });

  it('replaces SDK Axios dumps with rate-limited allowlisted metadata', () => {
    const logger = safeSdkLogger();
    logger.error([[failure]]);
    for (let i = 0; i < 20; i++) logger.warn(failure);
    logger.info(); logger.debug(); logger.trace();
    expect(events('sdk_error')).toHaveLength(1);
    expect(events('sdk_error')[0]).toMatchObject({ apiCode: 230099, count: 1, traceId: 'trace-123' });
    vi.advanceTimersByTime(30_000); logger.error(failure);
    expect(events('sdk_error').at(-1).count).toBe(21);
    expect(JSON.stringify(events())).not.toMatch(/sentinel|Authorization|config/);
    vi.mocked(console.info).mockImplementation(() => { throw new Error('logger unavailable'); });
    vi.advanceTimersByTime(30_000);
    expect(() => logger.error(failure)).not.toThrow();
  });
});

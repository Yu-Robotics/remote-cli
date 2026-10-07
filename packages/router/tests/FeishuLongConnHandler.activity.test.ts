import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as lark from '@larksuiteoapi/node-sdk';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';
import { ACTIVITY_ELEMENT_ID } from '../src/utils/ActivityProgress';
import { WorkerContextCards } from '../src/feishu/WorkerContextCards';
import { createDelegationProgressElements } from '../src/utils/ToolFormatter';

vi.mock('@larksuiteoapi/node-sdk');
vi.mock('../src/binding/BindingManager');

describe('main activity card tail', () => {
  let handler: FeishuLongConnHandler;
  let client: any;
  let delivered: Map<string, any[]>;
  const activity = { source: 'plan' as const, text: 'Checking the timeout path' };
  const elements = (count: number) => Array.from({ length: count }, (_, index) => ({ tag: 'markdown', content: `Line ${index}` }));
  const rows = (body: any[]) => body.filter(element => element.element_id === ACTIVITY_ELEMENT_ID);
  const runningCards = () => [...delivered.entries()].filter(([, body]) => rows(body).length > 0);
  const update = (body: any[], snapshot?: typeof activity) => handler.updateStreamingMessage('root', body, 'owner', 'thread', '/workspace', snapshot);

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delivered = new Map();
    let nextId = 0;
    client = { im: { message: {
      patch: vi.fn(async ({ path, data }) => {
        delivered.set(path.message_id, JSON.parse(data.content).body.elements);
        return {};
      }),
      create: vi.fn(async ({ data }) => {
        const id = `page-${++nextId}`;
        delivered.set(id, JSON.parse(data.content).body.elements);
        return { data: { message_id: id } };
      }),
      delete: vi.fn(),
    } } };
    vi.mocked(lark.Client).mockImplementation(() => client);
    handler = new FeishuLongConnHandler({ appId: 'fixture', appSecret: 'fixture', store: {} as any });
  });

  afterEach(() => {
    handler.workerContexts?.destroy();
    vi.restoreAllMocks();
  });

  it('keeps one mutable tail after all transcript, tool and worker sections across ordinary patches', async () => {
    const worker = createDelegationProgressElements({ taskId: 'worker', backend: 'codex', phase: 'text', ordinal: 1,
      startedAt: 0, activeToolCount: 0, events: [], hiddenEventCount: 0 });
    await update([...elements(1), ...worker], activity);
    expect(delivered.get('root')!.at(-1)).toMatchObject({ element_id: ACTIVITY_ELEMENT_ID,
      content: 'Running · <raw>Checking the timeout path</raw>' });
    await update([...elements(2), ...worker, { tag: 'markdown', content: 'Tool result' }]);
    expect(delivered.get('root')!.at(-2).content).toBe('Tool result');
    expect(rows(delivered.get('root')!)).toHaveLength(1);
    await update([...elements(2), ...worker,
      { tag: 'collapsible_panel', header: { title: { tag: 'markdown', content: 'Plan' } }, elements: elements(1) },
      { tag: 'img', img_key: 'image-fixture', alt: { tag: 'plain_text', content: 'Image' } }]);
    expect(delivered.get('root')!.at(-2).tag).toBe('img');
    expect(rows(delivered.get('root')!)).toHaveLength(1);
    await update(elements(3), { ...activity, text: 'Reviewing the result' });
    expect(delivered.get('root')!.at(-1).content).toContain('Reviewing the result');
    expect(JSON.stringify(delivered.get('root'))).not.toContain(activity.text);
  });

  it('migrates the tail across two and three pages, stripping sealed and surplus pages', async () => {
    await update(elements(3), activity);
    await update(elements(160));
    expect(delivered.size).toBe(2);
    expect(runningCards().map(([id]) => id)).toEqual(['page-1']);
    expect(rows(delivered.get('root')!)).toHaveLength(0);
    await update(elements(310));
    expect(delivered.size).toBe(3);
    expect(runningCards().map(([id]) => id)).toEqual(['page-2']);
    await update(elements(1));
    expect(runningCards().map(([id]) => id)).toEqual(['root']);
    expect(JSON.stringify(delivered.get('page-2'))).toContain('Line 309');
    expect(client.im.message.delete).not.toHaveBeenCalled();
    for (const body of delivered.values()) expect(rows(body).length).toBeLessThanOrEqual(1);
  });

  it('reserves footer space at the element boundary instead of creating an activity-only page', async () => {
    await update(elements(149), activity);
    expect(delivered.size).toBe(2);
    for (const body of delivered.values()) {
      expect(body.length).toBeLessThanOrEqual(150);
      expect(body.some(element => /^Line /.test(element.content ?? ''))).toBe(true);
    }
    expect(runningCards()).toHaveLength(1);
    expect(runningCards()[0][1].at(-1).element_id).toBe(ACTIVITY_ELEMENT_ID);
  });

  it('cleans a surplus terminal page without losing Worker context controls or their later updates', async () => {
    handler.workerContexts = new WorkerContextCards({ ownsDevice: async () => true, available: () => true,
      send: async () => true, refresh: (cardId, rootId) => handler.refreshWorkerContextCard(cardId, rootId) });
    const id = handler.workerContexts.register({ openId: 'owner', deviceId: 'device', threadId: 'thread', laneId: 'lane', generation: 1 })!;
    const worker = createDelegationProgressElements({ taskId: 'worker', backend: 'codex', phase: 'succeeded', ordinal: 1,
      summary: 'Worker result', contextActionId: id, startedAt: 0, finishedAt: 1, activeToolCount: 0, events: [], hiddenEventCount: 0 });
    await update([...elements(144), ...worker], activity);
    const [tailId] = runningCards()[0];
    expect(tailId).not.toBe('root');
    const threads = [{ id: 'thread', name: 'thread', status: 'idle' as const }];
    await handler.finalizeStreamingMessage('root', elements(1), 'session', 'owner', '/workspace', 'thread', threads, 'thread');
    expect(runningCards()).toHaveLength(0);
    expect(JSON.stringify(delivered.get(tailId))).toContain('worker_context_clear');
    expect(handler.workerContexts.contentFor(tailId)).not.toContain('Running ·');
    await handler.workerContexts.click('owner', id, tailId);
    await handler.refreshWorkerContextCard(tailId, 'root');
    expect(JSON.stringify(delivered.get(tailId))).toContain('Clearing context...');
    expect(JSON.stringify(delivered.get(tailId))).not.toContain('Running ·');
    await (handler as any).refreshThreadSwitchButtons('root', 'thread');
    expect(JSON.stringify(delivered.get('root'))).toContain('Completed');
    expect(rows(delivered.get('root')!)).toHaveLength(0);
  });

  it('serializes concurrent content/activity updates before finalization and blocks late patches', async () => {
    const patch = client.im.message.patch.getMockImplementation();
    let release!: () => void;
    client.im.message.patch.mockImplementationOnce(async args => {
      await new Promise<void>(resolve => { release = resolve; });
      return patch(args);
    });
    const first = update(elements(2), activity);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const tool = update([...elements(2), { tag: 'markdown', content: 'Tool finished' }]);
    const next = update(elements(4), { ...activity, text: 'Verifying' });
    const final = handler.finalizeStreamingMessage('root', [{ tag: 'markdown', content: 'Final answer' }], undefined, 'owner');
    const late = update(elements(9), activity);
    release();
    expect(await Promise.all([first, tool, next, final, late])).toEqual([true, true, true, true, false]);
    expect(JSON.stringify(delivered.get('root'))).toContain('Final answer');
    expect(JSON.stringify(delivered.get('root'))).not.toContain('Running ·');
    expect((handler as any).activityShells.get('root').tail).toBeUndefined();
  });

  it('retries failed tail cleanup before publishing a new active page', async () => {
    await update(elements(2), activity);
    client.im.message.patch.mockRejectedValueOnce(new Error('temporary rejection'));
    expect(await update(elements(160))).toBe(false);
    expect(client.im.message.create).not.toHaveBeenCalled();
    expect(runningCards().map(([id]) => id)).toEqual(['root']);
    expect(await update(elements(160))).toBe(true);
    expect(runningCards().map(([id]) => id)).toEqual(['page-1']);
  });

  it('renders failure honestly and preserves metadata and final thread controls', async () => {
    await update(elements(1), activity);
    await handler.finalizeStreamingMessage('root', [{ tag: 'markdown', content: 'Error details' }], undefined, 'owner', '/workspace',
      'thread', [{ id: 'thread', name: 'thread', status: 'error' }], 'thread', undefined,
      { backend: 'codex', model: 'test-model', modelSource: 'reported', effortSource: 'default' }, false);
    const final = JSON.stringify(delivered.get('root'));
    expect(final).toContain('Failed');
    expect(final).not.toContain('Completed');
    expect(final).not.toContain('Running ·');
    expect(final).toContain('test-model');
    expect(final).toContain('switch_thread');
  });

  it('keeps finalization retryable if cleaning a surplus activity page fails', async () => {
    await update(elements(160), activity);
    client.im.message.patch.mockRejectedValueOnce(new Error('temporary rejection'));
    expect(await handler.finalizeStreamingMessage('root', elements(1), undefined, 'owner')).toBe(false);
    expect(runningCards().map(([id]) => id)).toEqual(['page-1']);
    expect(await update(elements(1), activity)).toBe(false);
    expect(await handler.finalizeStreamingMessage('root', elements(1), undefined, 'owner')).toBe(true);
    expect(runningCards()).toHaveLength(0);
    expect(JSON.stringify(delivered.get('root'))).toContain('Completed');
  });

  it('clears activity after Markdown fallback without dropping card content', async () => {
    client.im.message.patch.mockRejectedValueOnce({ code: 230099, msg: 'ErrCode: 11311 markdown content parse error' });
    expect(await update(elements(1), activity)).toBe(true);
    expect(runningCards()).toHaveLength(1);
    await update(elements(160));
    expect(runningCards().map(([id]) => id)).toEqual(['page-1']);
    expect(JSON.stringify(delivered.get('root'))).toContain('Line 0');
    await handler.finalizeStreamingMessage('root', elements(1), undefined, 'owner');
    expect(runningCards()).toHaveLength(0);
    expect(JSON.stringify([...delivered.values()])).not.toContain('Running ·');
  });

  it('leaves no-activity card JSON and legacy update behavior unchanged', async () => {
    await update([{ tag: 'markdown', content: 'Answer' }]);
    expect(delivered.get('root')).toEqual([
      { tag: 'markdown', content: '🧵 **thread**  ·  📂 `/workspace`' }, { tag: 'hr' }, { tag: 'markdown', content: 'Answer' },
    ]);
    expect((handler as any).activityShells.size).toBe(0);
    await handler.finalizeStreamingMessage('root', [{ tag: 'markdown', content: 'Answer' }]);
    expect(delivered.get('root')!.at(-1)).toEqual({ tag: 'markdown', content: '✅ Completed' });
  });
});

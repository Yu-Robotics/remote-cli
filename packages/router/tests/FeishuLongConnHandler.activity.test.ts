import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as lark from '@larksuiteoapi/node-sdk';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';
import { ACTIVITY_ELEMENT_ID } from '../src/utils/ActivityProgress';
import { WorkerContextCards } from '../src/feishu/WorkerContextCards';
import { createDelegationProgressElements, createToolCallElement, createToolResultElement, createToolUseElement } from '../src/utils/ToolFormatter';

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
  const toolRows = () => [...delivered.values()].flat().filter(element => element.tag === 'collapsible_panel'
    && element.header?.title?.content?.includes('Edit'));
  const pairedTool = (elementIndex = 140, id = 'edit-1') => {
    const state = { elementIndex, name: 'Edit', id,
      inputElements: createToolUseElement({ name: 'Edit', id, input: { file_path: '/project/example.ts' } }) };
    const diff = Array.from({ length: 6 }, (_, index) => `--- a/file-${index}.ts\n+++ b/file-${index}.ts\n@@ -1 +1 @@\n-old\n+new`).join('\n');
    return {
      pending: createToolCallElement(state),
      large: createToolCallElement({ ...state, resultElements: createToolResultElement({ tool_use_id: state.id, content: '', diff }) }),
      small: createToolCallElement({ ...state, isError: true,
        resultElements: createToolResultElement({ tool_use_id: state.id, content: 'Latest failure', is_error: true }) }),
    };
  };

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

  it('patches a paired tool on an earlier page without duplicating it or losing the tail and Worker controls', async () => {
    handler.workerContexts = new WorkerContextCards({ ownsDevice: async () => true, available: () => true,
      send: async () => true, refresh: (cardId, rootId) => handler.refreshWorkerContextCard(cardId, rootId) });
    const actionId = handler.workerContexts.register({ openId: 'owner', deviceId: 'device', threadId: 'thread', laneId: 'lane', generation: 1 })!;
    const worker = createDelegationProgressElements({ taskId: 'worker', backend: 'agy', phase: 'succeeded', ordinal: 1,
      summary: 'Independent review', contextActionId: actionId, startedAt: 0, finishedAt: 1, activeToolCount: 0, events: [], hiddenEventCount: 0 });
    const state = { name: 'Read', id: 'read-1',
      inputElements: createToolUseElement({ name: 'Read', id: 'read-1', input: { file_path: '/project/example.ts' } }) };
    const body = [createToolCallElement(state), ...elements(155), ...worker];
    await update(body, activity);
    const pageIds = [...delivered.keys()];
    const completed = createToolCallElement({ ...state, isError: false,
      resultElements: createToolResultElement({ tool_use_id: 'read-1', content: 'File contents', is_error: false }) });
    body[0] = completed;
    await update(body);
    expect([...delivered.keys()]).toEqual(pageIds);
    const toolRows = [...delivered.values()].flat().filter(element => element.tag === 'collapsible_panel'
      && element.header?.title?.content?.includes('Read'));
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0].header.title.content).toContain('SUCCESS');
    expect(JSON.stringify(toolRows[0])).toContain('File contents');
    expect(runningCards()).toHaveLength(1);
    expect(runningCards()[0][0]).not.toBe('root');
    expect(JSON.stringify([...delivered.values()])).toContain('worker_context_clear');
    expect(JSON.stringify([...delivered.values()])).toContain('Independent review');
    for (const content of delivered.values()) expect((handler as any).countTaggedNodes(content)).toBeLessThanOrEqual(150);
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

  it.each([false, true])('removes an obsolete paired result when two cards shrink to one (activity=%s)', async hasActivity => {
    const tool = pairedTool();
    const prefix = elements(140);
    expect(await update([...prefix, tool.pending], hasActivity ? activity : undefined)).toBe(true);
    expect(delivered.size).toBe(1);
    expect(await update([...prefix, tool.large])).toBe(true);
    expect(delivered.size).toBe(2);
    expect(toolRows()).toHaveLength(1);
    expect(toolRows()[0].header.title.content).toContain('SUCCESS');
    expect(await update([...prefix, tool.small])).toBe(true);
    expect((handler as any).messageChains.get('root')).toHaveLength(2);
    expect(toolRows()).toHaveLength(1);
    expect(toolRows()[0].header.title.content).toContain('ERROR');
    expect(JSON.stringify(delivered.get('page-1'))).not.toContain('SUCCESS');
    expect(JSON.stringify(delivered.get('page-1'))).not.toContain('file-5.ts');
    expect(runningCards().map(([id]) => id)).toEqual(hasActivity ? ['root'] : []);
    expect(client.im.message.delete).not.toHaveBeenCalled();
  });

  it('retries surplus tool cleanup before publishing a replacement, including fallback and page reuse', async () => {
    const tool = pairedTool();
    const prefix = elements(140);
    await update([...prefix, tool.large]);
    client.im.message.patch.mockRejectedValueOnce(new Error('temporary rejection'));
    expect(await update([...prefix, tool.small])).toBe(false);
    expect(toolRows()).toHaveLength(1);
    expect(toolRows()[0].header.title.content).toContain('SUCCESS');
    expect(JSON.stringify(delivered.get('root'))).not.toContain('Latest failure');
    expect((handler as any).toolPageRemainders.get('root').has(1)).toBe(true);
    client.im.message.patch.mockResolvedValueOnce({ code: 230099, msg: 'ErrCode: 11311 markdown content parse error' });
    expect(await update([...prefix, tool.small])).toBe(true);
    expect(toolRows()).toHaveLength(1);
    expect(toolRows()[0].header.title.content).toContain('ERROR');
    expect((handler as any).plainTextCards.get('root').has(1)).toBe(true);
    const creates = client.im.message.create.mock.calls.length;
    expect(await update([...prefix, tool.large])).toBe(true);
    expect(client.im.message.create).toHaveBeenCalledTimes(creates);
    expect(toolRows()).toHaveLength(1);
    expect(toolRows()[0].header.title.content).toContain('SUCCESS');
    expect(await update([...prefix, tool.small])).toBe(true);
    expect(toolRows()).toHaveLength(1);
    expect(toolRows()[0].header.title.content).toContain('ERROR');
  });

  it.each([false, true])('clears an old owner before a backward migration between active pages (activity=%s)', async hasActivity => {
    const tool = pairedTool(135);
    const body = (row: any) => [...elements(135), row, ...elements(20)];
    await update(body(tool.large), hasActivity ? activity : undefined);
    expect(delivered.size).toBe(2);
    expect(delivered.get('page-1')!.some(element => element.element_id === 'tc_135')).toBe(true);
    const patch = client.im.message.patch.getMockImplementation();
    client.im.message.patch.mockClear();
    client.im.message.patch.mockImplementation(async args => {
      if (args.path.message_id === 'page-1') throw new Error('source page unavailable');
      return patch(args);
    });
    expect(await update(body(tool.small))).toBe(false);
    expect(client.im.message.patch.mock.calls[0][0].path.message_id).toBe('page-1');
    expect(toolRows()).toHaveLength(1);
    expect(toolRows()[0].header.title.content).toContain('SUCCESS');
    expect(JSON.stringify(delivered.get('root'))).not.toContain('Latest failure');
    expect((handler as any).toolPageRemainders.get('root').has(1)).toBe(true);
    client.im.message.patch.mockImplementation(patch);
    expect(await update(body(tool.small))).toBe(true);
    expect((handler as any).messageChains.get('root')).toHaveLength(2);
    expect(toolRows()).toHaveLength(1);
    expect(toolRows()[0].header.title.content).toContain('ERROR');
    expect(delivered.get('root')!.some(element => element.element_id === 'tc_135')).toBe(true);
    expect(delivered.get('page-1')!.some(element => element.element_id === 'tc_135')).toBe(false);
    expect(runningCards().map(([id]) => id)).toEqual(hasActivity ? ['page-1'] : []);
  });

  it('clears a root-card owner before a forward migration and retries a failed destination patch', async () => {
    const tool = pairedTool(135);
    const body = (row: any) => [...elements(135), row, ...elements(20)];
    await update(body(tool.small), activity);
    expect(delivered.size).toBe(2);
    expect(delivered.get('root')!.some(element => element.element_id === 'tc_135')).toBe(true);
    const patch = client.im.message.patch.getMockImplementation();
    client.im.message.patch.mockImplementation(async args => {
      if (args.path.message_id === 'page-1') throw new Error('destination page unavailable');
      return patch(args);
    });
    expect(await update(body(tool.large))).toBe(false);
    expect(toolRows()).toHaveLength(0);
    client.im.message.patch.mockImplementation(patch);
    expect(await update(body(tool.large))).toBe(true);
    expect(toolRows()).toHaveLength(1);
    expect(toolRows()[0].header.title.content).toContain('SUCCESS');
    expect(delivered.get('page-1')!.some(element => element.element_id === 'tc_135')).toBe(true);
    expect(runningCards().map(([id]) => id)).toEqual(['page-1']);
  });

  it('clears every old owner before publishing several backward moves, including a later cleanup failure', async () => {
    const first = pairedTool(135, 'edit-1');
    const second = pairedTool(261, 'edit-2');
    const body = (one: any, two: any) => [...elements(135), one, ...elements(125), two, ...elements(20)];
    const before = body(first.large, second.large);
    const after = body(first.small, second.small);
    await update(before, activity);
    expect(delivered.size).toBe(3);
    expect(delivered.get('page-1')!.some(element => element.element_id === 'tc_135')).toBe(true);
    expect(delivered.get('page-2')!.some(element => element.element_id === 'tc_261')).toBe(true);
    const patch = client.im.message.patch.getMockImplementation();
    client.im.message.patch.mockImplementation(async args => {
      if (args.path.message_id === 'page-2') throw new Error('second source unavailable');
      return patch(args);
    });
    expect(await update(after)).toBe(false);
    expect(toolRows()).toHaveLength(1);
    expect(toolRows()[0].element_id).toBe('tc_261');
    client.im.message.patch.mockImplementation(patch);
    expect(await update(after)).toBe(true);
    expect(toolRows()).toHaveLength(2);
    expect(delivered.get('root')!.some(element => element.element_id === 'tc_135')).toBe(true);
    expect(delivered.get('page-1')!.some(element => element.element_id === 'tc_261')).toBe(true);
  });

  it('cleans every surplus tool page, not only the last activity-bearing card', async () => {
    const first = pairedTool();
    const second = pairedTool(281, 'edit-2');
    await update([...elements(140), first.large, ...elements(140), second.large], activity);
    expect(delivered.size).toBe(3);
    expect((handler as any).toolPageRemainders.get('root').size).toBe(2);
    expect(await update([first.small, second.small])).toBe(true);
    expect(toolRows()).toHaveLength(2);
    expect(toolRows().every(element => element.header.title.content.includes('ERROR'))).toBe(true);
    for (const [id, body] of delivered) {
      if (id !== 'root') expect(body.some(element => element.element_id?.startsWith('tc_'))).toBe(false);
      expect((handler as any).countTaggedNodes(body)).toBeLessThanOrEqual(150);
    }
    expect(runningCards().map(([id]) => id)).toEqual(['root']);
    expect(await handler.finalizeStreamingMessage('root', [first.small, second.small], undefined, 'owner')).toBe(true);
    expect((handler as any).toolPageRemainders.has('root')).toBe(false);
    expect(runningCards()).toHaveLength(0);
    expect(toolRows()).toHaveLength(2);
  });

  it('preserves surplus Worker results and Clear context updates without resurrecting an obsolete tool', async () => {
    handler.workerContexts = new WorkerContextCards({ ownsDevice: async () => true, available: () => true,
      send: async () => true, refresh: (cardId, rootId) => handler.refreshWorkerContextCard(cardId, rootId) });
    const id = handler.workerContexts.register({ openId: 'owner', deviceId: 'device', threadId: 'thread', laneId: 'lane', generation: 1 })!;
    const worker = createDelegationProgressElements({ taskId: 'worker', backend: 'agy', phase: 'succeeded', ordinal: 1,
      summary: 'Worker result', contextActionId: id, startedAt: 0, finishedAt: 1, activeToolCount: 0, events: [], hiddenEventCount: 0 });
    const tool = pairedTool();
    await update([...elements(140), tool.large, ...worker], activity);
    expect(delivered.size).toBe(2);
    expect(JSON.stringify(delivered.get('page-1'))).toContain('Worker result');
    expect(await handler.finalizeStreamingMessage('root', [tool.small], undefined, 'owner', '/workspace', 'thread',
      [{ id: 'thread', name: 'thread', status: 'idle' }], 'thread')).toBe(true);
    expect(toolRows()).toHaveLength(1);
    expect(toolRows()[0].header.title.content).toContain('ERROR');
    expect(JSON.stringify(delivered.get('page-1'))).toContain('worker_context_clear');
    expect(handler.workerContexts.contentFor('page-1')).not.toContain('file-5.ts');
    await handler.workerContexts.click('owner', id, 'page-1');
    await handler.refreshWorkerContextCard('page-1', 'root');
    expect(JSON.stringify(delivered.get('page-1'))).toContain('Clearing context...');
    expect(toolRows()).toHaveLength(1);
    await (handler as any).refreshThreadSwitchButtons('root', 'thread');
    expect(JSON.stringify(delivered.get('root'))).toContain('Completed');
    expect(JSON.stringify(delivered.get('root'))).toContain('switch_thread');
    expect(runningCards()).toHaveLength(0);
    expect((handler as any).toolPageRemainders.has('root')).toBe(false);
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

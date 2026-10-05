import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerContextCards, workerContextControl } from '../src/feishu/WorkerContextCards';

describe('WorkerContextCards', () => {
  const target = { openId: 'owner', deviceId: 'device', threadId: 'thread', laneId: 'lane', generation: 4 };
  let cards: WorkerContextCards;
  let transport: any;
  const payload = (id: string) => JSON.stringify({ schema: '2.0', body: { elements: [workerContextControl(id)] } });
  function register() {
    const id = cards.register(target)!;
    cards.remember('card', 'root', payload(id));
    return id;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    transport = { ownsDevice: vi.fn(async () => true), available: vi.fn(() => true),
      send: vi.fn(async () => true), refresh: vi.fn(async () => {}) };
    cards = new WorkerContextCards(transport);
  });
  afterEach(() => { cards.destroy(); vi.useRealTimers(); });

  it('requires an acknowledgement, deduplicates clicks, and rejects wrong-device replies', async () => {
    const id = register();
    await Promise.all([cards.click('owner', id, 'card'), cards.click('owner', id, 'card')]);
    expect(transport.send).toHaveBeenCalledTimes(1);
    const request = transport.send.mock.calls[0][1];
    expect(request).toMatchObject({ type: 'worker_context_reset', threadId: 'thread', laneId: 'lane', generation: 4 });
    expect(cards.contentFor('card')).toContain('Clearing context...');
    expect(cards.contentFor('card')).not.toContain('Context cleared');
    await cards.resolve('other-device', { messageId: request.messageId, success: true });
    expect(cards.contentFor('card')).not.toContain('Context cleared');
    await cards.resolve('device', { messageId: request.messageId, success: true });
    expect(cards.contentFor('card')).toContain('Context cleared');
    expect(JSON.parse(cards.contentFor('card')!).body.elements[0].columns[0].elements[0].disabled).toBe(true);
    expect(await cards.click('owner', id, 'card')).toContain('already cleared');
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.refresh).toHaveBeenCalledWith('card', 'root');
    expect(cards.decorate(payload(id))).toContain('Context cleared');
  });

  it('authorizes the original user, device, and actual delivered card without trusting button fields', async () => {
    const id = register();
    await expect(cards.click('stranger', id, 'card')).rejects.toThrow('another user');
    await expect(cards.click('owner', id, 'forged-card')).rejects.toThrow('expired');
    await expect(cards.click('owner', 'forged-id', 'card')).rejects.toThrow('expired');
    transport.ownsDevice.mockResolvedValue(false);
    await expect(cards.click('owner', id, 'card')).rejects.toThrow('another user');
    transport.ownsDevice.mockResolvedValue(true);
    transport.available.mockReturnValue(false);
    await expect(cards.click('owner', id, 'card')).rejects.toThrow('offline');
    expect(cards.register(target)).toBeUndefined();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('reports busy/error acknowledgements, timeout and transport failures without claiming success', async () => {
    const id = register();
    await cards.click('owner', id, 'card');
    const first = transport.send.mock.calls[0][1];
    await cards.resolve('device', { messageId: first.messageId, success: false,
      error: 'The Worker is active or its shutdown is unconfirmed. Wait before clearing context.' });
    expect(cards.contentFor('card')).toContain('unconfirmed');
    await cards.click('owner', id, 'card');
    await cards.resolve('device', { messageId: first.messageId, success: true });
    expect(cards.contentFor('card')).not.toContain('Context cleared');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cards.contentFor('card')).toContain('timed out');
    transport.send.mockResolvedValue(false);
    await expect(cards.click('owner', id, 'card')).rejects.toThrow('Could not contact');
    expect(cards.contentFor('card')).toContain('Retry clear context');
    const request = transport.send.mock.calls.at(-1)[1];
    await cards.resolve('device', { messageId: request.messageId, success: false, error: '<at id=all>private peer text</at>' });
    expect(cards.contentFor('card')).not.toContain('private peer');
    await cards.resolve('device', { messageId: request.messageId, success: true });
    expect(cards.contentFor('card')).toContain('Context cleared');
  });

  it('keeps cache bounded and expires removed controls and router-restart cards safely', async () => {
    const id = register();
    expect(cards.rootFor('card')).toBe('root');
    cards.remember('card', 'root', JSON.stringify({ body: { elements: [] } }));
    await expect(cards.click('owner', id, 'card')).rejects.toThrow('expired');
    cards.remember('card', 'root', payload(id));
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 1);
    expect(cards.contentFor('card')).toBeUndefined();
    expect(cards.decorate(payload(id))).toContain('Context control expired');
    await expect(cards.click('owner', id, 'card')).rejects.toThrow('expired');
    const oldest = cards.register(target)!;
    for (let i = 0; i < 500; i++) expect(cards.register(target)).toBeTruthy();
    expect(cards.decorate(payload(oldest))).toContain('Context control expired');
    expect((cards as any).actions.size).toBe(500);
    const fresh = new WorkerContextCards(transport);
    await expect(fresh.click('owner', id, 'card')).rejects.toThrow('expired');
    fresh.destroy();
    expect(cards.decorate('{}')).toBe('{}');
    await cards.resolve('device', {});
  });

  it('evicts large and numerous payloads without dropping confirmed CLI state', async () => {
    const id = register();
    const content = JSON.stringify({ body: { elements: [workerContextControl(id), { tag: 'markdown', content: 'x'.repeat(5 * 1024 * 1024) }] } });
    cards.remember('big-one', 'root', content);
    cards.remember('big-two', 'root', content);
    expect(cards.contentFor('big-one')).toBeUndefined();
    expect(cards.contentFor('big-two')).toBeDefined();
    cards.remember('oversized', 'root', content + ' '.repeat(4 * 1024 * 1024));
    expect(cards.contentFor('oversized')).toBeUndefined();
    for (let i = 0; i < 501; i++) cards.remember(`small-${i}`, 'root', payload(id));
    expect(cards.contentFor('small-0')).toBeUndefined();
    transport.refresh.mockRejectedValue(new Error('patch failed'));
    await cards.click('owner', id, 'small-500');
    await cards.resolve('device', { messageId: transport.send.mock.calls[0][1].messageId, success: true });
    expect(cards.contentFor('small-500')).toContain('Context cleared');
  });

  it('does not evict requests awaiting CLI acknowledgement under capacity pressure', () => {
    for (let i = 0; i < 500; i++) cards.register(target);
    for (const action of (cards as any).actions.values()) action.status = 'pending';
    expect(cards.register(target)).toBeUndefined();
  });
});

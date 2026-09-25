import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCards } from '../src/feishu/ApprovalCards';
import type { ApprovalRequestMessage } from '../src/types';

const request = (): ApprovalRequestMessage => ({ type: 'approval_request', messageId: 'approval-1',
  taskMessageId: 'task-1', openId: 'owner', threadId: 'thread-2', threadName: 'thread-2', cwd: '/project',
  approval: { requestId: 'approval-1', kind: 'file', description: 'Write <config> in another project',
    canRemember: true, writableRoots: ['/other-project'] }, timestamp: 1 });

describe('ApprovalCards', () => {
  let cards: ApprovalCards;
  let transport: {
    ownsDevice: ReturnType<typeof vi.fn>; sendToDevice: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; registerReplyRoute: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    transport = { ownsDevice: vi.fn().mockResolvedValue(true), sendToDevice: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue('card-1'), update: vi.fn().mockResolvedValue(undefined), registerReplyRoute: vi.fn() };
    cards = new ApprovalCards(transport);
  });
  afterEach(() => { cards.destroy(); vi.useRealTimers(); });

  it('renders scoped choices, routes to the original device, and waits for the CLI before showing approval', async () => {
    await cards.receive(request(), 'original-device', () => true);
    const elements = transport.create.mock.calls[0][1];
    expect(elements[0]).toMatchObject({ content: '**Permission request**' });
    expect(elements.filter((element: any) => element.tag === 'button').map((button: any) => button.text.content))
      .toEqual(['Allow', 'Deny', 'Allow and remember directory']);
    expect(JSON.stringify(elements)).toContain('&lt;config&gt;');
    expect(transport.registerReplyRoute).toHaveBeenCalledWith('card-1', 'thread-2', 'original-device');
    await expect(cards.click('someone-else', 'approval-1', 'card-1', 'approve')).rejects.toThrow('belong');
    await expect(cards.click('owner', 'approval-1', 'wrong-card', 'approve')).rejects.toThrow('expired');
    await cards.click('owner', 'approval-1', 'card-1', 'remember');
    await cards.click('owner', 'approval-1', 'card-1', 'deny');
    expect(transport.sendToDevice).toHaveBeenCalledTimes(1);
    expect(transport.sendToDevice).toHaveBeenCalledWith('original-device', expect.objectContaining({
      type: 'approval_response', messageId: 'approval-1', taskMessageId: 'task-1', threadId: 'thread-2', openId: 'owner', action: 'remember',
    }));
    await vi.waitFor(() => expect(JSON.stringify(transport.update.mock.calls)).toContain('Waiting for CLI confirmation'));
    expect(JSON.stringify(transport.update.mock.calls)).not.toContain('Approved and directory');
    await cards.resolve({ type: 'approval_resolved', messageId: 'approval-1', openId: 'owner', threadId: 'thread-2', status: 'remembered', timestamp: 2 }, 'original-device');
    expect(JSON.stringify(transport.update.mock.calls.at(-1))).toContain('Approved and directory access remembered');
    expect(transport.update.mock.calls.at(-1)![1].some((element: any) => element.tag === 'button')).toBe(false);
    await expect(cards.click('owner', 'approval-1', 'card-1', 'approve')).rejects.toThrow('expired');
    await cards.receive(request(), 'original-device', () => true);
    expect(transport.create).toHaveBeenCalledTimes(1);
  });

  it('never offers persistent command approval and revalidates ownership on click', async () => {
    const command = request();
    command.approval = { requestId: command.messageId, kind: 'command', description: 'install tools', canRemember: false };
    await cards.receive(command, 'device', () => true);
    expect(JSON.stringify(transport.create.mock.calls)).not.toContain('Allow and remember');
    await expect(cards.click('owner', 'approval-1', 'card-1', 'remember')).rejects.toThrow('does not support');
    transport.ownsDevice.mockResolvedValue(false);
    await expect(cards.click('owner', 'approval-1', 'card-1', 'approve')).rejects.toThrow('no longer available');
    expect(transport.sendToDevice).not.toHaveBeenCalled();
  });

  it('expires a request even when the card API finishes after the task', async () => {
    let finish!: (id: string) => void;
    transport.create.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const creating = cards.receive(request(), 'device', () => true);
    await vi.waitFor(() => expect(transport.create).toHaveBeenCalled());
    const finishing = cards.resolve({ type: 'approval_resolved', messageId: 'approval-1', openId: 'owner', threadId: 'thread-2', status: 'expired', timestamp: 2 }, 'device');
    finish('card-1');
    await Promise.all([creating, finishing]);
    expect(JSON.stringify(transport.update.mock.calls.at(-1))).toContain('Approval expired');
    await expect(cards.click('owner', 'approval-1', 'card-1', 'approve')).rejects.toThrow('expired');
  });

  it('recreates pending approvals after disconnect and rejects clicks on the old card', async () => {
    await cards.receive(request(), 'device', () => true);
    cards.disconnect('device');
    transport.create.mockResolvedValue('card-2');
    await cards.receive(request(), 'device', () => true);
    await expect(cards.click('owner', 'approval-1', 'card-1', 'approve')).rejects.toThrow('expired');
    await cards.click('owner', 'approval-1', 'card-2', 'deny');
    expect(transport.sendToDevice).toHaveBeenCalledWith('device', expect.objectContaining({ action: 'deny' }));
  });

  it('does not create a live card when completion overtakes the ownership lookup', async () => {
    let authorize!: (allowed: boolean) => void;
    transport.ownsDevice.mockReturnValue(new Promise(resolve => { authorize = resolve; }));
    const creating = cards.receive(request(), 'device', () => true);
    await cards.resolve({ type: 'approval_resolved', messageId: 'approval-1', openId: 'owner', threadId: 'thread-2', status: 'expired', timestamp: 2 }, 'device');
    authorize(true);
    await creating;
    expect(transport.create).not.toHaveBeenCalled();
  });

  it('allows retry after send failure, acknowledgement timeout, or a rejected directory save', async () => {
    await cards.receive(request(), 'device', () => true);
    transport.sendToDevice.mockResolvedValueOnce(false);
    await expect(cards.click('owner', 'approval-1', 'card-1', 'approve')).rejects.toThrow('offline');
    await cards.click('owner', 'approval-1', 'card-1', 'remember');
    await vi.advanceTimersByTimeAsync(30001);
    expect(JSON.stringify(transport.update.mock.calls.at(-1))).toContain('No CLI confirmation');
    await cards.click('owner', 'approval-1', 'card-1', 'remember');
    await cards.resolve({ type: 'approval_resolved', messageId: 'approval-1', openId: 'owner', threadId: 'thread-2', status: 'pending', error: 'Save failed', timestamp: 2 }, 'device');
    expect(transport.update.mock.calls.at(-1)![1].filter((element: any) => element.tag === 'button')).toHaveLength(3);
    await cards.click('owner', 'approval-1', 'card-1', 'deny');
    expect(transport.sendToDevice).toHaveBeenCalledTimes(4);
  });

  it('falls back when cards cannot be delivered and ignores foreign or stale connections', async () => {
    await cards.receive(request(), 'device', () => false);
    transport.ownsDevice.mockResolvedValueOnce(false);
    await cards.receive(request(), 'device', () => true);
    expect(transport.create).not.toHaveBeenCalled();
    transport.create.mockResolvedValue(null);
    await cards.receive(request(), 'device', () => true);
    expect(transport.sendToDevice).toHaveBeenCalledWith('device', expect.objectContaining({ type: 'approval_unavailable', messageId: 'approval-1' }));
    transport.create.mockClear();
    const oversized = request();
    oversized.approval.description = 'x'.repeat(16001);
    await cards.receive(oversized, 'device', () => true);
    expect(transport.create).not.toHaveBeenCalled();
    expect(transport.sendToDevice).toHaveBeenCalledTimes(2);
  });
});

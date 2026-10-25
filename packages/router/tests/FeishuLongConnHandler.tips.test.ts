import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as lark from '@larksuiteoapi/node-sdk';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';

vi.mock('@larksuiteoapi/node-sdk');
vi.mock('../src/binding/BindingManager');

describe('passive Tips transport and routing', () => {
  let handler: FeishuLongConnHandler;
  let create: ReturnType<typeof vi.fn>;
  let patch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    create = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'tip-card' } });
    patch = vi.fn().mockResolvedValue({ code: 0 });
    vi.mocked(lark.Client).mockImplementation(() => ({ im: { message: { create, patch } } }) as any);
    handler = new FeishuLongConnHandler({ appId: 'fixture', appSecret: 'fixture', store: {} as any });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends one standalone card with an idempotency key and no task route', async () => {
    const elements = [{ tag: 'markdown', content: '/backend' }];
    const header = { title: { tag: 'plain_text', content: 'Tip' } };
    expect(await handler.sendTipCard('owner', elements, header, 'delivery-id')).toBe('tip-card');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ params: { receive_id_type: 'open_id' }, data: {
      receive_id: 'owner', msg_type: 'interactive', uuid: 'delivery-id',
      content: JSON.stringify({ schema: '2.0', header, body: { elements } }),
    } });
    expect((handler as any).messageChains.size).toBe(0);
  });

  it('does not retry, fall back to text, or report success without acknowledgement', async () => {
    create.mockRejectedValueOnce(new Error('transport unavailable'));
    await expect(handler.sendTipCard('owner', [], {}, 'one')).rejects.toThrow('transport unavailable');
    expect(create).toHaveBeenCalledTimes(1);
    create.mockResolvedValueOnce({ code: 42, data: { message_id: 'rejected' } });
    expect(await handler.sendTipCard('owner', [], {}, 'two')).toBeNull();
    create.mockResolvedValueOnce({ code: 0, data: {} });
    expect(await handler.sendTipCard('owner', [], {}, 'three')).toBeNull();
  });

  it('accepts only acknowledged card updates and propagates resolved API rejections', async () => {
    await handler.updateTipCard('card', [], {});
    expect(patch).toHaveBeenCalledWith({ path: { message_id: 'card' },
      data: { content: JSON.stringify({ schema: '2.0', header: {}, body: { elements: [] } }) } });
    patch.mockResolvedValueOnce({ code: 230099 });
    await expect(handler.updateTipCard('card', [], {})).rejects.toThrow('Could not update tip card.');
    patch.mockResolvedValueOnce(undefined);
    await expect(handler.updateTipCard('card', [], {})).rejects.toThrow('Could not update tip card.');
    expect(patch).toHaveBeenCalledTimes(3);
  });

  it('intercepts Tips commands without sending them to the CLI', async () => {
    handler.onTipsCommand = vi.fn().mockResolvedValue(undefined);
    const passthrough = vi.spyOn(handler as any, 'handleSlashCommandPassthrough');
    await (handler as any).handleCommand('owner', 'message', '/tips mute 7');
    expect(handler.onTipsCommand).toHaveBeenCalledWith('owner', '/tips mute 7');
    expect(passthrough).not.toHaveBeenCalled();
  });

  it('handles unavailable Tips locally', async () => {
    const reply = vi.spyOn(handler as any, 'replyToMessage').mockResolvedValue(undefined);
    await (handler as any).handleCommand('owner', 'message', '/tips');
    expect(reply).toHaveBeenCalledWith('message', expect.stringContaining('not available'));
  });

  it('passes the original user, message and payload only to the Tips controller', async () => {
    handler.onTipsAction = vi.fn().mockResolvedValue('Saved');
    handler.onUserActivity = vi.fn().mockResolvedValue(undefined);
    const send = vi.spyOn(handler as any, 'sendCommandFromCardAction');
    const value = { action: 'tips', id: 'nonce', op: 'next', value: '/clear' };
    expect(await handler.handleCardAction({ operator: { open_id: 'owner' }, action: { value },
      context: { open_message_id: 'tip-card' } })).toEqual({ toast: { type: 'info', content: 'Saved' } });
    expect(handler.onTipsAction).toHaveBeenCalledWith('owner', 'tip-card', value);
    expect(handler.onUserActivity).toHaveBeenCalledWith('owner');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects malformed or unavailable controls and contains controller errors', async () => {
    for (const value of ['null', 'broken']) {
      expect(await handler.handleCardAction({ operator: { open_id: 'owner' }, action: { value } })).toBeUndefined();
    }
    const data = { operator: { open_id: 'owner' }, action: { value: { action: 'tips' } }, context: { open_message_id: 'card' } };
    expect(await handler.handleCardAction(data)).toMatchObject({ toast: { type: 'error' } });
    handler.onTipsAction = vi.fn().mockRejectedValue(new Error('private detail'));
    const result = await handler.handleCardAction(data);
    expect(result).toMatchObject({ toast: { type: 'error' } });
    expect(JSON.stringify(result)).not.toContain('private detail');
  });

  it('contains activity errors without blocking card controls', async () => {
    handler.onUserActivity = vi.fn().mockRejectedValue(new Error('storage failed'));
    handler.onTipsAction = vi.fn().mockResolvedValue('Saved');
    await handler.handleCardAction({ operator: { open_id: 'owner' }, action: { value: { action: 'tips' } },
      context: { open_message_id: 'card' } });
    expect(handler.onTipsAction).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(console.error).toHaveBeenCalledWith('[Tips] Could not record user activity.');
    handler.onUserActivity = () => { throw new Error('sync failure'); };
    expect(() => (handler as any).recordUserActivity('owner')).not.toThrow();
  });
});

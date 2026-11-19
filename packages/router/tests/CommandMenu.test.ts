import { describe, expect, it, vi } from 'vitest';
import { CommandMenu } from '../src/feishu/CommandMenu';

function fixture() {
  const menu = new CommandMenu('Test device / project');
  const update = vi.fn(async (_elements: any[]) => {});
  const run = vi.fn(async (_command: string) => {});
  const click = (rev: number, op: string, value?: string, form?: unknown) => menu.click({ rev, op, value }, form, update, run);
  return { menu, click, update, run };
}

describe('Feishu command menu', () => {
  it('opens the same list again on the displayed revision and coalesces overlapping reads', async () => {
    const { menu, click, update } = fixture();
    await click(0, 'choose', '/schedule');
    let finish!: () => void;
    let started!: () => void;
    const opening = new Promise<void>(resolve => { started = resolve; });
    const execute = vi.fn(async () => {
      started();
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const button = { rev: 1, op: 'choose', value: '/schedule list' };
    const first = menu.click(button, undefined, update, execute);
    await opening;
    await expect(menu.click(button, undefined, update, execute)).resolves.toContain('already opening');
    finish();
    await first;
    execute.mockResolvedValueOnce(undefined);
    await menu.click(button, undefined, update, execute);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('accepts a newly displayed button before the first patch acknowledgement or command finishes', async () => {
    const { menu, update } = fixture();
    let acknowledge!: () => void;
    let displayed!: () => void;
    const visible = new Promise<void>(resolve => { displayed = resolve; });
    update.mockImplementationOnce(async () => {
      displayed();
      await new Promise<void>(resolve => { acknowledge = resolve; });
    });
    let finish!: () => void;
    const run = vi.fn(async () => new Promise<void>(resolve => { finish = resolve; }));
    const model = menu.click({ rev: 0, op: 'choose', value: '/model' }, undefined, update, run);
    await visible;
    const navigate = menu.click({ rev: 1, op: 'choose', value: '/schedule' }, undefined, update, run);
    acknowledge();
    await navigate;
    expect(JSON.stringify(menu.render())).toContain('list · Scheduled tasks');
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await model;
  });

  it('selects a bound device by its displayed name and resolves its original ID', async () => {
    const menu = new CommandMenu('Desktop', [{ deviceName: 'Laptop', deviceId: '2-original' }]);
    const run = vi.fn(async (_cmd: string) => {});
    const click = (rev: number, op: string, value?: string, form?: unknown) => menu.click({ rev, op, value }, form, async () => {}, run);
    await click(0, 'group', 'Devices');
    await click(1, 'choose', '/device');
    await click(2, 'choose', '/device switch');
    const picker = menu.render().find(element => element.tag === 'form').elements[0];
    expect(picker).toMatchObject({ tag: 'select_static', options: [{ text: { content: 'Laptop (1)' }, value: '0' }] });
    await expect(click(3, 'run', undefined, { argument: '2-other' })).rejects.toThrow();
    await click(3, 'run', undefined, { argument: '0' });
    expect(run.mock.calls).toEqual([['/device switch 2-original']]);
  });

  it('browses workspace sessions, worker resets and tips through separate feature groups', async () => {
    const { click, run } = fixture();
    await click(0, 'group', 'Workspace');
    await click(1, 'choose', '/resume');
    await click(2, 'choose', '/resume search');
    await click(3, 'run', undefined, { argument: 'token', selection: 'project notes' });
    await click(4, 'back');
    await click(5, 'back');
    await click(6, 'group', 'Settings');
    await click(7, 'choose', '/delegation');
    await click(8, 'choose', '/delegation reset');
    await click(9, 'choose', '/delegation reset codex');
    await click(10, 'run');
    await click(11, 'back');
    await click(12, 'back');
    await click(13, 'back');
    await click(14, 'group', 'Help and tips');
    await click(15, 'choose', '/tips');
    await click(16, 'choose', '/tips list');
    expect(run.mock.calls).toEqual([['/resume search token project notes'], ['/delegation reset codex'], ['/tips list']]);
  });

  it('opens the schedule shortcut, lists only on selection, and navigates legacy cleanup one level at a time', async () => {
    const { menu, click, run } = fixture();
    await expect(click(0, 'choose', '/schedule list')).rejects.toThrow();
    await click(0, 'choose', '/schedule');
    expect(JSON.stringify(menu.render())).toContain('list · Scheduled tasks');
    await expect(click(1, 'choose', '/schedule cleanup confirm')).rejects.toThrow();
    await click(1, 'choose', '/schedule cleanup');
    await click(2, 'choose', '/schedule cleanup confirm');
    await click(3, 'back');
    expect(JSON.stringify(menu.render())).toContain('review · Review legacy schedules');
    expect(run).not.toHaveBeenCalled();
    await click(4, 'choose', '/schedule cleanup review');
    await click(5, 'back');
    await click(6, 'choose', '/schedule list');
    await click(6, 'back');
    expect(JSON.stringify(menu.render())).toContain('Quick access');
    expect(run.mock.calls).toEqual([['/schedule cleanup review'], ['/schedule list']]);
  });

  it.each([
    ['Devices', '/device', '/device list'],
    ['Conversation', '/queue', '/queue'],
    ['Workspace', '/files', '/files'],
    ['Workspace', '/thread', '/thread list'],
    ['Conversation', '/goal', '/goal status'],
  ])('keeps %s navigation local until a leaf is selected', async (group, parent, leaf) => {
    const { menu, click, run, update } = fixture();
    await click(0, 'group', group);
    update.mockRejectedValueOnce(new Error('patch failed'));
    await expect(click(1, 'choose', parent)).rejects.toThrow();
    await click(1, 'choose', parent);
    expect(run).not.toHaveBeenCalled();
    await click(2, 'choose', leaf);
    await click(['/queue', '/files', '/device list'].includes(leaf) ? 2 : 3, 'back');
    expect(JSON.stringify(menu.render())).toContain('**' + group + '**');
    expect(run.mock.calls).toEqual([[leaf]]);
  });

  it('submits reviewed cleanup only from its confirmation form with all three fields', async () => {
    const { menu, click, run } = fixture();
    await click(0, 'choose', '/schedule');
    await click(1, 'choose', '/schedule cleanup');
    await click(2, 'choose', '/schedule cleanup confirm');
    const fields = menu.render().find(element => element.tag === 'form').elements;
    expect(fields.filter((field: any) => field.tag === 'input').map((field: any) => field.name))
      .toEqual(['argument', 'request_id', 'native_ids']);
    const form = { argument: 'token', request_id: 'request', native_ids: 'first,second' };
    await expect(click(3, 'run', undefined, { ...form, native_ids: '' })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    await click(3, 'run', undefined, form);
    expect(run.mock.calls).toEqual([['/schedule cleanup confirm token request first,second']]);
  });

  it('opens a shortcut once and ignores replay and forged choices', async () => {
    const { menu, click, run } = fixture();
    expect(JSON.stringify(menu.render())).toContain('Schedules');
    await expect(click(0, 'choose', '/unbind')).rejects.toThrow();
    await expect(click(0, 'group', '__proto__')).rejects.toThrow();
    await click(0, 'choose', '/model');
    await expect(click(0, 'choose', '/model')).resolves.toContain('refreshed');
    expect(run.mock.calls).toEqual([['/model']]);
  });

  it.each([
    ['/schedule after', '5m', '/schedule after 5m -- Run tests'],
    ['/schedule at', '2099-02-02T09:00:00Z', '/schedule at 2099-02-02T09:00:00Z -- Run tests'],
    ['/schedule cron', '0 9 * * 1-5', '/schedule cron "0 9 * * 1-5" --tz Asia/Shanghai -- Run tests'],
  ])('builds %s from separate fields and consumes the submit once', async (command, argument, result) => {
    const { menu, click, run } = fixture();
    await click(0, 'group', 'Schedules');
    await click(1, 'choose', command);
    const form = menu.render().find(element => element.tag === 'form');
    expect(form.elements.at(-1)).toMatchObject({ form_action_type: 'submit', name: 'submit' });
    expect(run).not.toHaveBeenCalled();
    await expect(click(2, 'run', undefined, { argument })).rejects.toThrow();
    await click(2, 'run', undefined, { argument, timezone: 'Asia/Shanghai', prompt: 'Run tests' });
    await expect(click(2, 'run')).resolves.toContain('refreshed');
    expect(run.mock.calls).toEqual([[result]]);
  });

  it('allows backing out of a destructive command, and retries a failed card patch without executing', async () => {
    const { menu, click, run, update } = fixture();
    await click(0, 'group', 'Conversation');
    await click(1, 'choose', '/clear');
    expect(JSON.stringify(menu.render())).toContain('local schedules');
    await click(2, 'back');
    await click(3, 'choose', '/clear');
    update.mockRejectedValueOnce(new Error('offline'));
    await expect(click(4, 'run')).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    await click(4, 'run');
    expect(run.mock.calls).toEqual([['/clear']]);
  });
});

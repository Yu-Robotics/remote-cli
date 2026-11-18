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
  it('opens a shortcut once and ignores replay and forged choices', async () => {
    const { menu, click, run } = fixture();
    expect(JSON.stringify(menu.render())).toContain('Schedules');
    await expect(click(0, 'choose', '/unbind')).rejects.toThrow();
    await expect(click(0, 'group', '__proto__')).rejects.toThrow();
    await click(0, 'choose', '/model');
    await expect(click(0, 'choose', '/model')).rejects.toThrow();
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
    await expect(click(2, 'run')).rejects.toThrow();
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

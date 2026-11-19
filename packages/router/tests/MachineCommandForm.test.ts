import { describe, expect, it, vi } from 'vitest';
import { CommandMenu } from '../src/feishu/CommandMenu';

async function open(command: string) {
  const menu = new CommandMenu('Fixture machine');
  const execute = vi.fn(async (_command: string) => {});
  const update = async () => {};
  let rev = 0;
  await menu.click({ rev: rev++, op: 'group', value: 'Machines' }, {}, update, execute);
  if (command.includes(' ')) {
    await menu.click({ rev: rev++, op: 'choose', value: command.split(' ')[0] }, {}, update, execute);
  }
  await menu.click({ rev: rev++, op: 'choose', value: command }, {}, update, execute);
  const elements = menu.render().find(element => element.tag === 'form').elements;
  expect(execute).not.toHaveBeenCalled();
  return { elements, execute, submit: (form: unknown) => menu.click({ rev, op: 'run' }, form, update, execute) };
}

describe('Machine command forms', () => {
  it.each([
    ['/machine add', { machine: 'dev', user: 'builder' }, '/machine add dev builder'],
    ['/machine add', { machine: 'dev', user: 'builder', ssh_port: '2222' }, '/machine add dev builder --port 2222'],
    ['/view', { machine: 'dev', file: 'notes.txt', lines: '', container: '' }, '/view dev notes.txt'],
    ['/view', { machine: 'dev', file: 'notes.txt', target: 'host', lines: '500' }, '/view dev notes.txt --host --lines 500'],
    ['/search', { machine: 'dev', search_path: '.', pattern: '*.ts', target: 'container', container: 'build' }, '/search dev . *.ts --container build'],
    ['/replace', { machine: 'dev', file: 'notes.txt', target: 'host' }, '/replace dev notes.txt --host'],
    ['/backups', { machine: 'dev' }, '/backups dev'],
    ['/backups', { machine: 'dev', filter_path: 'notes.txt' }, '/backups dev notes.txt'],
    ['/restore', { machine: 'dev', backup: 'old.txt', destination: 'notes.txt', container: 'build' }, '/restore dev old.txt notes.txt --container build'],
  ] as const)('dispatches the submitted arguments for %s', async (command, values, expected) => {
    const { execute, submit, elements } = await open(command);
    for (const key of Object.keys(values)) expect(elements).toContainEqual(expect.objectContaining({ name: key }));
    expect(elements.map((e: any) => e.name)).not.toContain('password');
    await submit({ ...values, password: 'ignored' });
    await expect(submit(values)).resolves.toContain('refreshed');
    expect(execute.mock.calls).toEqual([[expected]]);
  });

  it.each([
    ['/machine add', { machine: 'dev', user: 'builder hidden' }],
    ['/machine add', { machine: 'dev', user: 'builder', ssh_port: '65536' }],
    ['/search', { machine: 'dev', search_path: '.', pattern: '*.ts --host' }],
    ['/view', { machine: 'dev', file: '--host' }],
    ['/view', { machine: 'dev', file: 'notes.txt', lines: '501' }],
    ['/view', { machine: 'dev', file: 'notes.txt', target: 'host', container: 'custom' }],
    ['/view', { machine: 'dev', file: 'notes.txt', target: 'other' }],
    ['/replace', { machine: 'dev', file: 'notes.txt', container: '--host' }],
    ['/restore', { machine: 'dev', backup: 'old.txt', destination: 'out\n--host' }],
  ] as const)('rejects invalid or ambiguous fields for %s before dispatch', async (command, values) => {
    const { execute, submit } = await open(command);
    await expect(submit(values)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});

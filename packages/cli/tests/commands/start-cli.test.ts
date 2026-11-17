import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { startCommand } from '../../src/commands/start';

vi.mock('../../src/commands/init', () => ({ initCommand: vi.fn() }));
vi.mock('../../src/commands/start', () => ({ startCommand: vi.fn() }));
vi.mock('../../src/commands/stop', () => ({ stopCommand: vi.fn() }));
vi.mock('../../src/commands/status', () => ({ statusCommand: vi.fn() }));
vi.mock('../../src/commands/config', () => ({ configCommand: vi.fn() }));
vi.mock('../../src/commands/service', () => ({ serviceCommand: vi.fn() }));
vi.mock('../../src/commands/files', () => ({ enableFiles: vi.fn() }));
vi.mock('../../src/commands/session', () => ({ sessionShowCommand: vi.fn() }));
vi.mock('../../src/commands/delegationStorage', () => ({ registerDelegationStorage: vi.fn() }));
vi.mock('../../src/utils/ProcessShutdown', () => ({ ProcessShutdown: vi.fn(() => ({
  attach: vi.fn(() => true), finishStartup: vi.fn(), isStopping: false, dispose: vi.fn(),
})) }));

let program: Command;
beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(Command.prototype, 'parse').mockImplementation(function (this: Command) { program = this; return this; });
  await import('../../src/index');
  program.commands.find(command => command.name() === 'start')!
    .exitOverride().configureOutput({ writeErr: vi.fn() });
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it.each([['--retained-host', 'legacy.json'], ['--retained-host=legacy.json']])(
  'rejects removed launch arguments %j before startup', async (...flags) => {
    await expect(program.parseAsync(['start', ...flags], { from: 'user' }))
      .rejects.toMatchObject({ code: 'commander.unknownOption' });
    expect(startCommand).not.toHaveBeenCalled();
    expect(program.commands.find(command => command.name() === 'start')!.helpInformation()).not.toContain('retained-host');
  });

it('keeps ordinary supervised start flags and shutdown wiring', async () => {
  vi.mocked(startCommand).mockResolvedValue({ success: true, daemonMode: true });
  await program.parseAsync(['start', '--daemon', '--non-interactive'], { from: 'user' });
  expect(startCommand).toHaveBeenCalledWith({ daemon: true, nonInteractive: true, onShutdownReady: expect.any(Function) });
});

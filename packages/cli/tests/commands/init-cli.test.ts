import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { initCommand } from '../../src/commands/init';

// Exercise argument parsing and presentation without invoking other CLI commands.
vi.mock('../../src/commands/init', () => ({ initCommand: vi.fn() }));
vi.mock('../../src/commands/start', () => ({ startCommand: vi.fn() }));
vi.mock('../../src/commands/stop', () => ({ stopCommand: vi.fn() }));
vi.mock('../../src/commands/status', () => ({ statusCommand: vi.fn() }));
vi.mock('../../src/commands/config', () => ({ configCommand: vi.fn() }));
vi.mock('../../src/commands/service', () => ({ serviceCommand: vi.fn() }));
vi.mock('../../src/commands/files', () => ({ enableFiles: vi.fn() }));
vi.mock('../../src/commands/session', () => ({ sessionShowCommand: vi.fn() }));
vi.mock('../../src/commands/delegationStorage', () => ({ registerDelegationStorage: vi.fn() }));

let program: Command;
beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(Command.prototype, 'parse').mockImplementation(function (this: Command) { program = this; return this; });
  await import('../../src/index');
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it('passes --with-files and --force through and prints approval before startup', async () => {
  vi.mocked(initCommand).mockResolvedValue({ success: true, bindingCode: 'ABC-123-XYZ',
    deviceId: 'synthetic-device', keyEnrollmentRequested: true });
  await program.parseAsync(['init', '--server', 'https://router.example.com', '--with-files', '--force'], { from: 'user' });
  expect(initCommand).toHaveBeenCalledWith(expect.objectContaining({
    serverUrl: 'https://router.example.com', withFiles: true, force: true,
  }));
  const output = vi.mocked(console.log).mock.calls.map(args => args.join(' ')).join('\n');
  expect(output).toContain('Key enrollment requested');
  expect(output).toContain('files are not authorized until Feishu approval');
  expect(output).toContain('/bind ABC-123-XYZ');
  expect(output).toContain('remote-cli start');
  expect(output.indexOf('/bind ABC-123-XYZ')).toBeLessThan(output.indexOf('remote-cli start'));
  expect(output).not.toContain('files enable');
});

it('keeps legacy init opt-in and does not claim key enrollment', async () => {
  vi.mocked(initCommand).mockResolvedValue({ success: true, bindingCode: 'ABC-123-XYZ', deviceId: 'synthetic-device' });
  await program.parseAsync(['init', '--server', 'http://router.example.com'], { from: 'user' });
  expect(initCommand).toHaveBeenCalledWith(expect.objectContaining({ withFiles: undefined }));
  const output = vi.mocked(console.log).mock.calls.map(args => args.join(' ')).join('\n');
  expect(output).toContain('Initialization successful');
  expect(output).not.toContain('Key enrollment');
});

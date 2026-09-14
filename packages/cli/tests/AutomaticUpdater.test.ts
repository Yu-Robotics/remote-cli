import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { execFile } from 'child_process';
import { AutomaticUpdater, installGlobalCliVersion, type UpdateReadiness } from '../src/update/AutomaticUpdater';

vi.mock('axios');
vi.mock('child_process', () => ({ execFile: vi.fn() }));

describe('AutomaticUpdater', () => {
  let readiness: UpdateReadiness;
  let installVersion: ReturnType<typeof vi.fn>;
  let beforeRestart: ReturnType<typeof vi.fn>;
  let exitProcess: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    readiness = {
      tryBeginAutomaticUpdate: vi.fn().mockReturnValue(true),
      endAutomaticUpdate: vi.fn(),
    };
    installVersion = vi.fn().mockResolvedValue(undefined);
    beforeRestart = vi.fn().mockResolvedValue(undefined);
    exitProcess = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createUpdater(overrides: Record<string, unknown> = {}) {
    return new AutomaticUpdater('1.6.25', readiness, {
      installVersion,
      beforeRestart,
      exitProcess,
      retryDelayMs: 10,
      failureRetryDelayMs: 20,
      ...overrides,
    });
  }

  it('installs the exact newer Router version and exits after cleanup', async () => {
    const updater = createUpdater();

    await updater.handleRouterVersion('1.6.26');

    expect(installVersion).toHaveBeenCalledWith('1.6.26');
    expect(beforeRestart).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('ignores equal, older, and invalid Router versions', async () => {
    const updater = createUpdater();

    await updater.handleRouterVersion('1.6.25');
    await updater.handleRouterVersion('1.6.24');
    await updater.handleRouterVersion('latest;exit 1');

    expect(installVersion).not.toHaveBeenCalled();
  });

  it('waits until active work and queues are idle', async () => {
    vi.useFakeTimers();
    vi.mocked(readiness.tryBeginAutomaticUpdate)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const updater = createUpdater();

    await updater.handleRouterVersion('1.6.26');
    expect(installVersion).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);

    expect(installVersion).toHaveBeenCalledWith('1.6.26');
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('releases the maintenance lock when installation fails', async () => {
    vi.useFakeTimers();
    installVersion.mockRejectedValue(new Error('registry unavailable'));
    const updater = createUpdater();

    await updater.handleRouterVersion('1.6.26');

    expect(readiness.endAutomaticUpdate).toHaveBeenCalledOnce();
    expect(beforeRestart).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it('retries a failed installation without requiring another reconnect', async () => {
    vi.useFakeTimers();
    installVersion
      .mockRejectedValueOnce(new Error('registry unavailable'))
      .mockResolvedValueOnce(undefined);
    const updater = createUpdater();

    await updater.handleRouterVersion('1.6.26');
    await vi.advanceTimersByTimeAsync(20);

    expect(installVersion).toHaveBeenCalledTimes(2);
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('resolves the package version from the Router after protocol rejection', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { success: true, version: '1.6.26' } });
    const updater = createUpdater();

    await updater.handleProtocolMismatch('https://router.example.com');

    expect(axios.get).toHaveBeenCalledWith('https://router.example.com/api/version', { timeout: 5000 });
    expect(installVersion).toHaveBeenCalledWith('1.6.26');
  });

  it('installs and verifies only the exact validated package version', async () => {
    vi.mocked(execFile)
      .mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: Function) => {
        callback(null, '"1.6.26"\n', '');
      }) as any)
      .mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: Function) => {
        callback(null, '', '');
      }) as any)
      .mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: Function) => {
        callback(null, '1.6.26\n', '');
      }) as any);

    await installGlobalCliVersion('1.6.26', '/opt/remote-cli/bin/remote-cli.js');

    expect(vi.mocked(execFile).mock.calls[0].slice(0, 2)).toEqual([
      'npm',
      ['view', '@yu_robotics/remote-cli@1.6.26', 'version', '--json'],
    ]);
    expect(vi.mocked(execFile).mock.calls[1].slice(0, 2)).toEqual([
      'npm',
      ['install', '-g', '@yu_robotics/remote-cli@1.6.26', '--no-audit', '--no-fund'],
    ]);
    expect(vi.mocked(execFile).mock.calls[2].slice(0, 2)).toEqual([
      process.execPath,
      ['/opt/remote-cli/bin/remote-cli.js', '--version'],
    ]);
  });

  it('rejects unsafe version strings before invoking npm', async () => {
    await expect(installGlobalCliVersion('latest; rm -rf /', '/cli.js')).rejects.toThrow('Invalid Router version');
    expect(execFile).not.toHaveBeenCalled();
  });
});

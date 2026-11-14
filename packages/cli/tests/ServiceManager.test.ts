import { promises as fs } from 'fs';
import { EventEmitter } from 'events';
import { ProcessShutdown } from '../src/utils/ProcessShutdown';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServiceContext, LinuxServiceManager, MacServiceManager, ServiceCommandRunner, ServiceContext } from '../src/service/ServiceManager';
import { getBackendPath } from '../src/utils/BackendEnvironment';

const stopPolicy = 'KillMode=mixed\nKillSignal=15\nFinalKillSignal=9\nSendSIGHUP=no\nSendSIGKILL=yes\nTimeoutStopUSec=1min 30s\nExecStop=\nExecStopPost=\n';

describe('ServiceManager', () => {
  let homeDir: string;

  afterEach(async () => {
    vi.unstubAllEnvs(); vi.restoreAllMocks();
    if (homeDir) await fs.rm(homeDir, { recursive: true, force: true });
  });

  function createContext(): ServiceContext {
    return {
      homeDir,
      nodePath: '/opt/node/bin/node',
      cliEntryPath: '/opt/remote cli/bin/remote-cli.js',
      pathValue: '/opt/node/bin:/opt/remote cli/bin:/usr/bin',
      logDirectory: path.join(homeDir, '.remote-cli', 'logs'),
    };
  }

  it('composes default service PATH with the runtime builder but preserves explicit overrides', () => {
    vi.stubEnv('PATH', '/opt/legacy/bin');
    const input = { homeDir: '/home/example', nodePath: '/opt/node/bin/node', cliEntryPath: '/nonexistent/example-cli.js' };
    expect(getServiceContext(input).pathValue).toBe(getBackendPath(input));
    expect(getServiceContext({ ...input, pathValue: '/opt/explicit bin' }).pathValue).toBe('/opt/explicit bin');
    expect(getServiceContext({ ...input, pathValue: '' }).pathValue).toBe('');
  });

  it('installs and reports a Linux user service', async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-service-linux-'));
    const calls: string[][] = [];
    const runner: ServiceCommandRunner = vi.fn(async (command, args) => {
      calls.push([command, ...args]);
      if (args.includes('show')) {
        return { stdout: stopPolicy + 'ActiveState=active\nUnitFileState=enabled\nMainPID=321\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const manager = new LinuxServiceManager(createContext(), runner);

    const status = await manager.install();
    const unitPath = path.join(homeDir, '.config', 'systemd', 'user', 'remote-cli.service');
    const unit = await fs.readFile(unitPath, 'utf8');

    expect(status).toMatchObject({ platform: 'linux', installed: true, running: true, enabled: true, pid: 321 });
    expect(unit).toContain('KillMode=mixed\nTimeoutStopSec=90s');
    expect(unit).toContain('ExecStart="/opt/node/bin/node" "/opt/remote cli/bin/remote-cli.js" start --non-interactive');
    expect(unit).toContain(`WorkingDirectory=${homeDir.replaceAll('\\', '\\x5c').replaceAll(' ', '\\x20')}`);
    expect(unit).toContain(`Environment="HOME=${homeDir.replaceAll('\\', '\\\\')}"`);
    expect(unit).toContain(`StandardOutput=append:${path.join(homeDir, '.remote-cli', 'logs', 'service.log').replaceAll('\\', '\\x5c').replaceAll(' ', '\\x20')}`);
    expect(calls).toContainEqual(['systemctl', '--user', 'enable', '--now', 'remote-cli']);
  });

  it('escapes Linux unit paths without using shell-style path quotes', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-service-linux-'));
    homeDir = path.join(temporaryRoot, 'home with spaces');
    await fs.mkdir(homeDir);
    const context = createContext();
    context.pathValue = '/opt/node bin:/usr/bin';
    const runner: ServiceCommandRunner = vi.fn(async (_command, args) => {
      if (args.includes('show')) return { stdout: stopPolicy + 'ActiveState=active\nUnitFileState=enabled\nMainPID=321\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const manager = new LinuxServiceManager(context, runner);

    await manager.install();
    const unit = await fs.readFile(path.join(homeDir, '.config', 'systemd', 'user', 'remote-cli.service'), 'utf8');

    expect(unit).toContain(`WorkingDirectory=${homeDir.replaceAll('\\', '\\x5c').replaceAll(' ', '\\x20')}`);
    expect(unit).not.toContain(`WorkingDirectory="${homeDir}"`);
    expect(unit).toContain(`Environment="HOME=${homeDir.replaceAll('\\', '\\\\')}"`);
    expect(unit).toContain('Environment="PATH=/opt/node bin:/usr/bin"');
    expect(unit).toContain(`StandardOutput=append:${path.join(homeDir, '.remote-cli', 'logs', 'service.log').replaceAll('\\', '\\x5c').replaceAll(' ', '\\x20')}`);
  });

  it('uninstalls a Linux service without removing user data', async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-service-linux-'));
    const runner: ServiceCommandRunner = vi.fn(async () => ({ stdout: stopPolicy + 'ActiveState=inactive\nResult=success\n', stderr: '' }));
    const manager = new LinuxServiceManager(createContext(), runner);

    await manager.install();
    await fs.writeFile(path.join(homeDir, '.remote-cli', 'config.json'), '{}');
    const status = await manager.uninstall();

    expect(status.installed).toBe(false);
    await expect(fs.access(path.join(homeDir, '.remote-cli', 'config.json'))).resolves.toBeUndefined();
  });

  it('starts and stops an installed Linux service without changing enablement', async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-service-linux-'));
    let active = false;
    const calls: string[][] = [];
    const runner: ServiceCommandRunner = vi.fn(async (command, args) => {
      calls.push([command, ...args]);
      if (args.includes('start')) active = true;
      if (args.includes('stop')) active = false;
      if (args.includes('show')) {
        return { stdout: stopPolicy + `Result=success\nActiveState=${active ? 'active' : 'inactive'}\nUnitFileState=enabled\nMainPID=${active ? '321' : '0'}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const manager = new LinuxServiceManager(createContext(), runner);

    await manager.install();
    await manager.stop();
    const status = await manager.start();

    expect(calls).toContainEqual(['systemctl', '--user', 'stop', 'remote-cli']);
    expect(calls).toContainEqual(['systemctl', '--user', 'start', 'remote-cli']);
    expect(status).toMatchObject({ running: true, enabled: true, pid: 321 });
  });

  async function linuxFixture() {
    homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'service-ordering-')));
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    let properties = stopPolicy + 'ActiveState=inactive\nResult=success\n';
    const runner = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args.includes('--all') ? properties : properties.replace(/^\w+=\n/gm, ''), stderr: '',
    }));
    const manager = new LinuxServiceManager(createContext(), runner);
    await manager.install(); runner.mockClear();
    const unitPath = path.join(homeDir, '.config', 'systemd', 'user', 'remote-cli.service');
    const unit = await fs.readFile(unitPath, 'utf8');
    return { manager, runner, unitPath, unit, setProperties: (value: string) => { properties = value; } };
  }

  it.each(['start', 'stop', 'install'] as const)('migrates an exact legacy unit before %s without rewriting its captured environment on start/stop', async action => {
    const f = await linuxFixture();
    const legacy = f.unit.replace('KillMode=mixed\nTimeoutStopSec=90s\n', '')
      .replace('Environment="PATH=/opt/node/bin:/opt/remote cli/bin:/usr/bin"', 'Environment="PATH=previous-fixture-path"');
    await fs.writeFile(f.unitPath, legacy);
    await f.manager[action]();
    expect(await fs.readFile(f.unitPath, 'utf8')).toBe(action === 'install' ? f.unit
      : legacy.replace('RestartSec=5\n', 'RestartSec=5\nKillMode=mixed\nTimeoutStopSec=90s\n'));
    const calls = f.runner.mock.calls.map(([, args]) => args);
    expect(calls[0]).toEqual(['--user', 'daemon-reload']);
    expect(calls[1]).toEqual(['--user', 'show', 'remote-cli', '--no-page', '--all']);
    expect(calls[2]).toContain(action === 'install' ? 'enable' : action);
    expect((await fs.readdir(path.dirname(f.unitPath))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not migrate or reload during status inspection', async () => {
    const f = await linuxFixture(); const legacy = f.unit.replace('KillMode=mixed\nTimeoutStopSec=90s\n', '');
    await fs.writeFile(f.unitPath, legacy);
    await f.manager.status();
    expect(await fs.readFile(f.unitPath, 'utf8')).toBe(legacy);
    expect(f.runner.mock.calls.every(([, args]) => args.includes('show'))).toBe(true);
  });

  it.each(['start', 'stop', 'install', 'uninstall'] as const)('preserves a custom unit and refuses %s', async action => {
    const f = await linuxFixture(); const custom = f.unit.replace('Restart=always', 'Restart=on-failure');
    await fs.writeFile(f.unitPath, custom);
    await expect(f.manager[action]()).rejects.toThrow('custom settings');
    expect(await fs.readFile(f.unitPath, 'utf8')).toBe(custom);
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each([
    ['KillMode=mixed', 'KillMode=control-group'], ['KillSignal=15', 'KillSignal=9'],
    ['SendSIGKILL=yes', 'SendSIGKILL=no'], ['FinalKillSignal=9', 'FinalKillSignal=15'],
    ['SendSIGHUP=no', 'SendSIGHUP=yes'], ['TimeoutStopUSec=1min 30s', 'TimeoutStopUSec=infinity'],
    ['TimeoutStopUSec=1min 30s', 'TimeoutStopUSec=0'], ['ExecStop=', 'ExecStop=custom-command'],
    ['ExecStopPost=', 'ExecStopPost=custom-command'],
  ])('refuses an effective override of %s before signalling', async (original, changed) => {
    const f = await linuxFixture(); f.setProperties(stopPolicy.replace(original, changed));
    await expect(f.manager.stop()).rejects.toThrow('Effective systemd shutdown policy');
    expect(f.runner.mock.calls.some(([, args]) => args.includes('stop'))).toBe(false);
  });

  it('refuses an unavailable property response or reload failure without stopping', async () => {
    const f = await linuxFixture(); f.setProperties('');
    await expect(f.manager.stop()).rejects.toThrow('Effective systemd');
    f.runner.mockRejectedValueOnce(new Error('Synthetic reload failure'));
    await expect(f.manager.stop()).rejects.toThrow('reload failure');
    expect(f.runner.mock.calls.some(([, args]) => args.includes('stop'))).toBe(false);
  });

  it('refuses a simulated dangling unit even when access reports it missing', async () => {
    const f = await linuxFixture();
    const access = fs.access.bind(fs);
    vi.spyOn(fs, 'access').mockImplementation(async (...args: Parameters<typeof fs.access>) => {
      if (args[0] === f.unitPath) throw Object.assign(new Error('Synthetic dangling target'), { code: 'ENOENT' });
      return access(...args);
    });
    const stat = await fs.lstat(f.unitPath);
    vi.spyOn(fs, 'lstat').mockResolvedValue(Object.assign(stat, { isFile: () => false, isSymbolicLink: () => true }));
    await expect(f.manager.install()).rejects.toThrow('regular managed file');
    expect(await fs.readFile(f.unitPath, 'utf8')).toBe(f.unit);
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('keeps the legacy unit and removes temporary files when migration cannot replace it', async () => {
    const f = await linuxFixture(); const legacy = f.unit.replace('KillMode=mixed\nTimeoutStopSec=90s\n', '');
    await fs.writeFile(f.unitPath, legacy);
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('Synthetic replacement failure'));
    await expect(f.manager.stop()).rejects.toThrow('replacement failure');
    expect(await fs.readFile(f.unitPath, 'utf8')).toBe(legacy);
    expect((await fs.readdir(path.dirname(f.unitPath))).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('reports supervisor timeout rather than successful stop and preserves the unit on uninstall', async () => {
    const f = await linuxFixture(); f.setProperties(stopPolicy + 'ActiveState=failed\nResult=timeout\n');
    await expect(f.manager.uninstall()).rejects.toThrow('not confirmed successful');
    expect(await fs.readFile(f.unitPath, 'utf8')).toBe(f.unit);
    expect(f.runner.mock.calls.some(([, args]) => args.includes('disable'))).toBe(false);
  });

  it('sends the first stop signal only to the parent and waits for native handoff before parent exit', async () => {
    const f = await linuxFixture();
    // Model the documented systemd signal policy, without starting a real service.
    const parent = Object.assign(new EventEmitter(), { exit: vi.fn() });
    const native = new EventEmitter(); const terminated = vi.fn(); native.on('SIGTERM', terminated);
    const shutdown = new ProcessShutdown(parent, vi.fn());
    const events: string[] = [];
    let finish!: () => void;
    const handoff = new Promise<void>(resolve => { finish = resolve; });
    shutdown.attach(async () => { events.push('handoff'); await handoff; events.push('native-exit'); });
    const original = f.runner.getMockImplementation()!;
    f.runner.mockImplementation(async (command, args) => {
      if (args.includes('stop')) {
        const unit = await fs.readFile(f.unitPath, 'utf8');
        parent.emit('SIGTERM');
        if (!unit.includes('KillMode=mixed\n')) native.emit('SIGTERM');
        await shutdown.stop(); events.push('parent-exit');
      }
      return original(command, args);
    });
    try {
      const stopped = f.manager.stop();
      await vi.waitFor(() => expect(events).toEqual(['handoff']));
      expect(terminated).not.toHaveBeenCalled(); expect(parent.exit).not.toHaveBeenCalled();
      finish(); await stopped;
      expect(events).toEqual(['handoff', 'native-exit', 'parent-exit']);
      expect(parent.exit).toHaveBeenCalledWith(0);
    } finally { finish(); await shutdown.stop(); shutdown.dispose(); }
  });

  it('installs and reads a macOS LaunchAgent status', async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-service-mac-'));
    const runner: ServiceCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === 'print') return { stdout: 'pid = 654\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const manager = new MacServiceManager(createContext(), runner, 501);

    const status = await manager.install();
    const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', 'ai.yu-robotics.remote-cli.plist');
    const plist = await fs.readFile(plistPath, 'utf8');

    expect(status).toMatchObject({ platform: 'darwin', installed: true, running: true, enabled: true, pid: 654 });
    expect(plist).toContain('<string>/opt/remote cli/bin/remote-cli.js</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
  });

  it('does not report a loaded but exited macOS service as running', async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-service-mac-'));
    const runner: ServiceCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === 'print') return { stdout: 'state = exited\nlast exit code = 1\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const manager = new MacServiceManager(createContext(), runner, 501);

    await manager.install();
    const status = await manager.status();

    expect(status).toMatchObject({ installed: true, running: false, enabled: true, detail: 'exited' });
    expect(status.pid).toBeUndefined();
  });
});

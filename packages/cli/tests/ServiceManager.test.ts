import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinuxServiceManager, MacServiceManager, ServiceCommandRunner, ServiceContext } from '../src/service/ServiceManager';

describe('ServiceManager', () => {
  let homeDir: string;

  afterEach(async () => {
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

  it('installs and reports a Linux user service', async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-service-linux-'));
    const calls: string[][] = [];
    const runner: ServiceCommandRunner = vi.fn(async (command, args) => {
      calls.push([command, ...args]);
      if (args.includes('show')) {
        return { stdout: 'ActiveState=active\nUnitFileState=enabled\nMainPID=321\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const manager = new LinuxServiceManager(createContext(), runner);

    const status = await manager.install();
    const unitPath = path.join(homeDir, '.config', 'systemd', 'user', 'remote-cli.service');
    const unit = await fs.readFile(unitPath, 'utf8');

    expect(status).toMatchObject({ platform: 'linux', installed: true, running: true, enabled: true, pid: 321 });
    expect(unit).toContain('ExecStart="/opt/node/bin/node" "/opt/remote cli/bin/remote-cli.js" start --non-interactive');
    expect(unit).toContain('Environment=HOME="');
    expect(unit).toContain(`StandardOutput=append:"${path.join(homeDir, '.remote-cli', 'logs', 'service.log')}"`);
    expect(calls).toContainEqual(['systemctl', '--user', 'enable', '--now', 'remote-cli']);
  });

  it('uninstalls a Linux service without removing user data', async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-service-linux-'));
    const runner: ServiceCommandRunner = vi.fn(async () => ({ stdout: '', stderr: '' }));
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
        return { stdout: `ActiveState=${active ? 'active' : 'inactive'}\nUnitFileState=enabled\nMainPID=${active ? '321' : '0'}\n`, stderr: '' };
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

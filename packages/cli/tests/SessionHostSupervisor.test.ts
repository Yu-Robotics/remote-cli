import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionHostLaunchContext, SessionHostSupervisor } from '../src/service/SessionHostSupervisor';
import { preparePinnedHostBundle, VerifiedHostFile } from '../src/update/PinnedHostBundle';
import { ServiceCommandRunner } from '../src/service/ServiceManager';

const hash = (data: string) => createHash('sha256').update(data).digest('hex');
let root: string;
let context: SessionHostLaunchContext;
async function file(base: string, name: string, data: string, mode = 0o644): Promise<VerifiedHostFile> {
  const target = path.join(base, name);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, data); await fs.chmod(target, mode);
  return { path: name, sha256: hash(data), mode: (await fs.stat(target)).mode & 0o777 };
}
// Manager operations use POSIX permission and fsync semantics. Windows refusal
// and pure renderers have a separate portable suite, without a detached fallback.
beforeEach(async () => {
  if (process.platform === 'win32') return;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'host-supervisor-')));
  const homeDir = path.join(root, 'synthetic home $cash %unit & quotes"');
  await fs.mkdir(homeDir, { mode: 0o700 });
  const pkg = path.join(root, 'package');
  const files = [await file(pkg, 'package.json', '{"name":"synthetic"}'), await file(pkg, 'entry.cjs', 'process.stdin.resume()')];
  const node = await file(root, 'node', '#!/bin/sh\nexit 0\n', 0o755);
  const bundle = await preparePinnedHostBundle({ storeRoot: path.join(root, 'pinned bundles %unit'), package: { root: pkg, files }, dependencies: [],
    entry: 'entry.cjs', node: { path: path.join(root, 'node'), sha256: node.sha256, mode: node.mode } });
  const config = await file(homeDir, 'private/config.json', '{"syntheticCredential":"never-in-service"}', 0o600);
  context = { homeDir, installationId: 'synthetic-installation', bundle, descriptorPath: path.join(homeDir, 'private/config.json'), descriptorSha256: config.sha256 };
});
afterEach(async () => { vi.restoreAllMocks(); if (root) await fs.rm(root, { recursive: true, force: true }); });

function fixture(platform: 'linux' | 'darwin' = 'linux') {
  let state: 'absent' | 'running' | 'stopped' | 'unknown' = 'absent';
  let modifier = (text: string) => text;
  const calls: string[][] = [];
  let manager: SessionHostSupervisor;
  const runner: ServiceCommandRunner = vi.fn(async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('show')) {
      if (state === 'absent') return { stdout: 'LoadState=not-found\n', stderr: '' };
      if (state === 'unknown') throw new Error('Synthetic manager failure');
      return { stdout: modifier(`LoadState=loaded\nActiveState=${state === 'running' ? 'active' : 'inactive'}\nSubState=${state === 'running' ? 'running' : 'dead'}\nMainPID=${state === 'running' ? 456 : 0}\nFragmentPath=${manager.servicePath}\nDropInPaths=\nNeedDaemonReload=no\n`), stderr: '' };
    }
    if (args[0] === 'print') {
      if (state === 'absent') throw Object.assign(new Error('Missing label'), { code: 113, stderr: `Could not find service "${manager.serviceName}" in domain gui: 501` });
      if (state === 'unknown') throw new Error('Synthetic manager failure');
      return { stdout: modifier(`service = {\n path = ${manager.servicePath}\n program = ${context.bundle.nodePath}\n state = ${state === 'running' ? 'running' : 'not running'}\n${state === 'running' ? ' pid = 456\n' : ''}}`), stderr: '' };
    }
    if (args.includes('start') || args[0] === 'kickstart') state = 'running';
    if (args.includes('stop')) state = 'stopped';
    if (args[0] === 'bootout') state = 'absent';
    return { stdout: '', stderr: '' };
  });
  manager = new SessionHostSupervisor(context, { platform, runner, userId: 501 });
  return { manager, runner, calls, setState(value: typeof state) { state = value; }, modify(fn: typeof modifier) { modifier = fn; } };
}

describe.runIf(process.platform !== 'win32')('SessionHostSupervisor POSIX filesystem', () => {
  it.each(['linux', 'darwin'] as const)('launches %s independently, never restarts an active owner, and stops only explicitly', async platform => {
    const f = fixture(platform);
    expect((await f.manager.status()).state).toBe('absent');
    expect(await f.manager.ensureStarted()).toMatchObject({ state: 'running', pid: 456 });
    const service = await fs.readFile(f.manager.servicePath, 'utf8');
    expect(service).not.toMatch(/PartOf=|BindsTo=|remote-cli\.service|never-in-service/);
    expect((await fs.stat(f.manager.bindingPath)).mode & 0o077).toBe(0);
    const operations = f.calls.filter(call => !call.includes('show') && !call.includes('print'));
    expect(await f.manager.ensureStarted()).toMatchObject({ state: 'running' });
    expect(f.calls.filter(call => !call.includes('show') && !call.includes('print'))).toEqual(operations);
    if (platform === 'linux') {
      expect(operations).toEqual([['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'start', f.manager.serviceName]]);
      expect(service).toContain('KillMode=mixed\nTimeoutStopSec=90s'); expect(service).toContain('Restart=no');
      expect(service).toContain('$$cash %%unit'); expect(service).toContain('\\x20'); expect(service).toContain('\\"');
    } else {
      expect(operations).toEqual([['launchctl', 'bootstrap', 'gui/501', f.manager.servicePath], ['launchctl', 'kickstart', `gui/501/${f.manager.serviceName}`]]);
      expect(service).toContain('&amp;'); expect(service).toContain('&quot;'); expect(service).toContain('<key>KeepAlive</key><false/>');
    }
    expect((await f.manager.stop()).state).toBe(platform === 'linux' ? 'stopped' : 'absent');
    const afterStop = f.calls.length;
    await f.manager.stop();
    expect(f.calls.slice(afterStop).every(call => call.includes('show') || call.includes('print'))).toBe(true);
    await expect(f.manager.ensureStarted()).rejects.toThrow('previous');
  });
  it.each(['linux', 'darwin'] as const)('distinguishes unavailable %s manager from absent service', async platform => {
    const f = fixture(platform); f.setState('unknown');
    expect((await f.manager.status()).state).toBe('unknown');
    await expect(f.manager.ensureStarted()).rejects.toThrow('unknown');
    expect(f.calls.every(call => call.includes('show') || call.includes('print'))).toBe(true);
  });
  it('rejects arbitrary same-code launchctl failures as unknown', async () => {
    const runner = vi.fn(async () => { throw Object.assign(new Error('Unavailable domain'), { code: 113, stderr: 'Could not find domain' }); });
    const manager = new SessionHostSupervisor(context, { platform: 'darwin', runner, userId: 501 });
    expect((await manager.status()).state).toBe('unknown');
  });
  it('accepts manager-confirmed Linux absence even with a nonzero show exit', async () => {
    const runner = vi.fn(async () => { throw Object.assign(new Error('Missing'), { stdout: 'LoadState=not-found\n' }); });
    const manager = new SessionHostSupervisor(context, { platform: 'linux', runner });
    expect((await manager.status()).state).toBe('absent');
  });
  it.each(['linux', 'darwin'] as const)('refuses changed configuration or unit while %s owner is live', async platform => {
    const f = fixture(platform); await f.manager.ensureStarted();
    const count = f.calls.length;
    await fs.writeFile(context.descriptorPath, '{}');
    await expect(f.manager.ensureStarted()).rejects.toThrow('descriptor changed');
    expect((await f.manager.status()).state).toBe('unknown');
    expect(f.calls.length).toBe(count);
    await fs.writeFile(context.descriptorPath, '{"syntheticCredential":"never-in-service"}');
    await fs.appendFile(f.manager.servicePath, '\n# custom');
    await expect(f.manager.ensureStarted()).rejects.toThrow('binding');
    await expect(f.manager.stop()).rejects.toThrow('binding');
    expect(f.calls.length).toBe(count);
  });
  it('does not overwrite unknown disk services or adopt unknown manager owners', async () => {
    const f = fixture();
    await fs.mkdir(path.dirname(f.manager.servicePath), { recursive: true });
    await fs.writeFile(f.manager.servicePath, 'unknown');
    expect((await f.manager.status()).state).toBe('unknown');
    await expect(f.manager.ensureStarted()).rejects.toThrow('unknown');
    expect(await fs.readFile(f.manager.servicePath, 'utf8')).toBe('unknown');
    await fs.unlink(f.manager.servicePath); f.setState('running');
    expect((await f.manager.status()).state).toBe('unknown');
    await expect(f.manager.ensureStarted()).rejects.toThrow('unknown');
  });
  it.each(['linux', 'darwin'] as const)('keeps %s launch intent after manager failure and refuses blind retry', async platform => {
    const f = fixture(platform);
    const original = f.runner;
    const failing = vi.fn(async (command: string, args: string[]) => {
      if (args.includes('start') || args[0] === 'bootstrap') throw new Error('Synthetic manager timeout');
      return original(command, args);
    });
    const manager = new SessionHostSupervisor(context, { platform, runner: failing, userId: 501 });
    await expect(manager.ensureStarted()).rejects.toThrow('timeout');
    expect(JSON.parse(await fs.readFile(manager.bindingPath, 'utf8')).installationId).toBe(context.installationId);
    await expect(manager.ensureStarted()).rejects.toThrow('previous');
    expect(failing.mock.calls.filter(([, args]) => args.includes('start') || args[0] === 'bootstrap')).toHaveLength(1);
    f.setState('running'); // A delayed manager response is not a second launch.
    await expect(manager.ensureStarted()).resolves.toMatchObject({ state: 'running' });
  });
  it('serializes concurrent preparations without two manager starts', async () => {
    const f = fixture();
    let entered!: () => void; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const runner: ServiceCommandRunner = async (cmd, args) => {
      if (args.includes('daemon-reload')) { entered(); await gate; }
      return f.runner(cmd, args);
    };
    const manager = new SessionHostSupervisor(context, { platform: 'linux', runner });
    const first = manager.ensureStarted();
    try {
      await ready;
      await expect(manager.ensureStarted()).rejects.toThrow('busy');
    } finally { release(); }
    await first;
    expect(f.calls.filter(call => call.includes('start'))).toHaveLength(1);
  });
  it('retains failed or transitioning launch outcomes rather than reconstructing native work', async () => {
    const f = fixture();
    f.modify(text => text.replace('SubState=running', 'SubState=auto-restart'));
    await expect(f.manager.ensureStarted()).rejects.toThrow('unresolved');
    await expect(f.manager.ensureStarted()).rejects.toThrow('previous');
    await expect(f.manager.stop()).rejects.toThrow('unknown');
    expect(f.calls.filter(call => call.includes('start'))).toHaveLength(1);
  });
  it.each(['DropInPaths=/custom', 'NeedDaemonReload=yes', 'FragmentPath=/custom', 'LoadState=error'])('refuses manager binding mismatch %s', async field => {
    const f = fixture(); await f.manager.ensureStarted();
    f.modify(text => text.replace(new RegExp(`^${field.split('=')[0]}=.*$`, 'm'), field));
    expect((await f.manager.status()).state).toBe('unknown');
    await expect(f.manager.stop()).rejects.toThrow('unknown');
  });
  it('refuses macOS loaded program mismatch and transitioning state', async () => {
    const f = fixture('darwin'); await f.manager.ensureStarted();
    f.modify(text => text.replace('program = ', 'unexpected = '));
    expect((await f.manager.status()).state).toBe('unknown');
    f.modify(text => text.replace('state = running', 'state = waiting'));
    expect((await f.manager.status()).state).toBe('unknown');
  });
  it('rejects nonprivate or symlink descriptors before any manager action', async () => {
    const f = fixture();
    await fs.chmod(context.descriptorPath, 0o644);
    await expect(f.manager.ensureStarted()).rejects.toThrow('private');
    await fs.chmod(context.descriptorPath, 0o600);
    const target = context.descriptorPath + '.original'; await fs.rename(context.descriptorPath, target); await fs.symlink(target, context.descriptorPath);
    await expect(f.manager.ensureStarted()).rejects.toThrow('symlink');
    expect(f.calls).toHaveLength(0);
  });
  it('refuses changed pinned paths, writable descriptor parents, and unsafe service directories', async () => {
    const changed = new SessionHostSupervisor({ ...context, bundle: { ...context.bundle, nodePath: process.execPath } }, { platform: 'linux', runner: vi.fn() });
    await expect(changed.ensureStarted()).rejects.toThrow('paths');
    const f = fixture(); await fs.chmod(path.dirname(context.descriptorPath), 0o755);
    await expect(f.manager.ensureStarted()).rejects.toThrow('directory');
    await fs.chmod(path.dirname(context.descriptorPath), 0o700);
    await fs.mkdir(path.join(context.homeDir, '.remote-cli'), { mode: 0o700 });
    await fs.chmod(path.join(context.homeDir, '.remote-cli'), 0o777);
    await expect(f.manager.ensureStarted()).rejects.toThrow('Unsafe');
    expect(f.calls).toHaveLength(0);
  });
  it('rejects Windows without launching a detached fallback and validates constructor input', () => {
    const runner = vi.fn();
    expect(() => new SessionHostSupervisor(context, { platform: 'win32', runner })).toThrow('unsupported');
    expect(() => new SessionHostSupervisor({ ...context, installationId: '../escape' }, { platform: 'linux' })).toThrow('binding');
    expect(() => new SessionHostSupervisor({ ...context, descriptorPath: 'relative' }, { platform: 'linux' })).toThrow('absolute');
    expect(() => new SessionHostSupervisor({ ...context, descriptorPath: context.descriptorPath + '\n' }, { platform: 'linux' })).toThrow('control');
    expect(() => new SessionHostSupervisor(context, { platform: 'darwin', userId: -1 })).toThrow('user ID');
    expect(() => new SessionHostSupervisor({ ...context, bundle: { ...context.bundle, nodePath: path.join(root, 'bad$dollar', 'node') } }, { platform: 'linux', runner })).toThrow('systemd executable');
    expect(runner).not.toHaveBeenCalled();
  });
  it('does not launch when publishing the durable binding fails', async () => {
    const f = fixture();
    const link = vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('Synthetic disk failure'), { code: 'EIO' }));
    await expect(f.manager.ensureStarted()).rejects.toThrow('disk failure');
    link.mockRestore();
    expect(f.calls.every(call => call.includes('show'))).toBe(true);
    await expect(fs.stat(f.manager.bindingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(path.dirname(f.manager.bindingPath)))).toEqual([]);
  });
  it('retains an incomplete installation receipt if publishing the unit fails', async () => {
    const f = fixture();
    const original = fs.link.bind(fs);
    const link = vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
      if (destination === f.manager.servicePath) throw new Error('Synthetic unit persistence failure');
      return original(source, destination);
    });
    await expect(f.manager.ensureStarted()).rejects.toThrow('persistence failure');
    link.mockRestore();
    await expect(f.manager.ensureStarted()).rejects.toThrow();
    expect(f.calls.filter(call => call.includes('start') || call.includes('daemon-reload'))).toHaveLength(0);
    expect(await fs.readFile(f.manager.bindingPath, 'utf8')).toContain('synthetic-installation');
  });
  it('rejects a descriptor belonging to another installation even when paths are reused', async () => {
    const f = fixture(); await f.manager.ensureStarted();
    const descriptor = '{}'; await fs.writeFile(context.descriptorPath, descriptor);
    const other = new SessionHostSupervisor({ ...context, descriptorSha256: hash(descriptor) }, { platform: 'linux', runner: f.runner });
    await expect(other.ensureStarted()).rejects.toThrow('binding');
    expect(f.calls.filter(call => call.includes('start'))).toHaveLength(1);
  });
  it.runIf(process.platform === 'linux')('passes isolated systemd unit syntax verification without contacting a service manager', async test => {
    const execute = promisify(execFile);
    try { await execute('systemd-analyze', ['--version']); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { test.skip(); return; } throw error; }
    const f = fixture();
    const filename = path.join(root, f.manager.serviceName);
    await fs.writeFile(filename, f.manager.renderService());
    const result = await execute('systemd-analyze', ['verify', filename], {
      env: { PATH: process.env.PATH, HOME: context.homeDir, SYSTEMD_LOG_LEVEL: 'err' },
      timeout: 10_000,
    });
    expect(result.stderr).toBe('');
    expect(f.calls).toEqual([]);
  });

});

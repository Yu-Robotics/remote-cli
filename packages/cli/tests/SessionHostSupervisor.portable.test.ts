import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { SessionHostLaunchContext, SessionHostSupervisor } from '../src/service/SessionHostSupervisor';

// Deliberate POSIX syntax: these are Linux/macOS renderer cases on every runner,
// not host-native fixture paths or permission/supervision acceptance claims.
const root = path.posix.join('/synthetic', 'pinned bundle %unit');
const context: SessionHostLaunchContext = {
  homeDir: '/synthetic/home with $cash & "quotes"', installationId: 'synthetic-installation',
  descriptorPath: '/synthetic/home with $cash & "quotes"/private/config.json', descriptorSha256: 'a'.repeat(64),
  bundle: { digest: 'b'.repeat(64), root, packageRoot: `${root}/package`, assetsRoot: `${root}/package`,
    nodePath: `${root}/runtime/node`, entryPath: `${root}/package/dist/entry.js`, manifestPath: `${root}/manifest.json` },
};
describe('SessionHostSupervisor portable contract', () => {
  it('refuses Windows supervision without touching files or running commands', () => {
    const runner = vi.fn();
    expect(() => new SessionHostSupervisor(context, { platform: 'win32', runner })).toThrow('unsupported');
    expect(runner).not.toHaveBeenCalled();
  });
  it('renders Linux argv and environment without shell interpolation or frontend coupling', () => {
    const text = new SessionHostSupervisor(context, { platform: 'linux', runner: vi.fn() }).renderService();
    expect(text).toContain('$$cash & \\"quotes\\"');
    expect(text).toContain('%%unit');
    expect(text).toContain('KillMode=mixed');
    expect(text).toContain(`Environment="PATH=${root.replaceAll('%', '%%')}/runtime:${root.replaceAll('%', '%%')}/package/node_modules/.bin:`);
    expect(text).not.toMatch(/PartOf=|BindsTo=|Restart=always/);
  });
  it('renders macOS XML escaping without boot-time replay or automatic restart', () => {
    const text = new SessionHostSupervisor(context, { platform: 'darwin', runner: vi.fn(), userId: 501 }).renderService();
    expect(text).toContain('$cash &amp; &quot;quotes&quot;');
    expect(text).toContain('<key>RunAtLoad</key><false/>');
    expect(text).toContain('<key>KeepAlive</key><false/>');
  });
  it('binds an explicit backend PATH while keeping the pinned interpreter first', () => {
    const custom = { ...context, backendSearchPath: '/synthetic/backends:/usr/bin' };
    const text = new SessionHostSupervisor(custom, { platform: 'darwin', runner: vi.fn(), userId: 501 }).renderService();
    expect(text).toContain(`${root}/runtime:${root}/package/node_modules/.bin:/synthetic/backends:/usr/bin`);
    expect(() => new SessionHostSupervisor({ ...context, backendSearchPath: 'relative' }, { platform: 'linux' })).toThrow('absolute POSIX');
    expect(() => new SessionHostSupervisor({ ...context, bundle: { ...context.bundle, root: '/synthetic/colon:root' } }, { platform: 'linux' })).toThrow('PATH separator');
  });

});

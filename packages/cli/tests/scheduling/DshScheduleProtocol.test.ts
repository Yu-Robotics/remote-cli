import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { JsonLines, boundedText, cronSignature, matchesRecord, normalizeRule } from '../../src/scheduling/dsh/protocol';
import { createLaunch } from '../../src/scheduling/dsh/launch';
import { apply as applyBridge, DshScheduleBridge, verifyScope, type DshContext } from '../../src/scheduling/dsh/HostBridge';

import { apply as applyScope } from '../../src/scheduling/dsh/ScopePlugin';

const NOW = Date.parse('2030-01-01T00:00:00Z');
describe('DSH protocol validation', () => {
  it('compares cron field semantics without calculating times or losing DOM/DOW star flags', () => {
    expect(cronSignature('0,15,30,45 * * * 7')).toBe(cronSignature('0-45/15 * * * 0'));
    expect(cronSignature('*/1 * * * *')).toBe(cronSignature('* * * * *'));
    expect(cronSignature('* * 1-31 * 1')).not.toBe(cronSignature('* * * * 1'));
    expect(cronSignature('* * */2 * 1')).not.toBe(cronSignature('* * 1-31/2 * 1'));
  });
  it.each(['* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *',
    '* * * * 8', '1/2 * * * *', '*/0 * * * *', '9-2 * * * *', '@hourly', '0 0 * JAN *', 'L * * * *', '0,,1 * * * *', 'x'.repeat(513)])('rejects unsupported cron %s', value => {
    expect(() => cronSignature(value)).toThrow();
  });
  it('normalizes instants and explicit IANA zones, rejecting expired, local, or offset-zone rules', () => {
    expect(normalizeRule({ kind: 'once', at: '2030-01-02T08:00:00+08:00' }, NOW)).toEqual({ kind: 'once', at: '2030-01-02T00:00:00.000Z' });
    expect(normalizeRule({ kind: 'cron', expression: '  0 0  * * * ', timezone: 'US/Hawaii' }, NOW)).toEqual({ kind: 'cron', expression: '0 0 * * *', timezone: 'Pacific/Honolulu' });
    for (const rule of [{ kind: 'once', at: '2030-01-01T00:00:00Z' }, { kind: 'once', at: '2030-01-02T00:00:00' },
      { kind: 'once', at: '2030-01-02T00:00:00Z', extra: true }, { kind: 'once', at: '2030-02-30T00:00:00Z' },
      { kind: 'once', at: '2030-01-02T24:00:00Z' }, { kind: 'cron', expression: '* * * * *', timezone: '+08:00' }]) {
      expect(() => normalizeRule(rule, NOW)).toThrow();
    }
  });
  it('validates actual native rows, aliases, and mismatching receipts', () => {
    const rule = { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' } as const;
    const row = { id: 'native-id', title: 'synthetic', prompt: 'synthetic', kind: 'cron', scheduledAt: '2030-01-01T00:05:00.000Z', expression: rule.expression, timeZone: 'Etc/UTC' };
    expect(matchesRecord(row, rule, 'synthetic', 'synthetic', 'native-id')).toBe(true);
    for (const extra of [{ id: 'other' }, { title: 'other' }, { prompt: 'other' }, { timeZone: 'invalid' }, { expression: 'invalid' }, { scheduledAt: 'invalid' }, { kind: 'daily' }, { timeZone: undefined }]) {
      expect(matchesRecord({ ...row, ...extra }, rule, 'synthetic', 'synthetic', 'native-id')).toBe(false);
    }
    expect(matchesRecord(null, rule, 'synthetic', 'synthetic')).toBe(false);
    expect(matchesRecord({ ...row, kind: 'at' }, { kind: 'once', at: row.scheduledAt }, 'synthetic', 'synthetic')).toBe(true);
  });
  it('handles UTF-8 chunk boundaries, many frames per chunk, and independently bounds every partial line', () => {
    const frames: unknown[] = [];
    const reader = new JsonLines(frame => frames.push(frame), 32);
    const bytes = Buffer.from('{"value":"\u20ac"}\n');
    reader.read(bytes.subarray(0, 11)); reader.read(bytes.subarray(11));
    reader.read(' \n{}\n{}\n'); expect(frames).toEqual([{ value: '\u20ac' }, {}, {}]);
    expect(() => reader.read('x'.repeat(33))).toThrow(/limit/);
    expect(() => new JsonLines(() => {}).read('null\n')).toThrow();
    expect(() => new JsonLines(() => {}).read('[1]\n')).toThrow();
    expect(boundedText('\u20acx', 2)).toBe(''); expect(boundedText('\u20acx', 3)).toBe('\u20ac'); expect(boundedText('abc', 0)).toBe('');
  });
});

describe('DSH isolated launch scope', () => {
  let root: string;
  beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-launch-test-'))); vi.spyOn(os, 'homedir').mockReturnValue(root); });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
  it('packages an absolute bridge and isolated roots, preserving auth HOME while disabling both telemetry paths', async () => {
    const file = path.join(root, 'bridge.js'); await fs.writeFile(file, 'exports.apply = () => {};');
    const beforeHome = process.env.HOME; const beforeDshHome = process.env.DSH_HOME;
    const launch = await createLaunch(file);
    try {
      const patch = await fs.readFile(launch.args.at(-1)!, 'utf8');
      expect(patch).toContain('session-log-deepseek'); expect(patch).toContain('enabled: false'); expect(patch).toContain('mode: DISABLED');
      expect(patch).toContain(JSON.stringify(path.join(launch.directory, 'storage'))); expect(patch).toContain(JSON.stringify(file));
      expect(launch.env.HOME).toBe(beforeHome); expect(launch.env.DSH_HOME).toBe(beforeDshHome); expect(launch.env.DSH_TELEMETRY_DISABLED).toBe('1');
      const ctx = { sessionPersistence: { root: path.join(launch.directory, 'sessions') }, storage: { backend: { get: () => ({ root: path.join(launch.directory, 'storage') }) } } } as unknown as DshContext;
      await verifyScope(ctx, { directory: launch.directory, scope: launch.scope });
      ctx.provide = vi.fn();
      await applyScope(ctx, { directory: launch.directory, scope: launch.scope });
      expect(ctx.provide).toHaveBeenCalledWith('remoteCliScheduleScope', {});
      await fs.writeFile(path.join(launch.directory, 'storage', 'schedule.json'), '{}');
      await expect(verifyScope(ctx, { directory: launch.directory, scope: launch.scope })).rejects.toThrow(/empty/);
    } finally { await launch.dispose(); }
    await expect(fs.stat(launch.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses mismatching roots, symlink roots, and nonprivate scopes before the scheduler starts', async () => {
    await fs.chmod(root, 0o700); await fs.mkdir(path.join(root, 'sessions')); await fs.mkdir(path.join(root, 'storage'));
    const ctx = { sessionPersistence: { root: path.join(root, 'wrong') }, storage: { backend: { get: () => ({ root: path.join(root, 'storage') }) } } } as unknown as DshContext;
    await expect(verifyScope(ctx, { directory: root, scope: 'scope' })).rejects.toThrow(/routing/);
    ctx.sessionPersistence.root = path.join(root, 'sessions');
    await expect(verifyScope(ctx, { directory: root, scope: '../invalid' })).rejects.toThrow(/Invalid/);
    if (process.platform !== 'win32') {
      await fs.chmod(root, 0o755); await expect(verifyScope(ctx, { directory: root, scope: 'scope' })).rejects.toThrow(/private/); await fs.chmod(root, 0o700);
    }
    await fs.rm(path.join(root, 'sessions'), { recursive: true });
    try { await fs.symlink(path.join(root, 'storage'), path.join(root, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
    await expect(verifyScope(ctx, { directory: root, scope: 'scope' })).rejects.toThrow(/canonical/);
  });
  it('releases ACP only after bridge readiness, and installs owned disposal', async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(DshScheduleBridge.prototype, 'start').mockReturnValue(ready);
    const dispose = vi.spyOn(DshScheduleBridge.prototype, 'dispose').mockResolvedValue();
    let cleanup!: () => unknown;
    const ctx = { provide: vi.fn(), effect: (effect: () => () => unknown) => { cleanup = effect(); } } as unknown as DshContext;
    const applied = applyBridge(ctx, { directory: root, scope: 'scope' });
    expect(ctx.provide).not.toHaveBeenCalled();
    release(); await applied;
    expect(ctx.provide).toHaveBeenCalledWith('remoteCliScheduleReady', {});
    await cleanup(); expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('refuses missing packaged assets and never removes a replaced scope identity', async () => {
    await expect(createLaunch(path.join(root, 'missing.js'))).rejects.toThrow();
    const file = path.join(root, 'bridge.js'); await fs.writeFile(file, 'exports.apply = () => {};');
    const launch = await createLaunch(file);
    const moved = path.join(root, 'moved'); await fs.rename(launch.directory, moved); await fs.mkdir(launch.directory);
    try { await expect(launch.dispose()).rejects.toThrow(/ownership/); }
    finally { await fs.rm(launch.directory, { recursive: true }); }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listPiSessions, piProjectDirectoryName, piSessionHolder, resolvePiSessionDirectory, resolvePiSessionLocator, safeSessionLabel } from '../../src/session/adapters/PiSessionCatalog';
import { catalogTarget, formatCatalog, formatPiCatalog } from '../../src/session/SessionResumeService';

describe('read-only Pi session catalog', () => {
  let home: string;
  let workspace: string;
  let other: string;
  let native: string;
  let remote: string;

  const write = (directory: string, name: string, header: Record<string, unknown>, entries: unknown[] = []) => {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name);
    fs.writeFileSync(file, [{ type: 'session', version: 3, timestamp: '2026-01-01T00:00:00.000Z', ...header }, ...entries]
      .map(entry => JSON.stringify(entry)).join('\n') + '\n');
    return file;
  };
  const message = (role: string) => ({ type: 'message', id: `entry-${role}`, parentId: null, message: { role, content: 'synthetic' } });

  beforeEach(() => {
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-catalog-test-')));
    workspace = path.join(home, 'workspace'); other = path.join(home, 'other');
    fs.mkdirSync(workspace); fs.mkdirSync(other);
    native = path.join(home, '.pi', 'agent', 'sessions', piProjectDirectoryName(workspace));
    remote = path.join(home, '.remote-cli', 'pi-sessions', 'store');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const list = (env: NodeJS.ProcessEnv = {}) => listPiSessions(workspace, { home, env });

  it('uses the custom agent directory for its default session namespace', () => {
    const agent = path.join(home, 'custom-agent');
    write(path.join(agent, 'sessions', piProjectDirectoryName(workspace)), 'custom.jsonl', { id: 'custom-session', cwd: workspace });
    write(native, 'default.jsonl', { id: 'wrong-namespace', cwd: workspace });
    const env = { PI_CODING_AGENT_DIR: agent };
    expect(resolvePiSessionDirectory(workspace, { home, env })).toMatchObject({ source: 'default', directory: path.join(agent, 'sessions', piProjectDirectoryName(workspace)) });
    expect(list(env).candidates.map(candidate => candidate.id)).toEqual(['custom-session']);
  });

  it('does not silently substitute the default store for an unresolved agent directory', () => {
    write(native, 'default.jsonl', { id: 'wrong-namespace', cwd: workspace });
    const result = list({ PI_CODING_AGENT_DIR: './relative-agent' });
    expect(result.complete).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.notes.join(' ')).toContain('could not be resolved');
  });

  it('lists only current-workspace sessions from native and remote-cli stores with safe metadata', () => {
    write(native, 'a.jsonl', { id: 'native-session', cwd: workspace }, [message('user'), message('assistant'),
      { type: 'session_info', name: 'Refactor **auth** `module`' }]);
    write(remote, 'b.jsonl', { id: 'remote-session', cwd: workspace }, [message('user')]);
    write(remote, 'c.jsonl', { id: 'other-project', cwd: other }, [message('user')]);
    const catalog = list();
    expect(catalog.candidates.map(c => c.id).sort()).toEqual(['native-session', 'remote-session']);
    const local = catalog.candidates.find(c => c.id === 'native-session')!;
    expect(local).toMatchObject({ source: 'native-local', messageCount: 2, countComplete: true, name: 'Refactor auth module' });
    expect(JSON.stringify(catalog)).not.toContain('synthetic');
  });

  it('excludes symlinks, malformed files, unsafe IDs and synthetic worker or metadata sessions', () => {
    write(native, 'valid.jsonl', { id: 'valid', cwd: workspace });
    const outside = write(home, 'outside.jsonl', { id: 'outside', cwd: workspace });
    fs.symlinkSync(outside, path.join(native, 'link.jsonl'));
    fs.writeFileSync(path.join(native, 'broken.jsonl'), '{broken\n');
    write(native, 'space.jsonl', { id: 'bad id', cwd: workspace });
    write(native, 'tick.jsonl', { id: 'bad`id', cwd: workspace });
    write(remote, 'lane.jsonl', { id: 'delegate-lane-00000000-0000-0000-0000-000000000000', cwd: workspace });
    write(remote, 'named.jsonl', { id: 'named-worker', cwd: workspace }, [{ type: 'session_info', name: 'remote-cli-settings-meta-x' }]);
    const pointed = write(remote, 'pointed.jsonl', { id: 'ordinary-looking', cwd: workspace });
    fs.writeFileSync(path.join(home, '.remote-cli', 'pi-sessions', 'delegate-lane-x.json'), JSON.stringify({ sessionFile: pointed }));
    expect(list().candidates.map(c => c.id)).toEqual(['valid']);
  });

  it('hides duplicated IDs across stores and reports incomplete coverage', () => {
    write(native, 'one.jsonl', { id: 'duplicate', cwd: workspace });
    write(remote, 'two.jsonl', { id: 'duplicate', cwd: workspace });
    const catalog = list();
    expect(catalog.candidates).toEqual([]);
    expect(catalog.complete).toBe(false);
    expect(catalog.notes.join(' ')).toContain('duplicated');
  });

  it('bounds large files and marks counts as lower bounds without parsing a truncated record', () => {
    write(native, 'large.jsonl', { id: 'large', cwd: workspace }, Array.from({ length: 2000 }, () => message('user')));
    const [item] = list().candidates;
    expect(item).toMatchObject({ id: 'large', countComplete: false });
    expect(item.messageCount).toBeGreaterThan(0);
  });

  it('honors exact session-directory overrides and ignores relative overrides', () => {
    const exact = path.join(home, 'custom-sessions');
    write(exact, 'custom.jsonl', { id: 'custom', cwd: workspace });
    write(native, 'default.jsonl', { id: 'default-store', cwd: workspace });
    expect(list({ PI_CODING_AGENT_SESSION_DIR: exact }).candidates.map(c => c.id)).toEqual(['custom']);
    const relative = list({ PI_CODING_AGENT_SESSION_DIR: 'relative/path' });
    expect(relative.notes.join(' ')).toContain('relative');
    // An unresolvable override must not fall back to a different native namespace.
    expect(relative.candidates.map(c => c.id)).toEqual([]);
    expect(relative.complete).toBe(false);
  });

  it('honors the native settings.json sessionDir and lets project settings override it', () => {
    const agent = path.join(home, '.pi', 'agent');
    const globalDir = path.join(home, 'global-sessions');
    const projectDir = path.join(home, 'project-sessions');
    write(globalDir, 'global.jsonl', { id: 'global-session', cwd: workspace });
    write(projectDir, 'project.jsonl', { id: 'project-session', cwd: workspace });
    write(native, 'default.jsonl', { id: 'default-store', cwd: workspace });
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ sessionDir: globalDir }));
    expect(list().candidates.map(c => c.id)).toEqual(['global-session']);
    expect(resolvePiSessionDirectory(workspace, { home, env: {} })).toMatchObject({ directory: globalDir, source: 'global-setting' });
    fs.mkdirSync(path.join(workspace, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.pi', 'settings.json'), JSON.stringify({ sessionDir: projectDir }));
    expect(list().candidates.map(c => c.id)).toEqual(['project-session']);
    expect(resolvePiSessionDirectory(workspace, { home, env: {} })).toMatchObject({ directory: projectDir, source: 'project-setting' });
  });

  it('ignores unsafe or malformed sessionDir settings and reports the reason', () => {
    const agent = path.join(home, '.pi', 'agent');
    write(native, 'default.jsonl', { id: 'default-store', cwd: workspace });
    for (const value of [42, 'relative/dir']) {
      fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ sessionDir: value }));
      const catalog = list();
      expect(catalog.candidates.map(c => c.id)).toEqual(['default-store']);
      expect(catalog.notes.join(' ')).toMatch(/sessionDir setting/);
    }
    const linked = path.join(home, 'linked-settings.json');
    fs.writeFileSync(linked, JSON.stringify({ sessionDir: path.join(home, 'elsewhere') }));
    fs.rmSync(path.join(agent, 'settings.json')); fs.symlinkSync(linked, path.join(agent, 'settings.json'));
    expect(list().candidates.map(c => c.id)).toEqual(['default-store']);
  });

  it('uses the latest session_info name and rejects relative or future-dated records', () => {
    write(native, 'renamed.jsonl', { id: 'renamed', cwd: workspace },
      [{ type: 'session_info', name: 'Old name' }, { type: 'session_info', name: 'New name' }]);
    write(native, 'relative.jsonl', { id: 'relative-cwd', cwd: 'not-absolute' });
    const future = write(native, 'future.jsonl', { id: 'future-dated', cwd: workspace });
    const when = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    fs.utimesSync(future, when, when);
    expect(list().candidates.map(c => c.id)).toEqual(['renamed']);
    expect(list().candidates[0].name).toBe('New name');
  });

  it('resolves the effective native directory without touching the filesystem', () => {
    const exact = path.join(home, 'override');
    expect(resolvePiSessionDirectory(workspace, { home, env: { PI_CODING_AGENT_SESSION_DIR: exact } }))
      .toEqual({ directory: exact, source: 'env-override', unresolved: false, notes: [] });
    expect(resolvePiSessionDirectory(workspace, { home, env: { PI_CODING_AGENT_SESSION_DIR: 'relative' } }).unresolved).toBe(true);
    expect(resolvePiSessionDirectory(workspace, { home, env: {} }).directory)
      .toBe(path.join(home, '.pi', 'agent', 'sessions', piProjectDirectoryName(workspace)));
    expect(resolvePiSessionDirectory(workspace, { home, env: {} }).source).toBe('default');
  });

  it('bounds the retained candidate count and flags a truncated store', () => {
    for (let i = 0; i < 205; i++) {
      write(native, `rollout-${String(i).padStart(3, '0')}.jsonl`, { id: `s${i}`, cwd: workspace });
    }
    const catalog = list();
    expect(catalog.candidates.length).toBeLessThanOrEqual(200);
    expect(catalog.complete).toBe(false);
    expect(catalog.notes.join(' ')).toContain('could not be fully scanned');
  });

  it('flags an unreadable existing store instead of reporting it empty', () => {
    write(native, 'a.jsonl', { id: 'a', cwd: workspace });
    if (process.getuid && process.getuid() !== 0) {
      fs.chmodSync(native, 0o000);
      try { expect(list()).toMatchObject({ candidates: [], complete: false }); }
      finally { fs.chmodSync(native, 0o700); }
    }
    // A vanished file during the scan is skipped, not surfaced as a candidate.
    const candidateFile = path.join(native, 'a.jsonl');
    const realLstat = fs.lstatSync.bind(fs);
    const lstat = vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === candidateFile) throw Object.assign(new Error('synthetic race'), { code: 'ENOENT' });
      return (realLstat as (...args: unknown[]) => fs.Stats)(target, ...rest);
    }) as typeof fs.lstatSync);
    try {
      expect(list()).toMatchObject({ candidates: [] });
    } finally { lstat.mockRestore(); }
  });

  it('reports an unavailable working directory instead of scanning', () => {
    expect(listPiSessions(path.join(home, 'missing'), { home, env: {} })).toMatchObject({ candidates: [], complete: false });
  });

  it('sanitizes untrusted labels and recognizes only chooser commands', () => {
    expect(safeSessionLabel('[link](x) <b>#title</b>\u0000')).toBe('linkx btitle/b');
    expect(safeSessionLabel('   ')).toBeUndefined();
    expect(safeSessionLabel('x'.repeat(80))).toHaveLength(60);
    expect(catalogTarget('/resume', 'pi')).toBe('pi');
    expect(catalogTarget('/r', 'codex')).toBe('codex');
    expect(catalogTarget('/resume backend pi', 'codex')).toBe('pi');
    expect(catalogTarget('/resume id example', 'pi')).toBeUndefined();
    expect(catalogTarget('/session', 'pi')).toBeUndefined();
  });

  it('formats a bounded read-only list that never claims a connection', () => {
    write(native, 'a.jsonl', { id: 'native-session', cwd: workspace }, [message('user')]);
    const text = formatPiCatalog(list());
    expect(text).toContain('`native-session`');
    expect(text).toContain('not available yet');
    expect(formatPiCatalog({ candidates: [], complete: false, notes: ['example'] })).toContain('Coverage may be incomplete');
    // Markdown renderers join an unseparated trailing line into the last list item.
    const withNote = formatPiCatalog({ ...list(), notes: ['example note'] });
    expect(withNote).toMatch(/UTC\n\nNote: example note/);
    const many = { candidates: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, source: 'remote-cli' as const,
      modifiedAt: 0, messageCount: 1, countComplete: true })), complete: true, notes: [] };
    expect(formatPiCatalog(many)).toContain('2 more not shown');
    // Shared renderer wording for the other implemented backend, without a Pi claim.
    const codex = formatCatalog({ candidates: [{ id: 'c', source: 'native-local', modifiedAt: 0, messageCount: 0, countComplete: false }], complete: true, notes: [] }, 'codex');
    expect(codex).toContain('Codex sessions in this workspace');
    expect(codex).toContain('messages unavailable');
    expect(codex).not.toContain('Pi');
  });

  describe('local locator and holder', () => {
    it('re-resolves a listed session and refuses unknown, synthetic or unreadable IDs', () => {
      const file = write(native, 'a.jsonl', { id: 'native-session', cwd: workspace });
      expect(resolvePiSessionLocator(workspace, 'native-session', { home }))
        .toMatchObject({ id: 'native-session', file: fs.realpathSync.native(file) });
      expect(resolvePiSessionLocator(workspace, 'missing', { home })).toBeUndefined();
      write(native, 'lane.jsonl', { id: 'delegate-lane-1', cwd: workspace });
      expect(resolvePiSessionLocator(workspace, 'delegate-lane-1', { home })).toBeUndefined();
    });

    it('finds the other thread holding a file and survives absent or malformed pointers', () => {
      const file = write(native, 'a.jsonl', { id: 'native-session', cwd: workspace });
      const pointerDir = path.join(home, '.remote-cli', 'pi-sessions');
      fs.mkdirSync(pointerDir, { recursive: true });
      fs.writeFileSync(path.join(pointerDir, 'thread-b.json'), JSON.stringify({ id: 'native-session', sessionFile: file, adopted: true }));
      fs.writeFileSync(path.join(pointerDir, 'thread-c.json'), '{broken');
      fs.writeFileSync(path.join(pointerDir, 'thread-d.json'), JSON.stringify({ id: 'other' }));
      expect(piSessionHolder(file, 'thread-a', { home })).toBe('thread-b');
      expect(piSessionHolder(file, 'thread-b', { home })).toBeUndefined();
      expect(piSessionHolder(path.join(home, 'unrelated.jsonl'), 'thread-a', { home })).toBeUndefined();
      fs.rmSync(pointerDir, { recursive: true, force: true });
      expect(piSessionHolder(file, 'thread-a', { home })).toBeUndefined();
    });
  });
});

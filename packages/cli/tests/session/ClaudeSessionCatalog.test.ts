import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeProjectDirectoryName, listClaudeSessions } from '../../src/session/adapters/ClaudeSessionCatalog';
import { SESSION_CATALOG_READERS, readSessionCatalog } from '../../src/session/adapters';

describe('read-only Claude Code session catalog', () => {
  let home: string;
  let workspace: string;
  let other: string;
  let configDir: string;
  let projectDir: string;

  const line = (record: Record<string, unknown>) => JSON.stringify(record);

  const writeSession = (overrides: Record<string, unknown> = {}, extra: Record<string, unknown>[] = [], name?: string) => {
    fs.mkdirSync(projectDir, { recursive: true });
    const id = typeof overrides.sessionId === 'string' ? overrides.sessionId : 'session-example';
    const records = [
      line({ type: 'mode', sessionId: id, mode: 'default' }),
      line({ type: 'permission-mode', sessionId: id, permissionMode: 'default' }),
      line({ type: 'system', sessionId: id, cwd: workspace, ...overrides }),
      ...extra.map(record => line(record)),
    ];
    const file = path.join(projectDir, name ?? `${id}.jsonl`);
    fs.writeFileSync(file, `${records.join('\n')}\n`);
    return file;
  };

  beforeEach(() => {
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-catalog-test-')));
    workspace = path.join(home, 'workspace');
    other = path.join(home, 'other');
    fs.mkdirSync(workspace);
    fs.mkdirSync(other);
    configDir = path.join(home, '.claude');
    projectDir = path.join(configDir, 'projects', claudeProjectDirectoryName(workspace));
    fs.mkdirSync(projectDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const list = (env: NodeJS.ProcessEnv = {}) => listClaudeSessions(workspace, { home, env });

  it('lists only this workspace via the encoded project directory with the file-stem identity', () => {
    writeSession({}, [{ type: 'last-prompt', sessionId: 'session-example', lastPrompt: 'Fix **auth** `module`' }]);
    writeSession({ sessionId: 'second-session' });
    // Another workspace lives in a different encoded directory and must never leak.
    const otherDir = path.join(configDir, 'projects', claudeProjectDirectoryName(other));
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'other-session.jsonl'),
      [line({ type: 'system', sessionId: 'other-session', cwd: other }), ''].join('\n'));
    const catalog = list();
    expect(catalog.candidates.map(c => c.id).sort()).toEqual(['second-session', 'session-example']);
    expect(catalog.complete).toBe(true);
    const named = catalog.candidates.find(c => c.id === 'session-example')!;
    expect(named.name).toBe('Fix auth module');
    expect(named.countComplete).toBe(false);
    expect(catalog.notes.join(' ')).toContain('message counts are not available');
  });

  it('excludes sidechains, mismatched file stems, synthetic ids and another recorded cwd', () => {
    writeSession();
    writeSession({ sessionId: 'sidechain-session' }, [{ type: 'attachment', sessionId: 'sidechain-session', isSidechain: true, cwd: workspace }]);
    // A file whose name disagrees with its recorded session id is not trustworthy.
    writeSession({ sessionId: 'stem-mismatch' }, [], 'renamed-file.jsonl');
    writeSession({ sessionId: 'remote-cli-delegate-lane-00000000-0000-0000-0000-000000000000' });
    writeSession({ sessionId: 'other-cwd', cwd: other });
    writeSession({ sessionId: 'relative-cwd', cwd: 'not-absolute' });
    const catalog = list();
    expect(catalog.candidates.map(c => c.id)).toEqual(['session-example']);
  });

  it('rejects a transcript that mixes session ids and unparsable lines are skipped', () => {
    fs.writeFileSync(path.join(projectDir, 'mixed.jsonl'), [
      line({ type: 'system', sessionId: 'mixed', cwd: workspace }),
      '{broken',
      line({ type: 'system', sessionId: 'different', cwd: workspace }),
      '',
    ].join('\n'));
    expect(list().candidates).toEqual([]);
    expect(list().complete).toBe(true);
  });

  it('reads only a bounded head and stays safe when cwd is beyond the bound', () => {
    const filler = Array.from({ length: 4000 }, (_, index) => line({ type: 'queue-operation', sessionId: 'hidden-cwd', operation: 'add', content: 'x'.repeat(200), index }));
    fs.writeFileSync(path.join(projectDir, 'hidden-cwd.jsonl'),
      [...filler, line({ type: 'system', sessionId: 'hidden-cwd', cwd: workspace }), ''].join('\n'));
    const catalog = list();
    // The record is larger than the bounded head, so it must not be reported as a verified candidate.
    expect(catalog.candidates).toEqual([]);
    expect(catalog.complete).toBe(true);
  });

  it('honors an exact CLAUDE_CONFIG_DIR and ignores a relative override', () => {
    const exactConfig = path.join(home, 'custom-claude');
    fs.mkdirSync(path.join(exactConfig, 'projects', claudeProjectDirectoryName(workspace)), { recursive: true });
    fs.writeFileSync(path.join(exactConfig, 'projects', claudeProjectDirectoryName(workspace), 'exact.jsonl'),
      [line({ type: 'system', sessionId: 'exact', cwd: workspace }), ''].join('\n'));
    expect(list({ CLAUDE_CONFIG_DIR: exactConfig }).candidates.map(c => c.id)).toEqual(['exact']);
    const relative = list({ CLAUDE_CONFIG_DIR: 'relative/claude' });
    expect(relative.notes.join(' ')).toContain('relative');
    expect(relative.candidates).toEqual([]);
    expect(relative.complete).toBe(false);
  });

  it('refuses symlinked transcripts and reports missing or future-dated records safely', () => {
    const outside = path.join(home, 'outside.jsonl');
    fs.writeFileSync(outside, [line({ type: 'system', sessionId: 'outside', cwd: workspace }), ''].join('\n'));
    fs.symlinkSync(outside, path.join(projectDir, 'link.jsonl'));
    writeSession({ sessionId: 'valid-session' });
    const future = writeSession({ sessionId: 'future-session' });
    const when = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    fs.utimesSync(future, when, when);
    expect(list().candidates.map(c => c.id)).toEqual(['valid-session']);
    expect(listClaudeSessions(path.join(home, 'missing'), { home, env: {} })).toMatchObject({ candidates: [], complete: false });
  });

  it('treats an absent project store as empty rather than a coverage gap', () => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    const catalog = list();
    expect(catalog).toMatchObject({ candidates: [], complete: true });
    expect(catalog.notes.join(' ')).toContain('No Claude Code sessions were found');
  });

  it('registers the reader for the stable claude backend key', () => {
    writeSession();
    expect(SESSION_CATALOG_READERS.claude).toBeTypeOf('function');
    const viaRegistry = readSessionCatalog('claude', workspace, { home, env: {} });
    expect(viaRegistry?.candidates.map(c => c.id)).toEqual(['session-example']);
    expect(readSessionCatalog('agy', workspace, { home, env: {} })).toBeUndefined();
  });

  it('flags an unreadable but existing project store instead of reporting it empty', () => {
    writeSession();
    if (process.getuid && process.getuid() !== 0) {
      fs.chmodSync(projectDir, 0o000);
      try {
        expect(list()).toMatchObject({ candidates: [], complete: false });
        expect(list().notes.join(' ')).toContain('could not be read safely');
      } finally { fs.chmodSync(projectDir, 0o700); }
    }
    // A file that vanishes mid-scan is skipped rather than surfaced.
    const target = path.join(projectDir, 'session-example.jsonl');
    const realLstat = fs.lstatSync.bind(fs);
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      if (String(file) === target) throw Object.assign(new Error('synthetic race'), { code: 'ENOENT' });
      return (realLstat as (...args: unknown[]) => fs.Stats)(file, ...rest);
    }) as typeof fs.lstatSync);
    try { expect(list().candidates).toEqual([]); } finally { spy.mockRestore(); }
  });

  it('bounds the retained count and short-circuits an unavailable workspace', () => {
    for (let i = 0; i < 205; i++) writeSession({ sessionId: `s${String(i).padStart(3, '0')}` });
    const catalog = list();
    expect(catalog.candidates.length).toBeLessThanOrEqual(200);
    expect(catalog.complete).toBe(false);
    expect(listClaudeSessions(path.join(home, 'missing'), { home, env: {} }).notes.join(' ')).toContain('unavailable');
  });
});

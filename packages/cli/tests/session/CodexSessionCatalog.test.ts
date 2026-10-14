import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listCodexSessions } from '../../src/session/adapters/CodexSessionCatalog';

describe('read-only Codex session catalog', () => {
  let home: string;
  let workspace: string;
  let other: string;
  let codexHome: string;
  let active: string;
  let archived: string;

  const meta = (overrides: Record<string, unknown>) => JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z', ordinal: 0, type: 'session_meta',
    payload: { session_id: 'placeholder', id: 'placeholder', cwd: workspace,
      originator: 'codex-tui', source: 'cli', thread_source: 'user', history_mode: 'paginated',
      base_instructions: { x: 'y' }, ...overrides },
  });

  const write = (root: string, day: string, name: string, overrides: Record<string, unknown> = {}, extraLines: string[] = []) => {
    const directory = path.join(root, day);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name);
    fs.writeFileSync(file, [meta(overrides), ...extraLines].join('\n') + '\n');
    return file;
  };

  beforeEach(() => {
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-test-')));
    workspace = path.join(home, 'workspace'); other = path.join(home, 'other');
    fs.mkdirSync(workspace); fs.mkdirSync(other);
    codexHome = path.join(home, '.codex');
    active = path.join(codexHome, 'sessions');
    archived = path.join(codexHome, 'archived_sessions');
    fs.mkdirSync(active, { recursive: true });
    fs.mkdirSync(archived, { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const list = (env: NodeJS.ProcessEnv = {}) => listCodexSessions(workspace, { home, env });

  it('lists only current-workspace foreground sessions from active and archived stores', () => {
    const activeFile = write(active, '2026/01/02', 'rollout-a.jsonl', { id: 'a', session_id: 'a' });
    const archivedFile = write(archived, '', 'rollout-b.jsonl', { id: 'b', session_id: 'b' });
    write(active, '2026/01/04', 'rollout-other.jsonl', { id: 'other-project', session_id: 'other-project', cwd: other });
    fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'),
      `${JSON.stringify({ id: 'a', thread_name: 'Refactor **auth** `module`', updated_at: 1 })}\n`);
    // Two writes can share one filesystem timestamp, so order them explicitly:
    // the catalog must return newest first.
    const now = Date.now() / 1000;
    fs.utimesSync(activeFile, now - 60, now - 60);
    fs.utimesSync(archivedFile, now, now);
    const catalog = list();
    expect(catalog.candidates.map(c => c.id)).toEqual(['b', 'a']);
    expect(catalog.complete).toBe(true);
    expect(catalog.candidates.find(c => c.id === 'a')).toMatchObject({ name: 'Refactor auth module', source: 'native-local', countComplete: false });
    // The header carries base instructions; none of that may leak into metadata.
    expect(JSON.stringify(catalog)).not.toContain('instructions');
  });

  it('excludes sub-agents, forks, synthetic pointers and malformed records', () => {
    write(active, '2026/01/02', 'rollout-user.jsonl', { id: 'user', session_id: 'user' });
    write(active, '2026/01/02', 'rollout-sub.jsonl', { id: 'sub', session_id: 'sub', source: { subagent: { thread_spawn: {} } } });
    write(active, '2026/01/02', 'rollout-parent.jsonl', { id: 'child', session_id: 'child', parent_thread_id: 'some-parent' });
    write(active, '2026/01/02', 'rollout-agent-path.jsonl', { id: 'agent-path', session_id: 'agent-path', agent_path: '/root/review' });
    write(active, '2026/01/02', 'rollout-synthetic-id.jsonl', { id: 'remote-cli-delegate-lane-x', session_id: 'x' });
    write(active, '2026/01/02', 'rollout-broken.jsonl', {}, ['{broken']);
    fs.writeFileSync(path.join(active, '2026/01/02', 'rollout-broken.jsonl'), '{not json\n');
    // A delegated worker native ID differs from the synthetic executor ID.
    const pointerDir = path.join(home, '.remote-cli', 'codex-sessions');
    fs.mkdirSync(pointerDir, { recursive: true });
    write(active, '2026/01/02', 'rollout-worker.jsonl', { id: 'worker-native', session_id: 'worker-native' });
    fs.writeFileSync(path.join(pointerDir, 'delegate-lane-00000000-0000-0000-0000-000000000000.json'),
      JSON.stringify({ id: 'worker-native' }));
    expect(list().candidates.map(c => c.id)).toEqual(['user']);
  });

  it('hides duplicated IDs across stores and reports incomplete coverage', () => {
    write(active, '2026/01/02', 'rollout-one.jsonl', { id: 'duplicate', session_id: 'duplicate' });
    write(archived, '', 'rollout-two.jsonl', { id: 'duplicate', session_id: 'duplicate' });
    const catalog = list();
    expect(catalog.candidates).toEqual([]);
    expect(catalog.complete).toBe(false);
    expect(catalog.notes.join(' ')).toContain('duplicated');
  });

  it('refuses symlinked rollout files and stays inside the canonical root', () => {
    write(active, '2026/01/02', 'rollout-valid.jsonl', { id: 'valid', session_id: 'valid' });
    const outside = write(path.join(home, 'outside'), '2026/01/02', 'rollout-outside.jsonl', { id: 'outside', session_id: 'outside' });
    fs.symlinkSync(outside, path.join(active, '2026/01/02', 'rollout-link.jsonl'));
    expect(list().candidates.map(c => c.id)).toEqual(['valid']);
  });

  it('honors an exact CODEX_HOME and ignores a relative override', () => {
    const exact = path.join(home, 'custom-codex');
    fs.mkdirSync(path.join(exact, 'sessions', '2026/01/02'), { recursive: true });
    write(path.join(exact, 'sessions'), '2026/01/02', 'rollout-exact.jsonl', { id: 'exact', session_id: 'exact' });
    write(active, '2026/01/02', 'rollout-default.jsonl', { id: 'default', session_id: 'default' });
    expect(list({ CODEX_HOME: exact }).candidates.map(c => c.id)).toEqual(['exact']);
    const relative = list({ CODEX_HOME: 'relative/codex' });
    expect(relative.notes.join(' ')).toContain('relative');
    expect(relative.candidates).toEqual([]);
    expect(relative.complete).toBe(false);
  });

  it('reports relative header workspaces, future-dated records and real coverage gaps', () => {
    write(active, '2026/01/02', 'rollout-relative.jsonl', { id: 'relative', session_id: 'relative', cwd: 'not-absolute' });
    const future = write(active, '2026/01/02', 'rollout-future.jsonl', { id: 'future', session_id: 'future' });
    const when = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    fs.utimesSync(future, when, when);
    write(active, '2026/01/02', 'rollout-ok.jsonl', { id: 'ok', session_id: 'ok' });
    const catalog = list();
    expect(catalog.candidates.map(c => c.id)).toEqual(['ok']);
    const missing = listCodexSessions(path.join(home, 'missing'), { home, env: {} });
    expect(missing).toMatchObject({ candidates: [], complete: false });
  });

  it('treats an absent optional store as empty rather than a coverage gap', () => {
    fs.rmSync(archived, { recursive: true, force: true });
    write(active, '2026/01/02', 'rollout-a.jsonl', { id: 'a', session_id: 'a' });
    const catalog = list();
    expect(catalog.candidates.map(c => c.id)).toEqual(['a']);
    expect(catalog.complete).toBe(true);
  });

  it('skips an oversized rollout header instead of parsing a partial record', () => {
    const directory = path.join(active, '2026/01/02');
    fs.mkdirSync(directory, { recursive: true });
    // One line longer than the hard header cap, with no newline until the end.
    fs.writeFileSync(path.join(directory, 'rollout-huge.jsonl'),
      `${'x'.repeat(1024 * 1024 + 64)}\n${meta({ id: 'huge', session_id: 'huge' })}\n`);
    write(active, '2026/01/02', 'rollout-small.jsonl', { id: 'small', session_id: 'small' });
    expect(list().candidates.map(c => c.id)).toEqual(['small']);
  });

  it('flags an existing but unreadable sessions store instead of reporting it empty', () => {
    write(active, '2026/01/02', 'rollout-a.jsonl', { id: 'a', session_id: 'a' });
    if (process.getuid && process.getuid() !== 0) {
      fs.chmodSync(active, 0o000);
      try {
        // The canonical root still resolves, so the readdir failure is reported.
        expect(list().candidates).toEqual([]);
        expect(list().complete).toBe(false);
      } finally { fs.chmodSync(active, 0o700); }
    }
  });

  it('bounds the retained candidate count and flags truncation', () => {
    for (let i = 0; i < 205; i++) {
      write(active, '2026/01/02', `rollout-${String(i).padStart(3, '0')}.jsonl`, { id: `s${i}`, session_id: `s${i}` });
    }
    const catalog = list();
    expect(catalog.candidates.length).toBeLessThanOrEqual(200);
    expect(catalog.complete).toBe(false);
    expect(catalog.notes.join(' ')).toContain('not be fully scanned');
  });
});

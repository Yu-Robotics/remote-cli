import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { formatLocalSessionInfo, readLocalSessionInfo, SESSION_POINTER_NAMESPACES } from '../../src/session/SessionLocalInfo';

describe('local read-only session inspection', () => {
  let home: string;
  let workspace: string;
  const threadId = 'thread-example';
  const base = () => ({ threadId, threadName: 'default', workingDirectory: workspace, home });

  beforeEach(() => {
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'session-local-test-')));
    workspace = path.join(home, 'workspace');
    fs.mkdirSync(workspace);
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const writePointer = (backend: string, value: unknown) => {
    const directory = path.join(home, '.remote-cli', SESSION_POINTER_NAMESPACES[backend as keyof typeof SESSION_POINTER_NAMESPACES]);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${threadId}.json`), JSON.stringify(value), { mode: 0o600 });
  };

  it('reports missing history without inventing a selector', () => {
    const info = readLocalSessionInfo({ ...base(), backend: 'pi' });
    expect(info).toMatchObject({ record: 'missing', pointerLabel: `pi-sessions/${threadId}.json` });
    expect(info.reopen).toBeUndefined();
    expect(info.notes.join(' ')).toContain('No persisted session pointer');
    expect(formatLocalSessionInfo(info)).toContain('pi-sessions/');
  });

  it('reports a present pointer with verified reopen guidance for each verified backend', () => {
    writePointer('claude', { id: 'claude-native', cwd: workspace });
    const claude = readLocalSessionInfo({ ...base(), backend: 'claude' });
    expect(claude).toMatchObject({ record: 'present', nativeId: 'claude-native' });
    expect(claude.reopen?.command).toBe('claude --resume claude-native');

    writePointer('codex', { id: 'codex-native', savedAt: '2026-01-01T00:00:00.000Z' });
    const codex = readLocalSessionInfo({ ...base(), backend: 'codex' });
    expect(codex.reopen?.command).toBe('codex resume codex-native');
    expect(formatLocalSessionInfo(codex)).toContain('Recorded at: 2026-01-01T00:00:00.000Z');

    writePointer('opencode', { id: 'opencode-native', cwd: workspace });
    expect(readLocalSessionInfo({ ...base(), backend: 'opencode' }).reopen?.command).toBe('opencode --session opencode-native');

    writePointer('pi', { id: 'pi-native', sessionFile: '/tmp/example-session.jsonl' });
    const pi = readLocalSessionInfo({ ...base(), backend: 'pi' });
    expect(pi.reopen?.command).toBe('pi --session /tmp/example-session.jsonl');
    expect(pi.sessionFile).toBe('/tmp/example-session.jsonl');
  });

  it('withholds reopen guidance for backends whose flags are not verified', () => {
    for (const backend of ['agy', 'kimi', 'zcode', 'dsh']) {
      writePointer(backend, { id: 'native-example', cwd: workspace });
      const info = readLocalSessionInfo({ ...base(), backend: backend as keyof typeof SESSION_POINTER_NAMESPACES });
      expect(info.record).toBe('present');
      expect(info.reopen).toBeUndefined();
      expect(info.notes.join(' ')).toContain('not verified');
      expect(formatLocalSessionInfo(info)).toContain('No reopen command is suggested');
    }
  });

  it('warns when the pointer records a different working directory', () => {
    writePointer('pi', { id: 'pi-native', cwd: path.join(home, 'other') });
    expect(readLocalSessionInfo({ ...base(), backend: 'pi' }).notes.join(' ')).toContain('different working directory');
  });

  it('fails closed on unreadable, malformed and symlinked pointers', () => {
    const directory = path.join(home, '.remote-cli', 'pi-sessions');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${threadId}.json`);
    for (const bytes of ['{broken', '[]', JSON.stringify({ id: '' }), JSON.stringify({ id: 42 })]) {
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      expect(readLocalSessionInfo({ ...base(), backend: 'pi' }).record).toBe('unreadable');
    }
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(home, 'target.json');
    fs.writeFileSync(target, JSON.stringify({ id: 'native' }), { mode: 0o600 });
    fs.symlinkSync(target, file);
    expect(readLocalSessionInfo({ ...base(), backend: 'pi' }).record).toBe('unreadable');
  });

  it('reports a mid-read replacement and a non-object payload as unreadable', () => {
    const directory = path.join(home, '.remote-cli', 'pi-sessions');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${threadId}.json`);
    fs.writeFileSync(file, JSON.stringify({ id: 'native' }), { mode: 0o600 });
    const original = fs.fstatSync.bind(fs);
    let calls = 0;
    const replaced = vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const stat = original(fd);
      calls++;
      // Only the pointer record read may simulate a swapped file identity.
      return calls === 1 ? { ...stat, ino: stat.ino + 1 } : stat;
    }) as typeof fs.fstatSync);
    try { expect(readLocalSessionInfo({ ...base(), backend: 'pi' }).record).toBe('unreadable'); }
    finally { replaced.mockRestore(); }
  });

  it('omits optional fields for an absent session file and reports a null payload', () => {
    writePointer('pi', null);
    expect(readLocalSessionInfo({ ...base(), backend: 'pi' }).record).toBe('unreadable');
    writePointer('pi', { id: 'pi-native', cwd: workspace });
    const text = formatLocalSessionInfo(readLocalSessionInfo({ ...base(), backend: 'pi' }));
    expect(text).not.toContain('Session file:');
    expect(text).not.toContain('Recorded at:');
  });

  it('never claims ownership protection for a plain terminal process', () => {
    writePointer('pi', { id: 'pi-native', cwd: workspace });
    const text = formatLocalSessionInfo(readLocalSessionInfo({ ...base(), backend: 'pi' }));
    expect(text).toContain('does not hold an ownership lease');
  });
});

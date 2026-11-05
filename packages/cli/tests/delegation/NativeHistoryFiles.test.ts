import { NativeHistoryAnchor } from '../../src/delegation/HistoryAnchor';
import { LinuxHistoryAnchor } from '../../src/delegation/LinuxHistoryAnchor';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureHistoryTarget, claudeProjectName, deleteOwnedHistoryFiles, stableHistoryHash,
  validOwnedHistoryTarget, verifyHistoryTarget, type OwnedHistoryTarget } from '../../src/delegation/NativeHistoryFiles';
import { deletionPreparation, type NativeDeletionPreparation } from '../../src/delegation/NativeSessionDeletion';

// Capture the host before platform-branch mocks. Descriptor tests need real Linux procfs.
const PlatformHistoryAnchor = process.platform === 'linux' ? LinuxHistoryAnchor : NativeHistoryAnchor;
const linuxIt = process.platform === 'linux' ? it : it.skip;

describe('exact owned native history deletion', () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-history-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });

  async function fixture(backend: 'pi' | 'claude', override?: string) {
    const id = randomUUID();
    const lane = `delegate-lane-${randomUUID()}`;
    const nativeHome = path.join(home, backend === 'pi' ? lane : 'custom-config');
    const scope = backend === 'pi' ? nativeHome : path.join(nativeHome, 'projects', override ?? claudeProjectName(home));
    const pointer = path.join(home, 'pointers', `${lane}.json`);
    const transcript = path.join(scope, backend === 'pi' ? `2026-01-01T00-00-00-000Z_${id}.jsonl` : `${id}.jsonl`);
    await fs.mkdir(scope, { recursive: true }); await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, JSON.stringify({ id, ...(backend === 'pi' ? { sessionFile: transcript } : {}) }));
    const target = await captureHistoryTarget({ backend, sessionId: id, executorThreadId: lane, home, nativeHome, scope,
      pointer, cwd: home, command: `synthetic-${backend}`, transcript, ...(override ? { projectOverride: override } : {}) });
    if (backend === 'claude') target.confirmed = true;
    await fs.writeFile(transcript, JSON.stringify(backend === 'pi'
      ? { type: 'session', version: 3, id, cwd: home, timestamp: '2026-01-01T00:00:00.000Z' }
      : { type: 'user', sessionId: id, cwd: home, version: '2.1.308', message: { content: 'synthetic' } }) + '\n');
    return target;
  }
  async function remove(target: OwnedHistoryTarget, saved?: NativeDeletionPreparation) {
    let prepared = saved;
    const result = await deleteOwnedHistoryFiles(target, { prepared, persistPrepared: async value => { prepared = structuredClone(value); } });
    return { result, prepared: prepared! };
  }

  it.each(['2.1.309', '9.0.0', undefined])('deletes the supported Claude layout with diagnostic version %s', async version => {
    const target = await fixture('claude');
    await fs.writeFile(target.transcript!, JSON.stringify({ type: 'user', sessionId: target.sessionId,
      cwd: home, version, message: { content: 'synthetic' } }) + '\n');
    expect((await remove(target)).result.state).toBe('deleted');
  });
  it.each(['unknown-type', 'missing-message', 'invalid-message', 'foreign-cwd', 'foreign-id', 'non-object'])(
    'holds unrecognized Claude transcript layout %s', async fault => {
    const target = await fixture('claude');
    const record: any = { type: 'user', sessionId: target.sessionId, cwd: home, message: { content: 'synthetic' } };
    if (fault === 'unknown-type') record.type = 'unknown-format';
    if (fault === 'missing-message') delete record.message;
    if (fault === 'invalid-message') record.message.content = 123;
    if (fault === 'foreign-cwd') record.cwd = path.join(home, 'foreign');
    if (fault === 'foreign-id') record.sessionId = randomUUID();
    await fs.writeFile(target.transcript!, JSON.stringify(fault === 'non-object' ? null : record) + '\n');
    expect((await remove(target)).result.state).toBe('held');
    expect((await fs.stat(target.transcript!)).isFile()).toBe(true);
  });
  it.each([undefined, 2, 4, '3'])('retains Pi histories with unsupported JSONL format %s', async version => {
    const target = await fixture('pi');
    expect(target.nativeVersion).toBe('pi-jsonl-v3');
    await fs.writeFile(target.transcript!, JSON.stringify({ type: 'session', version, id: target.sessionId,
      cwd: home, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
    expect((await remove(target)).result.state).toBe('held');
    expect((await fs.stat(target.transcript!)).isFile()).toBe(true);
  });
  it.each(['pi', 'claude'] as const)('keeps legacy %s target hashes and manifests unchanged during missing-file retries', async backend => {
    const target = await fixture(backend);
    if (target.backend === 'pi') target.nativeVersion = '1.5.0';
    if (target.backend === 'claude') target.nativeVersion = '2.1.308';
    const originalTarget = JSON.stringify(target);
    const first = await remove(target);
    expect(first.result.state).toBe('deleted');
    expect(first.prepared.nativeVersion).toBe(target.nativeVersion);
    expect(first.prepared.targetHash).toBe(stableHistoryHash(target));
    const originalPreparation = JSON.stringify(first.prepared);
    const restored = JSON.parse(originalTarget);
    const prepared = JSON.parse(originalPreparation);
    expect((await remove(restored, prepared)).result.state).toBe('deleted');
    expect(JSON.stringify(restored)).toBe(originalTarget);
    expect(JSON.stringify(prepared)).toBe(originalPreparation);
  });

  it.each(['pi', 'claude'] as const)('deletes only %s history and idempotently reconciles a lost acknowledgement', async backend => {
    const target = await fixture(backend);
    const other = await fixture(backend);
    const retained = path.join(home, 'results.txt'); await fs.writeFile(retained, 'retained artifact');
    const { result, prepared } = await remove(target);
    expect(result.state).toBe('deleted');
    expect((await remove(target, JSON.parse(JSON.stringify(prepared)))).result.state).toBe('deleted');
    await expect(fs.stat(target.transcript!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(retained, 'utf8')).toBe('retained artifact');
    expect((await fs.stat(other.transcript!)).isFile()).toBe(true);
    expect((await fs.stat(target.pointer)).isFile()).toBe(true);
  });
  it('removes owned Claude subagent history but preserves external code and exports', async () => {
    const target = await fixture('claude', 'managed_project');
    const subtree = path.join(target.scope.path, target.sessionId, 'subagents');
    await fs.mkdir(subtree, { recursive: true }); await fs.writeFile(path.join(subtree, 'agent-1.jsonl'), '{}\n');
    const exportFile = path.join(target.scope.path, 'export.md'); await fs.writeFile(exportFile, 'export');
    expect((await remove(target)).result.state).toBe('deleted');
    expect(await fs.readFile(exportFile, 'utf8')).toBe('export');
  });
  it('reconciles an orphan sibling after a prepared transcript unlink', async () => {
    const target = await fixture('claude');
    const sibling = path.join(target.scope.path, target.sessionId);
    await fs.mkdir(sibling); await fs.writeFile(path.join(sibling, 'history.jsonl'), '{}\n');
    const original = PlatformHistoryAnchor.prototype.remove;
    const fault = vi.spyOn(PlatformHistoryAnchor.prototype, 'remove').mockImplementation(async function(entry) {
      if (entry.kind === 'directory') throw Object.assign(new Error('synthetic failure'), { code: 'EACCES' });
      return original.call(this, entry);
    });
    const first = await remove(target);
    expect(first.result.state).toBe('uncertain');
    await expect(fs.stat(target.transcript!)).rejects.toMatchObject({ code: 'ENOENT' });
    fault.mockRestore();
    expect((await remove(target, first.prepared)).result.state).toBe('deleted');
    await expect(fs.stat(sibling)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retries an immutable manifest after a nested directory was already removed', async () => {
    const target = await fixture('claude');
    const sibling = path.join(target.scope.path, target.sessionId);
    const nested = path.join(sibling, 'subagents', 'deep'); await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, 'agent.jsonl'), '{}\n');
    const original = PlatformHistoryAnchor.prototype.remove; let removed = 0;
    const fault = vi.spyOn(PlatformHistoryAnchor.prototype, 'remove').mockImplementation(async function(entry) {
      if (entry.kind === 'directory' && ++removed === 2) throw new Error('synthetic interruption after one directory removal');
      return original.call(this, entry);
    });
    const first = await remove(target); expect(first.result.state).toBe('uncertain');
    await expect(fs.lstat(nested)).rejects.toMatchObject({ code: 'ENOENT' });
    fault.mockRestore();
    expect((await remove(target, first.prepared)).result.state).toBe('deleted');
    await expect(fs.lstat(sibling)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('handles a confirmed empty Claude transcript with a durable manifest', async () => {
    const target = await fixture('claude'); await fs.writeFile(target.transcript!, '');
    expect((await remove(target)).result.state).toBe('deleted');
  });
  it('holds unconfirmed Claude and unprepared missing transcripts', async () => {
    const target = await fixture('claude'); delete target.confirmed;
    expect((await remove(target)).result.state).toBe('held');
    target.confirmed = true; await fs.unlink(target.transcript!);
    expect((await remove(target)).result.state).toBe('held');
  });
  it.each(['pi', 'claude'] as const)('holds %s when durable preparation fails', async backend => {
    const target = await fixture(backend);
    const result = await deleteOwnedHistoryFiles(target, { persistPrepared: async () => { throw new Error('synthetic disk failure'); } });
    expect(result.state).toBe('held'); expect((await fs.stat(target.transcript!)).isFile()).toBe(true);
  });
  it.each(['pi', 'claude'] as const)('holds %s for an adopted or duplicate pointer', async backend => {
    const target = await fixture(backend);
    const pointer = path.join(target.pointerRoot.path, 'foreground.json');
    await fs.writeFile(pointer, JSON.stringify({ id: target.sessionId, adopted: true }));
    expect((await remove(target)).result.state).toBe('held');
  });
  it('allows a detached historical identity but does not erase its replacement', async () => {
    const target = await fixture('pi');
    await fs.writeFile(target.pointer, JSON.stringify({ id: randomUUID() }));
    expect((await remove(target)).result.state).toBe('held');
    expect((await deleteOwnedHistoryFiles(target, { detachedPointer: true, persistPrepared: async () => {} })).state).toBe('deleted');
    expect((await fs.stat(target.pointer)).isFile()).toBe(true);
  });
  it.each([true, false])('rejects a replacement ID still pointing to the old file (adopted=%s)', async adopted => {
    const target = await fixture('pi');
    await fs.writeFile(target.pointer, JSON.stringify({ id: randomUUID(), sessionFile: target.transcript, adopted }));
    await expect(verifyHistoryTarget(target, true)).rejects.toThrow();
    expect((await fs.stat(target.transcript!)).isFile()).toBe(true);
  });
  it('recognizes normalized references and permits unrelated detached replacements', async () => {
    const target = await fixture('pi');
    const alias = target.scope.path + path.sep + '.' + path.sep + path.basename(target.transcript!);
    await fs.writeFile(target.pointer, JSON.stringify({ id: randomUUID(), sessionFile: alias }));
    await expect(verifyHistoryTarget(target, true)).rejects.toThrow();
    await fs.writeFile(target.pointer, JSON.stringify({ id: randomUUID(), sessionFile: path.join(home, 'unrelated.jsonl'), adopted: true }));
    await expect(verifyHistoryTarget(target, true)).resolves.toBeUndefined();
  });
  it('recognizes directory aliases before and after transcript removal', async context => {
    const target = await fixture('pi'); const alias = path.join(home, 'alias');
    try { await fs.symlink(target.scope.path, alias, 'dir'); }
    catch (error) {
      if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    await fs.writeFile(target.pointer, JSON.stringify({ id: randomUUID(), sessionFile: path.join(alias, path.basename(target.transcript!)), adopted: true }));
    await expect(verifyHistoryTarget(target, true)).rejects.toThrow('references');
    await fs.unlink(target.transcript!);
    await expect(verifyHistoryTarget(target, true)).rejects.toThrow('references');
  });
  it('resolves a symlink followed by dot-dot using filesystem semantics', async () => {
    const target = await fixture('pi'); const intermediate = path.join(target.scope.path, 'intermediate'); await fs.mkdir(intermediate);
    // Win32 collapses dot-dot before following the directory link; POSIX follows it first.
    const alias = path.join(process.platform === 'win32' ? target.scope.path : home, 'alias');
    await fs.symlink(intermediate, alias, 'dir');
    const reference = alias + path.sep + '..' + path.sep + path.basename(target.transcript!);
    expect(await fs.realpath(reference)).toBe(target.transcript);
    await fs.writeFile(target.pointer, JSON.stringify({ id: randomUUID(), sessionFile: reference, adopted: true }));
    await expect(verifyHistoryTarget(target, true)).rejects.toThrow('references');
  });
  linuxIt.each(['scope', 'nested'] as const)('anchors deletion when the %s parent is swapped immediately before unlink', async kind => {
    const target = await fixture(kind === 'scope' ? 'pi' : 'claude');
    const parent = kind === 'scope' ? target.scope.path : path.join(target.scope.path, target.sessionId, 'subagents');
    const name = kind === 'scope' ? path.basename(target.transcript!) : 'agent.jsonl';
    if (kind === 'nested') { await fs.mkdir(parent, { recursive: true }); await fs.writeFile(path.join(parent, name), '{}\n'); }
    const foreign = path.join(home, 'foreign'); await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, name), 'foreign sentinel');
    const original = fs.unlink; let swapped = false;
    vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      if (!swapped && path.basename(String(file)) === name) {
        swapped = true; await fs.rename(parent, parent + '-saved'); await fs.symlink(foreign, parent, 'dir');
      }
      return original(file);
    });
    const { result } = await remove(target);
    expect(swapped).toBe(true); expect(result.state).not.toBe('deleted');
    expect(await fs.readFile(path.join(foreign, name), 'utf8')).toBe('foreign sentinel');
  });
  it.each(['symlink', 'hardlink'] as const)('rejects a transcript %s before any deletion', async (kind, context) => {
    const target = await fixture('pi'); const foreign = path.join(home, 'foreign.jsonl');
    await fs.rename(target.transcript!, foreign);
    try {
      if (kind === 'symlink') await fs.symlink(foreign, target.transcript!); else await fs.link(foreign, target.transcript!);
    } catch (error) {
      if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    expect((await remove(target)).result.state).toBe('held'); expect((await fs.stat(foreign)).isFile()).toBe(true);
  });
  it('rejects symlinks inside the Claude subtree without traversing them', async context => {
    const target = await fixture('claude'); const directory = path.join(target.scope.path, target.sessionId);
    await fs.mkdir(directory);
    try { await fs.symlink(home, path.join(directory, 'outside'), 'dir'); }
    catch (error) {
      if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    expect((await remove(target)).result.state).toBe('held'); expect((await fs.stat(target.transcript!)).isFile()).toBe(true);
  });
  it('does not reconcile a dangling replacement symlink as an absent prepared file', async context => {
    const target = await fixture('pi'); const { prepared } = await remove(target);
    try { await fs.symlink(path.join(home, 'missing-target'), target.transcript!); }
    catch (error) {
      if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    expect((await remove(target, prepared)).result.state).toBe('held');
    expect((await fs.lstat(target.transcript!)).isSymbolicLink()).toBe(true);
  });
  it('rejects root replacement even when its pathname is unchanged', async () => {
    const target = await fixture('pi');
    await fs.rename(target.scope.path, target.scope.path + '-old'); await fs.mkdir(target.scope.path);
    expect((await remove(target)).result.state).toBe('held');
  });
  it('rejects a changed header, duplicate ID, and forged preparation', async () => {
    const target = await fixture('pi'); const bytes = await fs.readFile(target.transcript!, 'utf8');
    await fs.writeFile(target.transcript!, bytes.replace(target.sessionId, randomUUID()));
    expect((await remove(target)).result.state).toBe('held');
    await fs.writeFile(target.transcript!, bytes); await fs.writeFile(path.join(target.scope.path, 'duplicate.jsonl'), bytes);
    expect((await remove(target)).result.state).toBe('held');
    const forged = { ...deletionPreparation(target), files: [], targetHash: '0'.repeat(64) };
    expect((await remove(target, forged)).result.state).toBe('held');
  });
  it('rejects a file changed by a late callback after preparation', async () => {
    const target = await fixture('pi');
    const result = await deleteOwnedHistoryFiles(target, { persistPrepared: async () => { await fs.appendFile(target.transcript!, '{}\n'); } });
    expect(result.state).toBe('held'); expect((await fs.stat(target.transcript!)).isFile()).toBe(true);
  });
  it.each(['freebsd', 'sunos'] as const)('does not delete without %s writer proof', async platform => {
    const target = await fixture('pi'); vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    expect((await remove(target)).result.state).toBe('unsupported');
  });
  it('uses native encoding and stable receipt hashes', async () => {
    expect(claudeProjectName('a.b/c_d')).toBe('a-b-c-d');
    const cwd = 'a'.repeat(201); let hash = 0;
    for (const character of cwd) hash = (hash * 31 + character.charCodeAt(0)) | 0;
    expect(claudeProjectName(cwd)).toBe(`${'a'.repeat(200)}-${Math.abs(hash).toString(36)}`);
    const target = await fixture('claude', 'valid_override');
    expect(validOwnedHistoryTarget(target)).toBe(true);
    expect(validOwnedHistoryTarget({ ...target, backend: 'unknown', nativeVersion: undefined })).toBe(false);
    expect(validOwnedHistoryTarget({ ...target, projectOverride: '../outside' })).toBe(false);
    expect(stableHistoryHash(Object.fromEntries(Object.entries(target).reverse()))).toBe(stableHistoryHash(target));
  });
});

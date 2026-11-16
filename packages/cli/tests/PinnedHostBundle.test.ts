import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { once } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PinnedHostBundleInput, preparePinnedHostBundle, VerifiedHostFile, verifyPinnedHostBundle } from '../src/update/PinnedHostBundle';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let root: string;
let input: PinnedHostBundleInput;
async function file(base: string, name: string, data: string, mode = 0o644): Promise<VerifiedHostFile> {
  const target = path.join(base, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data); await fs.chmod(target, mode);
  return { path: name, sha256: hash(data), mode: (await fs.stat(target)).mode & 0o777 };
}
// The production launcher explicitly rejects Windows. These cases exercise POSIX
// file modes, symlink identity and a POSIX interpreter, not mocked Windows ACLs.
beforeEach(async () => {
  if (process.platform === 'win32') return;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pinned-host-')));
  const pkg = path.join(root, 'source');
  const files = [await file(pkg, 'package.json', JSON.stringify({ name: 'synthetic-host', dependencies: { 'synthetic-dep': '*' } })),
    await file(pkg, 'dist/entry.cjs', "process.stdout.write('ready');process.stdin.once('data',()=>{console.log(require('./helper.cjs'));process.exit(0)})"),
    await file(pkg, 'dist/helper.cjs', "module.exports=require('synthetic-dep')"),
    await file(pkg, 'native/worker.cjs', '#!/usr/bin/env node\n', 0o755),
    await file(pkg, 'native/prebuilds/synthetic.node', 'synthetic-addon')];
  const dep = path.join(root, 'verified-dependency');
  const dependencyFiles = [await file(dep, 'package.json', JSON.stringify({ name: 'synthetic-dep', main: 'index.cjs' })),
    await file(dep, 'index.cjs', "module.exports='retained-dependency'")];
  const node = await file(root, 'node', '#!/bin/sh\nexit 0\n', 0o755);
  input = { storeRoot: path.join(root, 'store'), package: { root: pkg, files }, dependencies: [
    { root: dep, mount: 'node_modules/synthetic-dep', files: dependencyFiles }], entry: 'dist/entry.cjs',
    node: { path: path.join(root, 'node'), sha256: node.sha256, mode: node.mode } };
});
afterEach(async () => { vi.restoreAllMocks(); if (root) await fs.rm(root, { recursive: true, force: true }); });

describe.runIf(process.platform !== 'win32')('PinnedHostBundle POSIX filesystem', () => {
  it('pins the interpreter, deferred helpers, native assets and dependency after source deletion', async () => {
    const nodePath = await fs.realpath(process.execPath);
    input.node = { path: nodePath, sha256: hash(await fs.readFile(nodePath)), mode: (await fs.stat(nodePath)).mode & 0o777 };
    const bundle = await preparePinnedHostBundle(input);
    const child = spawn(bundle.nodePath, [bundle.entryPath], { cwd: bundle.packageRoot, env: { HOME: root }, stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = once(child, 'exit');
    let output = '';
    child.stdout.on('data', data => { output += data; });
    try {
      await once(child.stdout, 'data');
      expect(output).toBe('ready');
      await fs.rm(input.package.root, { recursive: true });
      await fs.rm(input.dependencies[0].root, { recursive: true });
      child.stdin.end('continue');
      expect(await exit).toEqual([0, null]);
      expect(output).toContain('retained-dependency');
      expect(await fs.readFile(path.join(bundle.assetsRoot, 'native/prebuilds/synthetic.node'), 'utf8')).toBe('synthetic-addon');
      expect((await fs.stat(path.join(bundle.assetsRoot, 'native/worker.cjs'))).mode & 0o111).toBe(0o111);
      expect((await verifyPinnedHostBundle(bundle.root, bundle.digest)).entryPath).toBe(bundle.entryPath);
    } finally { if (child.exitCode === null) { child.kill(); await exit; } }
  });
  it('publishes one complete bundle under concurrent preparations and reuses it without rewrites', async () => {
    const bundles = await Promise.all([preparePinnedHostBundle(input), preparePinnedHostBundle(input)]);
    expect(bundles[0]).toEqual(bundles[1]);
    const before = await fs.stat(bundles[0].entryPath);
    expect(await preparePinnedHostBundle(input)).toEqual(bundles[0]);
    expect((await fs.stat(bundles[0].entryPath)).mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readdir(input.storeRoot)).toEqual([bundles[0].digest]);
  });
  it.each(['missing', 'changed', 'extra', 'manifest', 'symlink', 'empty'])('rejects %s published content without repairing a referenced bundle', async kind => {
    const bundle = await preparePinnedHostBundle(input);
    if (kind === 'empty') { await fs.rm(bundle.root, { recursive: true }); await fs.mkdir(bundle.root); }
    if (kind === 'missing') await fs.unlink(bundle.entryPath);
    if (kind === 'changed') { await fs.chmod(bundle.entryPath, 0o644); await fs.writeFile(bundle.entryPath, 'changed'); }
    if (kind === 'extra') await fs.writeFile(path.join(bundle.root, 'extra'), 'untracked');
    if (kind === 'manifest') { await fs.chmod(bundle.manifestPath, 0o600); await fs.writeFile(bundle.manifestPath, '{}'); }
    if (kind === 'symlink') { await fs.unlink(bundle.entryPath); await fs.symlink(path.join(input.package.root, input.entry), bundle.entryPath); }
    await expect(preparePinnedHostBundle(input)).rejects.toThrow();
  });
  it('does not publish or leave staging content on an input digest failure', async () => {
    await fs.writeFile(path.join(input.package.root, 'dist/helper.cjs'), 'modified');
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('integrity');
    expect(await fs.readdir(input.storeRoot)).toEqual([]);
  });
  it('preserves nested dependency versions and rejects missing transitive/peer dependencies', async () => {
    const dep = input.dependencies[0];
    dep.files[0] = await file(dep.root, 'package.json', JSON.stringify({ name: 'synthetic-dep', dependencies: { nested: '*' }, peerDependencies: { peer: '*' } }));
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('nested');
    const nested = path.join(root, 'nested');
    input.dependencies.push({ root: nested, mount: 'node_modules/synthetic-dep/node_modules/nested', files: [await file(nested, 'package.json', '{"name":"nested"}')] });
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('peer');
    const peer = path.join(root, 'peer');
    input.dependencies.push({ root: peer, mount: 'node_modules/peer', files: [await file(peer, 'package.json', '{"name":"peer"}')] });
    await expect(preparePinnedHostBundle(input)).resolves.toHaveProperty('entryPath');
  });
  it('requires explicit optional omissions', async () => {
    input.package.files[0] = await file(input.package.root, 'package.json', '{"optionalDependencies":{"optional":"*"}}');
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('optional');
    input.package.omittedOptionalDependencies = ['optional'];
    await expect(preparePinnedHostBundle(input)).resolves.toHaveProperty('digest');
  });
  it('accepts explicitly supplied workspace roots and preserves declared internal file links and their module identity', async () => {
    const link = path.join(root, 'workspace-link');
    await fs.symlink(input.package.root, link, process.platform === 'win32' ? 'junction' : 'dir');
    input.package.root = link;
    const target = input.package.files.find(f => f.path === 'dist/helper.cjs')!;
    input.package.files.push({ ...target, path: 'dist/alias.cjs' });
    await fs.symlink('helper.cjs', path.join(link, 'dist/alias.cjs'));
    const bundle = await preparePinnedHostBundle(input);
    expect((await fs.lstat(path.join(bundle.packageRoot, 'dist/alias.cjs'))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(bundle.packageRoot, 'dist/alias.cjs'))).toBe(path.join(bundle.packageRoot, 'dist/helper.cjs'));
  });
  it('refuses links to undeclared files even inside the package', async () => {
    await fs.writeFile(path.join(input.package.root, 'private'), 'not a distribution asset');
    await fs.unlink(path.join(input.package.root, 'dist/helper.cjs'));
    await fs.symlink('../private', path.join(input.package.root, 'dist/helper.cjs'));
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('Unproven');
  });
  it('refuses escaping links and directory links', async () => {
    const helper = path.join(input.package.root, 'dist/helper.cjs');
    await fs.unlink(helper); await fs.symlink(input.node.path, helper);
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('Unproven');
    await fs.unlink(helper); await fs.rm(path.join(input.package.root, 'dist'), { recursive: true });
    await fs.symlink(input.dependencies[0].root, path.join(input.package.root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('Directory symlink');
  });
  it.each(['../escape', '/absolute', 'dist/../escape', 'dist\\escape', 'dist/bad\npath'])('rejects unsafe entry %s', async entry => {
    input.entry = entry;
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('path');
  });
  it('rejects missing entries, duplicate inventories, unverified nested trees and malformed inputs', async () => {
    input.entry = 'missing'; await expect(preparePinnedHostBundle(input)).rejects.toThrow('entry'); input.entry = 'dist/entry.cjs';
    input.package.files.push(input.package.files[0]); await expect(preparePinnedHostBundle(input)).rejects.toThrow('duplicate'); input.package.files.pop();
    input.package.files.push({ path: 'node_modules/hidden', sha256: 'a'.repeat(64), mode: 0o644 });
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('separate'); input.package.files.pop();
    input.dependencies.push(input.dependencies[0]); await expect(preparePinnedHostBundle(input)).rejects.toThrow('Duplicate'); input.dependencies.pop();
    input.dependencies[0].mount = 'escape'; await expect(preparePinnedHostBundle(input)).rejects.toThrow('mount');
  });
  it('rejects store inside a mutable input and unverified interpreter mode', async () => {
    input.storeRoot = path.join(input.package.root, 'store');
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('separate');
    input.storeRoot = path.join(root, 'store'); input.node.mode = 0o644;
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('executable');
    input.node.mode = 0o4755; await expect(preparePinnedHostBundle(input)).rejects.toThrow('mode');
  });
  it('rejects a changed mode or digest and a nonprivate store', async () => {
    input.node.sha256 = 'a'.repeat(64);
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('integrity');
    input.node.mode = 0o700;
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('mode');
    if (process.platform !== 'win32') {
      await fs.chmod(input.storeRoot, 0o755);
      await expect(preparePinnedHostBundle(input)).rejects.toThrow('private');
    }
  });
  it('refuses a package inventory omitting a deferred helper without copying unverified files', async () => {
    input.package.files = input.package.files.filter(f => f.path !== 'dist/helper.cjs');
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('inventory is incomplete');
    await expect(fs.stat(input.storeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('removes staging after atomic publication failure and never publishes half a tree', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic publication failure'));
    await expect(preparePinnedHostBundle(input)).rejects.toThrow('publication');
    rename.mockRestore();
    expect(await fs.readdir(input.storeRoot)).toEqual([]);
    await expect(preparePinnedHostBundle(input)).resolves.toHaveProperty('digest');
  });

  it('retains verified dependency executables at their npm bin lookup location', async () => {
    const dep = input.dependencies[0];
    dep.files[0] = await file(dep.root, 'package.json', '{"name":"synthetic-dep","bin":{"synthetic-bin":"./index.cjs"}}');
    dep.files[1] = await file(dep.root, 'index.cjs', '#!/usr/bin/env node\n', 0o755);
    const bundle = await preparePinnedHostBundle(input);
    const bin = path.join(bundle.packageRoot, 'node_modules/.bin/synthetic-bin');
    expect(await fs.realpath(bin)).toBe(path.join(bundle.packageRoot, 'node_modules/synthetic-dep/index.cjs'));
    expect((await fs.stat(bin)).mode & 0o111).toBe(0o111);
    await fs.unlink(bin); await fs.symlink(input.node.path, bin);
    await expect(verifyPinnedHostBundle(bundle.root, bundle.digest)).rejects.toThrow('link integrity');
  });

});

it.runIf(process.platform === 'win32')('refuses unsupported Windows pinning before accessing inputs', async () => {
  await expect(preparePinnedHostBundle({} as PinnedHostBundleInput)).rejects.toThrow('unsupported on Windows');
  await expect(verifyPinnedHostBundle('unused', 'unused')).rejects.toThrow('unsupported on Windows');
});

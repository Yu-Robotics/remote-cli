import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

export interface SharedSymlinkGrant { root: string; path: string; target: string }
export interface SharedLinkBinding { path: string; linkText: string; target: string; kind: 'file' | 'dir' }
export interface SharedSymlinkPolicy { root: string; grants: SharedSymlinkGrant[]; mode?: 'external' }
export interface SharedLinkOptions {
  sharedSymlinks?: unknown;
  /** New admissions only. Pinned policies never discover additional bindings. */
  discoverExternal?: boolean;
  policy?: SharedSymlinkPolicy;
  bindings?: SharedLinkBinding[];
  physical?: boolean;
  forbiddenTargets?: readonly string[];
}
function fail(): never { throw new Error('Invalid or changed shared-symlink authorization; the checkout is retained for recovery.'); }
/** Leave room for checkout identity and recovery metadata in bounded task records. */
function boundSharedMetadata(value: unknown, maximum: number): void {
  if (Buffer.byteLength(JSON.stringify(value)) > maximum) throw new Error('Shared-symlink authorization exceeds the task metadata byte limit.');
}
const inside = (root: string, file: string) => { const r = path.relative(root, file); return !path.isAbsolute(r) && r !== '..' && !r.startsWith(`..${path.sep}`); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k));
export function sharedLinkPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\\x00-\x1f\x7f:*?\[\]{}]/.test(value)
    && !path.posix.isAbsolute(value) && value.split('/').every(p => !!p && p !== '.' && p !== '..' && p.trim() === p && !p.endsWith('.') && p.toLowerCase() !== '.git');
}
const absolute = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && path.isAbsolute(value) && path.normalize(value) === value;
export function parseSharedSymlinkGrants(value: unknown): SharedSymlinkGrant[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) fail();
  const seen = new Set<string>();
  const grants = value.map(item => {
    if (!object(item) || !keys(item, ['root', 'path', 'target']) || !absolute(item.root) || !sharedLinkPath(item.path) || !absolute(item.target)) fail();
    const grant = item as unknown as SharedSymlinkGrant;
    const key = JSON.stringify([grant.root, grant.path]);
    if (seen.has(key)) fail(); seen.add(key);
    return { root: grant.root, path: grant.path, target: grant.target };
  });
  boundSharedMetadata(grants, 16 * 1024);
  return grants;
}
export function delegationSharedSymlinks(value: unknown): SharedSymlinkGrant[] {
  if (value === undefined) return [];
  if (!object(value) || Object.keys(value).some(k => k !== 'sharedSymlinks')) fail();
  return parseSharedSymlinkGrants(value.sharedSymlinks);
}
export async function validateSharedLocations(grants: SharedSymlinkGrant[]): Promise<void> {
  for (const grant of grants) {
    if (await fs.realpath(grant.root) !== grant.root || !(await fs.lstat(grant.root)).isDirectory()) fail();
    await targetKind(grant.root, grant.target, []);
  }
}
async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
/** Inspect only fixed metadata, never read shared file bytes or enumerate a directory. */
async function targetKind(root: string, target: string, forbidden: readonly string[]): Promise<'file' | 'dir'> {
  if (!absolute(target) || target.split(path.sep).some(p => p.toLowerCase() === '.git') || inside(root, target) || inside(target, root)
    || forbidden.some(p => inside(p, target) || inside(target, p))) fail();
  // A bare repository's administrative tree may not have a .git component.
  // Ascend through fixed metadata names only; never enumerate shared contents.
  for (let parent = path.dirname(target); ; parent = path.dirname(parent)) {
    if (await exists(path.join(parent, 'HEAD')) && await exists(path.join(parent, 'objects')) && await exists(path.join(parent, 'refs'))) fail();
    if (path.dirname(parent) === parent) break;
  }
  const before = await fs.lstat(target);
  if (before.isSymbolicLink() || !before.isFile() && !before.isDirectory() || await fs.realpath(target) !== target) fail();
  if (before.isDirectory() && (await exists(path.join(target, '.git'))
    || await exists(path.join(target, 'HEAD')) && await exists(path.join(target, 'objects')) && await exists(path.join(target, 'refs')))) fail();
  const after = await fs.lstat(target);
  if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.isDirectory() !== before.isDirectory()
    || after.isFile() !== before.isFile() || await fs.realpath(target) !== target) fail();
  return after.isDirectory() ? 'dir' : 'file';
}
export async function readNativeSharedLink(root: string, name: string): Promise<{ text: string; identity: string }> {
  if (!sharedLinkPath(name)) fail();
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root) fail();
  const parts = name.split('/');
  for (let n = 1; n < parts.length; n++) {
    const parent = path.join(root, ...parts.slice(0, n));
    if (!(await fs.lstat(parent)).isDirectory() || await fs.realpath(parent) !== parent) fail();
  }
  const file = path.join(root, name);
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isSymbolicLink()) throw new Error('Shared links require native symbolic links (core.symlinks=true and OS symlink privileges); no file or junction fallback is permitted.');
  const bytes = await fs.readlink(file, { encoding: 'buffer' });
  const text = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(text)) || !text || text.length > 16 * 1024 || text.includes('\0')) fail();
  const after = await fs.lstat(file, { bigint: true });
  const identity = (s: typeof before) => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(':');
  if (!after.isSymbolicLink() || identity(before) !== identity(after)) fail();
  return { text, identity: identity(before) };
}
/** Missing internal directories remain valid; unresolved aliases never establish containment. */
async function danglingInternalTarget(root: string, raw: string): Promise<boolean> {
  try { await fs.lstat(raw); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
  for (let parent = path.dirname(raw); ; parent = path.dirname(parent)) {
    try {
      const resolved = await fs.realpath(parent);
      return inside(root, resolved) && inside(root, path.join(resolved, raw.slice(parent.length)));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    // A dangling link is an existing entry, not an absent directory to skip.
    try { await fs.lstat(parent); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    if (path.dirname(parent) === parent) return false;
  }
}
export class SharedLinkCapture {
  readonly bindings: SharedLinkBinding[] = [];
  readonly policy: SharedSymlinkPolicy;
  private readonly pinned: boolean;
  constructor(readonly root: string, private readonly options: SharedLinkOptions) {
    this.pinned = options.bindings !== undefined;
    if (options.policy) {
      if (!object(options.policy) || !keys(options.policy as unknown as Record<string, unknown>, options.policy.mode === 'external' ? ['root', 'grants', 'mode'] : ['root', 'grants']) || !absolute(options.policy.root)) fail();
      this.policy = { root: options.policy.root, grants: parseSharedSymlinkGrants(options.policy.grants), ...(options.policy.mode === 'external' ? { mode: 'external' as const } : {}) };
      if (this.policy.grants.some(g => g.root !== this.policy.root)) fail();
    } else this.policy = { root, grants: parseSharedSymlinkGrants(options.sharedSymlinks).filter(g => g.root === root), ...(options.discoverExternal ? { mode: 'external' as const } : {}) };
    if (options.bindings !== undefined) {
      if (!Array.isArray(options.bindings) || options.bindings.length > 64) fail();
      for (const item of options.bindings) {
        if (!object(item) || !keys(item as unknown as Record<string, unknown>, ['path', 'linkText', 'target', 'kind']) || !sharedLinkPath(item.path)
          || typeof item.linkText !== 'string' || !item.linkText || item.linkText.length > 16 * 1024 || item.linkText.includes('\0')
          || !absolute(item.target) || !['file', 'dir'].includes(item.kind) || this.bindings.some(b => b.path === item.path)
          || !this.policy.grants.some(g => g.path === item.path && g.target === item.target)) fail();
        this.bindings.push({ path: item.path, linkText: item.linkText, target: item.target, kind: item.kind });
      }
      if (this.bindings.length !== this.policy.grants.length) fail();
      boundSharedMetadata(this.bindings, 32 * 1024);
    }
  }
  get discoversExternal(): boolean { return this.options.discoverExternal === true && !this.options.policy && !this.pinned; }
  /** Resolve the live link, retaining alias/.. semantics without reading target bytes. */
  async discover(name: string): Promise<void> {
    if (!this.discoversExternal || this.paths.includes(name)) return;
    const file = path.join(this.root, name);
    let target: string;
    try { target = await fs.realpath(file); }
    catch (error) {
      // Preserve legacy support for dangling internal relative links only.
      const text = await fs.readlink(file);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !path.isAbsolute(text)
        && inside(this.root, path.resolve(path.dirname(file), text))) {
        try {
          // Do not normalize alias/.. before checking a missing leaf's parent.
          const raw = `${path.dirname(file)}${path.sep}${text}`;
          if (await danglingInternalTarget(this.root, raw)) return;
        } catch { /* An unresolved parent cannot establish an internal target. */ }
      }
      throw new Error('External symbolic-link targets must exist and resolve without cycles.');
    }
    if (inside(this.root, target)) return;
    const link = await readNativeSharedLink(this.root, name);
    const kind = await targetKind(this.root, target, this.options.forbiddenTargets ?? []);
    if (await fs.realpath(file) !== target) fail();
    const after = await readNativeSharedLink(this.root, name);
    if (link.text !== after.text || link.identity !== after.identity) fail();
    const grant = { root: this.root, path: name, target };
    this.policy.grants = parseSharedSymlinkGrants([...this.policy.grants, grant]);
    this.bindings.push({ path: name, linkText: link.text, target, kind });
    boundSharedMetadata(this.bindings, 32 * 1024);
  }
  get physical(): boolean { return this.options.physical === true; }
  get paths(): string[] { return this.policy.grants.map(g => g.path); }
  async verifyTargets(): Promise<void> {
    if (await fs.realpath(this.policy.root) !== this.policy.root) fail();
    for (const b of this.bindings) if (await targetKind(this.policy.root, b.target, this.options.forbiddenTargets ?? []) !== b.kind) fail();
  }
  async initialize(): Promise<void> {
    if (await fs.realpath(this.policy.root) !== this.policy.root || !this.options.physical && this.root !== this.policy.root) fail();
    for (const grant of this.policy.grants) {
      const kind = await targetKind(this.policy.root, grant.target, this.options.forbiddenTargets ?? []);
      const link = await readNativeSharedLink(this.root, grant.path);
      const saved = this.bindings.find(b => b.path === grant.path);
      if (saved) {
        if (kind !== saved.kind || link.text !== (this.options.physical ? saved.target : saved.linkText)) fail();
      } else {
        if (this.pinned) fail();
        this.bindings.push({ path: grant.path, target: grant.target, linkText: link.text, kind });
        boundSharedMetadata(this.bindings, 32 * 1024);
      }
      // realpath on the link itself preserves raw target component semantics.
      if (await fs.realpath(path.join(this.root, grant.path)) !== grant.target) fail();
    }
    this.bindings.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    this.policy.grants.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  async accept(captureRoot: string, scope: string, file: string, text: string, logical = false): Promise<boolean> {
    const name = path.relative(scope, path.join(captureRoot, file)).split(path.sep).join('/');
    const saved = this.bindings.find(b => b.path === name);
    if (!saved) return false;
    if (captureRoot !== scope) throw new Error('Shared-symlink grants inside nested repositories are not supported; move the link to the outer repository.');
    const current = await readNativeSharedLink(this.root, name);
    if (current.text !== (this.options.physical ? saved.target : saved.linkText)
      || text !== (logical ? saved.linkText : current.text)
      || await fs.realpath(path.join(this.root, name)) !== saved.target
      || await targetKind(this.policy.root, saved.target, this.options.forbiddenTargets ?? []) !== saved.kind) fail();
    return true;
  }
  async verify(): Promise<void> { for (const b of this.bindings) await this.accept(this.root, this.root, b.path, this.options.physical ? b.target : b.linkText); }
}
export function sharedLinkBlob(text: string, oidLength: number): string {
  const bytes = Buffer.from(text); return createHash(oidLength === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

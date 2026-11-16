import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

/** Inventories must come from caller-verified distribution inputs, not a home scan.
 * Inventories cover the complete package tree except node_modules (separate inputs).
 * Paths are package-relative POSIX paths; mode is the original permission bits.
 * Include every runtime asset (including native addons and deferred helpers).
 */
export interface VerifiedHostFile { path: string; sha256: string; mode: number }
export interface VerifiedHostPackage {
  root: string;
  files: VerifiedHostFile[];
  /** Explicitly unavailable optional dependencies; never omit required dependencies. */
  omittedOptionalDependencies?: string[];
}
export interface PinnedHostBundleInput {
  storeRoot: string;
  package: VerifiedHostPackage;
  /** Preserve the installed Node resolution layout, including nested versions. */
  dependencies: Array<VerifiedHostPackage & { mount: string }>;
  entry: string;
  /** Pin the interpreter too; it must be runnable without its former install tree.
   * OS shared libraries remain an external prerequisite, not bundled dependencies.
   */
  node: { path: string; sha256: string; mode: number };
}
export interface PinnedHostBundle {
  digest: string;
  root: string;
  packageRoot: string;
  entryPath: string;
  nodePath: string;
  assetsRoot: string;
  manifestPath: string;
}
interface BundleFile extends VerifiedHostFile { link?: string }
interface Manifest { schema: 1; entry: string; files: BundleFile[] }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const isInside = (root: string, child: string) => child === root || child.startsWith(root + path.sep);
const validHash = (value: string) => /^[a-f0-9]{64}$/.test(value);
function relative(value: string): string {
  if (!value || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')
    || /[\x00-\x1f\x7f:]/.test(value) || path.posix.isAbsolute(value)) throw new Error('Invalid bundle-relative path.');
  return value;
}
function checkFile(file: VerifiedHostFile): void {
  relative(file.path);
  if (!validHash(file.sha256) || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) {
    throw new Error('Invalid verified file digest or mode.');
  }
}
function sealedMode(mode: number): number { return 0o444 | (mode & 0o111); }

/** Hash through an opened regular file; symlink resolution is checked by the caller. */
async function readVerified(source: string, expected: VerifiedHostFile, destination?: string): Promise<void> {
  const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: fs.FileHandle | undefined;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size > 512 * 1024 * 1024 || (before.mode & 0o777) !== expected.mode) {
      throw new Error('Bundle input is not a bounded regular file with the verified mode.');
    }
    if (destination) output = await fs.open(destination, 'wx', 0o600);
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(128 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      if (position > 512 * 1024 * 1024) throw new Error('Bundle file exceeds size limit.');
      digest.update(buffer.subarray(0, bytesRead));
      if (output) await output.writeFile(buffer.subarray(0, bytesRead));
    }
    const after = await input.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || digest.digest('hex') !== expected.sha256) {
      throw new Error('Bundle input integrity mismatch.');
    }
    if (output) { await output.chmod(sealedMode(expected.mode)); await output.sync(); }
  } finally { await output?.close(); await input.close(); }
}
async function regularTree(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await regularTree(root, name));
    else if (entry.isFile() || entry.isSymbolicLink()) result.push(name);
    else throw new Error('Published bundles cannot contain special files.');
  }
  return result.sort();
}
async function sourceInventory(root: string, prefix = ''): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (!prefix && entry.name === 'node_modules') continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...await sourceInventory(root, name));
    else names.push(name); // Links are validated against explicit targets below.
  }
  return names.sort();
}
async function syncDirectories(root: string): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncDirectories(path.join(root, entry.name));
  }
  const directory = await fs.open(root, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
function describe(root: string, digest: string, entry: string): PinnedHostBundle {
  return { digest, root, packageRoot: path.join(root, 'package'), assetsRoot: path.join(root, 'package'),
    entryPath: path.join(root, 'package', entry), nodePath: path.join(root, 'runtime', 'node'),
    manifestPath: path.join(root, 'manifest.json') };
}

/** Full verification is required on reuse; a directory name is not an integrity receipt. */
export async function verifyPinnedHostBundle(root: string, expectedDigest: string): Promise<PinnedHostBundle> {
  if (process.platform === 'win32') throw new Error('Pinned session host launch is unsupported on Windows.');
  if (!validHash(expectedDigest) || await fs.realpath(root) !== path.resolve(root)) throw new Error('Invalid pinned bundle root.');
  const manifestPath = path.join(root, 'manifest.json');
  const stat = await fs.lstat(manifestPath);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid bundle manifest.');
  const encoded = await fs.readFile(manifestPath, 'utf8');
  if (hash(encoded) !== expectedDigest) throw new Error('Pinned bundle manifest integrity mismatch.');
  const manifest = JSON.parse(encoded) as Manifest;
  if (manifest.schema !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported bundle manifest.');
  relative(manifest.entry);
  const names = manifest.files.map(file => { checkFile(file); return file.path; });
  if (new Set(names).size !== names.length || !names.includes(`package/${manifest.entry}`) || !names.includes('runtime/node')) {
    throw new Error('Incomplete bundle manifest.');
  }
  if (JSON.stringify(await regularTree(root)) !== JSON.stringify([...names, 'manifest.json'].sort())) throw new Error('Pinned bundle inventory mismatch.');
  for (const file of manifest.files) {
    const filename = path.join(root, file.path);
    const stat = await fs.lstat(filename);
    if (file.link) {
      relative(file.link);
      if (!stat.isSymbolicLink() || !names.includes(file.link) || await fs.realpath(filename) !== path.join(root, file.link)) throw new Error('Pinned bundle link integrity mismatch.');
    } else if (!stat.isFile()) throw new Error('Unexpected pinned bundle symlink.');
    await readVerified(file.link ? path.join(root, file.link) : filename, { ...file, mode: sealedMode(file.mode) });
  }
  return describe(root, expectedDigest, manifest.entry);
}

/** Never mutates a published bundle. Staging and atomic rename tolerate concurrent
 * preparations; the loser verifies the winner rather than replacing it. No GC.
 */
export async function preparePinnedHostBundle(input: PinnedHostBundleInput): Promise<PinnedHostBundle> {
  if (process.platform === 'win32') throw new Error('Pinned session host launch is unsupported on Windows.');
  relative(input.entry);
  const mounts = new Map<string, VerifiedHostPackage>([['package', input.package]]);
  for (const dependency of input.dependencies) {
    relative(dependency.mount);
    if (!/^(node_modules\/(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+)(\/node_modules\/(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+)*$/.test(dependency.mount)) {
      throw new Error('Invalid dependency mount.');
    }
    const mount = `package/${dependency.mount}`;
    if (mounts.has(mount)) throw new Error('Duplicate dependency mount.');
    mounts.set(mount, dependency);
  }
  const sources = new Map<string, { source: string; file: VerifiedHostFile; link?: string }>();
  const roots: string[] = [];
  for (const [mount, pkg] of mounts) {
    const root = await fs.realpath(pkg.root); // Explicit workspace package roots may be links.
    roots.push(root);
    const allowed = new Set(pkg.files.map(file => file.path));
    if (!allowed.has('package.json') || allowed.size !== pkg.files.length) throw new Error('Incomplete or duplicate package inventory.');
    for (const file of pkg.files) {
      checkFile(file);
      if (file.path.split('/').includes('node_modules')) throw new Error('Dependencies require separate verified inputs.');
      const filename = path.join(root, file.path);
      // Directory links are not traversed. File links retain Node realpath/module
      // identity only when their resolved target is explicitly inventoried.
      if (await fs.realpath(path.dirname(filename)) !== path.dirname(filename)) throw new Error('Directory symlink in package inventory.');
      const source = await fs.realpath(filename);
      const target = path.relative(root, source).split(path.sep).join('/');
      if (!isInside(root, source) || !allowed.has(target)) throw new Error('Unproven package symlink target.');
      sources.set(`${mount}/${file.path}`, { source, file, ...(source !== filename ? { link: `${mount}/${target}` } : {}) });
    }
    if (JSON.stringify(await sourceInventory(root)) !== JSON.stringify([...allowed].sort())) throw new Error('Package inventory is incomplete or contains unverified files.');
  }
  if (!sources.has(`package/${input.entry}`)) throw new Error('Host entry is missing from verified inventory.');
  // Validate the entire required dependency closure at the preserved Node lookup
  // locations. Optional omissions are explicit; peer dependencies are included.
  for (const [mount, pkg] of mounts) {
    const source = sources.get(`${mount}/package.json`)!;
    await readVerified(source.source, source.file);
    const text = await fs.readFile(source.source, 'utf8');
    if (hash(text) !== source.file.sha256) throw new Error('Package metadata changed during verification.');
    const metadata = JSON.parse(text);
    if (mount !== 'package' && metadata.bin) {
      const bins = typeof metadata.bin === 'string' ? { [String(metadata.name).split('/').pop()!]: metadata.bin } : metadata.bin;
      for (const [name, value] of Object.entries(bins)) {
        if (!/^[a-zA-Z0-9_.-]+$/.test(name) || typeof value !== 'string') throw new Error('Invalid dependency executable.');
        const target = `${mount}/${relative(value.replace(/^\.\//, ''))}`;
        const item = sources.get(target);
        if (!item || item.link || !(item.file.mode & 0o111)) throw new Error('Dependency executable is not a verified executable regular file.');
        const bin = `${mount.slice(0, mount.lastIndexOf('/node_modules/'))}/node_modules/.bin/${name}`;
        if (sources.has(bin)) throw new Error('Ambiguous dependency executable binding.');
        sources.set(bin, { ...item, link: target });
      }
    }
    const required = { ...metadata.dependencies, ...metadata.peerDependencies, ...metadata.optionalDependencies };
    for (const name of Object.keys(required)) {
      if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid dependency name.');
      let cursor = mount;
      let found = false;
      while (cursor.startsWith('package')) {
        if (mounts.has(`${cursor}/node_modules/${name}`)) { found = true; break; }
        const index = cursor.lastIndexOf('/node_modules/');
        if (index < 0) break;
        cursor = cursor.slice(0, index);
      }
      const optional = Object.hasOwn(metadata.optionalDependencies ?? {}, name) || metadata.peerDependenciesMeta?.[name]?.optional === true;
      if (!found && !(optional && pkg.omittedOptionalDependencies?.includes(name))) throw new Error(`Missing verified runtime dependency: ${name}`);
    }
  }
  const nodeFile: VerifiedHostFile = { path: 'runtime/node', sha256: input.node.sha256, mode: input.node.mode };
  checkFile(nodeFile);
  if (!(input.node.mode & 0o111)) throw new Error('Pinned Node runtime must be executable.');
  sources.set('runtime/node', { source: await fs.realpath(input.node.path), file: nodeFile });
  await fs.mkdir(input.storeRoot, { recursive: true, mode: 0o700 });
  const store = await fs.realpath(input.storeRoot);
  if (store.split(path.sep).includes('node_modules') || roots.some(root => isInside(root, store) || isInside(store, root))) throw new Error('Bundle store must be separate from package inputs.');
  const storeStat = await fs.stat(store);
  if ((storeStat.mode & 0o077) || storeStat.uid !== process.getuid?.()) throw new Error('Bundle store must be private and owned by the current user.');
  const manifest: Manifest = { schema: 1, entry: input.entry, files: [...sources.entries()]
    .map(([name, value]) => ({ path: name, sha256: value.file.sha256, mode: value.file.mode, ...(value.link ? { link: value.link } : {}) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  const encoded = JSON.stringify(manifest);
  const digest = hash(encoded);
  const destination = path.join(store, digest);
  let present = false;
  try { await fs.lstat(destination); present = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (present) return verifyPinnedHostBundle(destination, digest);
  const staging = await fs.mkdtemp(path.join(store, '.prepare-'));
  try {
    for (const [name, { source, file, link }] of sources) {
      const output = path.join(staging, name);
      await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      if (link) {
        await readVerified(source, file);
        await fs.symlink(path.relative(path.dirname(output), path.join(staging, link)), output);
      } else await readVerified(source, file, output);
    }
    const manifestFile = await fs.open(path.join(staging, 'manifest.json'), 'wx', 0o400);
    try { await manifestFile.writeFile(encoded); await manifestFile.sync(); } finally { await manifestFile.close(); }
    await verifyPinnedHostBundle(staging, digest);
    await syncDirectories(staging);
    try { await fs.rename(staging, destination); }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    const directory = await fs.open(store, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return await verifyPinnedHostBundle(destination, digest);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

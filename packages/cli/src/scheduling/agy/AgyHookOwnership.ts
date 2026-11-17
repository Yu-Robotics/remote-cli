import fs, { constants } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { kernelGate, ownerRecord, encodeOwner, assertRecoverable, ProcessJournal, withProcessJournal,
  syncDirectory, type KernelGate } from '../../delegation/OwnershipRuntime';

const GROUP = 'remote-cli-native-schedule';
const LIMIT = 4 * 1024 * 1024;
const MAX_CONFIG = 256 * 1024;
type Identity = { dev: number; ino: number };
type Snapshot = { kind: 'absent' } | { kind: 'file' | 'link'; identity: Identity; text: string; link?: string };
interface Transaction {
  version: 1; token: string; owner: string; root: Identity; gemini: Identity; directory: Identity;
  private: Identity; directoryLink?: { identity: Identity; link: string };
  original: Snapshot; installed: Snapshot; restored?: Snapshot;
  sharedEntries: string[]; privateFiles: Record<string, Identity>;
}
export interface AgyHookLease {
  (): Promise<void>;
  /** Nested journals retain the enclosing delegated-worker ownership proof. */
  run<T>(callback: () => T): T;
}
export class AgyHookOwnershipError extends Error {
  constructor(readonly category: 'active' | 'unknown' | 'changed' | 'unavailable') {
    super(category === 'active'
      ? 'AGY hook ownership is still active. Wait for the exact previous host and its process group to exit, then retry after explicit /clear.'
      : category === 'unknown'
        ? 'AGY hook ownership cannot be proved. Preserve this thread or worker lane and its native history; use a new thread or worker lane. A prior overlay without ownership metadata requires operator inspection, not automatic deletion.'
        : category === 'changed'
          ? 'AGY hook configuration or ownership evidence changed. Preserve the files and use a new thread or worker lane; automatic overlay replacement was refused.'
          : 'AGY hook ownership locking is unavailable. Install the matching remote-cli native dependencies before retrying; no unsafe overlay replacement is enabled.');
    this.name = 'AgyHookOwnershipError';
  }
}
const identity = (s: fs.Stats): Identity => ({ dev: s.dev, ino: s.ino });
const equal = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
function stat(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
function directory(file: string, expected?: Identity): Identity {
  const s = fs.lstatSync(file);
  if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(file) !== file || expected && !equal(s, expected)) throw new AgyHookOwnershipError('changed');
  return identity(s);
}
function read(file: string): string {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > LIMIT) throw new AgyHookOwnershipError('changed');
  const fd = fs.openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!equal(fs.fstatSync(fd), s)) throw new AgyHookOwnershipError('changed');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
function snapshot(file: string): Snapshot {
  const s = stat(file);
  if (!s) return { kind: 'absent' };
  if (s.size > MAX_CONFIG) throw new AgyHookOwnershipError('changed');
  if (s.isSymbolicLink()) {
    if (fs.statSync(file).size > MAX_CONFIG) throw new AgyHookOwnershipError('changed');
    return { kind: 'link', identity: identity(s), link: fs.readlinkSync(file), text: fs.readFileSync(file, 'utf8') };
  }
  return { kind: 'file', identity: identity(s), text: read(file) };
}
function matches(file: string, expected: Snapshot): boolean {
  const s = stat(file);
  if (expected.kind === 'absent') return !s;
  if (!s || !equal(s, expected.identity)) return false;
  return expected.kind === 'link' ? s.isSymbolicLink() && fs.readlinkSync(file) === expected.link
    : s.isFile() && !s.isSymbolicLink() && read(file) === expected.text;
}
function write(file: string, text: string): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function groups(text: string): Record<string, unknown> {
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgyHookOwnershipError('changed');
  return value;
}
function save(file: string, value: Transaction): void {
  const text = JSON.stringify(value);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    write(temp, JSON.stringify({ value, checksum: createHash('sha256').update(text).digest('hex') }));
    fs.renameSync(temp, file); syncDirectory(path.dirname(file));
  } finally { if (stat(temp)) fs.unlinkSync(temp); }
}
function load(file: string): Transaction {
  try {
    const { value, checksum } = JSON.parse(read(file));
    const validIdentity = (id: Identity) => id && Number.isFinite(id.dev) && Number.isFinite(id.ino);
    const validSnapshot = (entry: Snapshot) => entry && (entry.kind === 'absent' || ['file', 'link'].includes(entry.kind)
      && 'identity' in entry && validIdentity(entry.identity) && typeof entry.text === 'string'
      && (entry.kind !== 'link' || typeof entry.link === 'string'));
    if (!value || value.version !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.token)
      || !Array.isArray(value.sharedEntries) || value.sharedEntries.some((name: unknown) => typeof name !== 'string' || name !== path.basename(name))
      || !value.privateFiles || typeof value.privateFiles !== 'object' || !Object.values(value.privateFiles).every(id => validIdentity(id as Identity))
      || typeof value.owner !== 'string' || ![value.root, value.gemini, value.directory, value.private].every(validIdentity)
      || !validSnapshot(value.original) || !validSnapshot(value.installed) || value.installed.kind !== 'file'
      || value.restored && !validSnapshot(value.restored)
      || value.directoryLink && (!validIdentity(value.directoryLink.identity) || typeof value.directoryLink.link !== 'string')
      || checksum !== createHash('sha256').update(JSON.stringify(value)).digest('hex')) throw new Error();
    return value;
  } catch { throw new AgyHookOwnershipError('unknown'); }
}
/** Restore only a recorded overlay, never infer ownership from its group name. */
function restore(root: string, gate: KernelGate, transaction: Transaction): void {
  const t = transaction;
  const config = path.join(root, '.gemini', 'config');
  const privateDir = path.join(root, `.remote-cli-agy-hooks-${t.token}`);
  const metadata = path.join(root, '.remote-cli-agy-hooks.owner.json');
  const backup = path.join(privateDir, 'config-link');
  const verify = () => { gate.verify(); directory(root, t.root); directory(path.dirname(config), t.gemini); directory(privateDir, t.private);
    if (JSON.stringify(load(metadata)) !== JSON.stringify(t)) throw new AgyHookOwnershipError('changed'); };
  verify();
  const linksUnchanged = (folder: string): boolean => {
    const entries = fs.readdirSync(folder);
    if (!t.directoryLink || entries.length !== t.sharedEntries.length || entries.some(name => !t.sharedEntries.includes(name))) return false;
    const source = fs.realpathSync(path.resolve(path.dirname(config), t.directoryLink.link));
    return entries.every(name => fs.lstatSync(path.join(folder, name)).isSymbolicLink()
      && fs.readlinkSync(path.join(folder, name)) === path.join(source, name));
  };
  const current = stat(config);
  const detached = path.join(privateDir, 'detached-config');
  if (!current && stat(detached)) {
    directory(detached, t.directory);
    if (!linksUnchanged(detached)) {
      // Preserve edits made to the detached directory during interrupted
      // restoration rather than deleting them with the transaction scratchpad.
      fs.renameSync(detached, config); syncDirectory(path.dirname(config));
      return restore(root, gate, t);
    }
  }
  if (t.directoryLink && (!current || current.isSymbolicLink())) {
    // Installation may have died between the two directory renames. Only the
    // recorded link inode can be put back; a replacement symlink is unknown.
    if (!current) {
      const saved = fs.lstatSync(backup);
      if (!saved.isSymbolicLink() || !equal(saved, t.directoryLink.identity) || fs.readlinkSync(backup) !== t.directoryLink.link) throw new AgyHookOwnershipError('changed');
      fs.renameSync(backup, config); syncDirectory(path.dirname(config));
    } else if (!equal(current, t.directoryLink.identity) || fs.readlinkSync(config) !== t.directoryLink.link) throw new AgyHookOwnershipError('changed');
  } else {
    directory(config, t.directory);
    const target = path.join(config, 'hooks.json');
    if (!(t.restored && matches(target, t.restored)) && !matches(target, t.original)) {
      const entry = fs.lstatSync(target);
      if (t.installed.kind !== 'file' || !equal(entry, t.installed.identity) || !entry.isFile() || entry.isSymbolicLink()) throw new AgyHookOwnershipError('changed');
      const text = read(target);
      const actual = groups(text); const installed = groups(t.installed.text);
      if (JSON.stringify(actual[GROUP]) !== JSON.stringify(installed[GROUP])) throw new AgyHookOwnershipError('changed');
      delete actual[GROUP];
      // In-place edits to unrelated groups survive. Restore original links/text
      // only when the whole installed document is unchanged.
      const desired = text === t.installed.text ? t.original : { kind: 'file' as const, text: JSON.stringify(actual, null, 2) + '\n' };
      const temp = path.join(config, `.hooks-${t.token}.restore`);
      if (stat(temp)) {
        if (!t.restored || t.restored.kind !== desired.kind || t.restored.kind !== 'absent' && (desired.kind === 'absent' || t.restored.text !== desired.text) || !matches(temp, t.restored)) throw new AgyHookOwnershipError('changed');
      } else {
        if (desired.kind === 'link') fs.symlinkSync(desired.link!, temp);
        else if (desired.kind === 'file') write(temp, desired.text);
        t.restored = desired.kind === 'absent' ? { kind: 'absent' } : snapshot(temp);
      }
      save(metadata, t); verify(); directory(config, t.directory);
      if (!equal(fs.lstatSync(target), entry) || read(target) !== text) throw new AgyHookOwnershipError('changed');
      if (desired.kind === 'absent') fs.unlinkSync(target); else fs.renameSync(temp, target);
      syncDirectory(config);
    }
    if (t.directoryLink) {
      const unchanged = linksUnchanged(config);
      if (unchanged) {
        const saved = fs.lstatSync(backup);
        if (!saved.isSymbolicLink() || !equal(saved, t.directoryLink.identity) || fs.readlinkSync(backup) !== t.directoryLink.link) throw new AgyHookOwnershipError('changed');
        verify(); directory(config, t.directory);
        fs.renameSync(config, path.join(privateDir, 'detached-config'));
        syncDirectory(path.dirname(config));
        fs.renameSync(backup, config); syncDirectory(path.dirname(config));
      }
    }
  }
  verify();
  // Remove metadata first: an interrupted private-directory cleanup cannot be
  // mistaken for an active overlay. The stable kernel gate is NEVER unlinked.
  fs.unlinkSync(metadata); syncDirectory(root);
  // Never recursively sweep this scratchpad: unexpected files or user edits
  // remain untouched even after the owned overlay itself has been restored.
  for (const name of fs.readdirSync(privateDir)) {
    const file = path.join(privateDir, name), entry = fs.lstatSync(file);
    if (['config', 'detached-config'].includes(name) && entry.isDirectory() && equal(entry, t.directory) && linksUnchanged(file)) {
      for (const child of t.sharedEntries) fs.unlinkSync(path.join(file, child));
      fs.rmdirSync(file);
    } else if (name === 'config-link' && t.directoryLink && entry.isSymbolicLink()
      && equal(entry, t.directoryLink.identity) && fs.readlinkSync(file) === t.directoryLink.link) fs.unlinkSync(file);
    else if (entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1
      && t.privateFiles[name] && equal(entry, t.privateFiles[name])) fs.unlinkSync(file);
  }
  if (!fs.readdirSync(privateDir).length) fs.rmdirSync(privateDir);
  syncDirectory(root);
}
function assertJoined(journal: string, token: string): void {
  const bytes = read(journal);
  if (!bytes.endsWith('\n')) throw new AgyHookOwnershipError('unknown');
  const lines = bytes.trimEnd().split('\n');
  if (lines.shift() !== token) throw new AgyHookOwnershipError('unknown');
  const pending = new Set<string>();
  for (const line of lines) {
    const row = JSON.parse(line);
    if (row.event === 'reserve' && !pending.has(row.id)) pending.add(row.id);
    else if (row.event === 'spawn' && pending.has(row.id)) continue;
    else if (row.event === 'absent' && pending.has(row.id)) pending.delete(row.id);
    else throw new AgyHookOwnershipError('unknown');
  }
  if (pending.size) throw new AgyHookOwnershipError('active');
}

/** Per-HOME kernel exclusion plus durable group journal. Parent death releases
 * the lock, but NEVER discharges a child-group obligation. No session is loaded. */
export function ownAgyHooks(home: string, build: (privateDir: string) => Record<string, unknown>): AgyHookLease {
  const root = fs.realpathSync(home); directory(root);
  let gate: KernelGate | undefined;
  try { gate = kernelGate(path.join(root, '.remote-cli-agy-hooks.gate')); }
  catch (error) { throw new AgyHookOwnershipError(error instanceof Error && /[Uu]nsafe|identity|entry/.test(error.message) ? 'changed' : 'unavailable'); }
  if (!gate) throw new AgyHookOwnershipError('active');
  const metadata = path.join(root, '.remote-cli-agy-hooks.owner.json');
  let journal: ProcessJournal | undefined;
  let t: Transaction | undefined;
  let preparation: { path: string; identity: Identity } | undefined;
  try {
    if (stat(metadata)) {
      const previous = load(metadata);
      directory(root, previous.root); directory(path.join(root, '.gemini'), previous.gemini);
      directory(path.join(root, `.remote-cli-agy-hooks-${previous.token}`), previous.private);
      if (JSON.parse(previous.owner).token !== previous.token) throw new AgyHookOwnershipError('unknown');
      try { assertRecoverable(Buffer.from(previous.owner), path.join(root, `.remote-cli-agy-hooks-${previous.token}`, 'processes')); }
      catch (error) { throw new AgyHookOwnershipError(error instanceof Error && /still alive|still exists|cannot be inspected/.test(error.message) ? 'active' : 'unknown'); }
      restore(root, gate, previous);
    }
    const gemini = path.join(root, '.gemini'); fs.mkdirSync(gemini, { recursive: true, mode: 0o700 }); directory(gemini);
    const config = path.join(gemini, 'config');
    const configStat = stat(config);
    const directoryLink = configStat?.isSymbolicLink() ? { identity: identity(configStat), link: fs.readlinkSync(config) } : undefined;
    if (!configStat) fs.mkdirSync(config, { mode: 0o700 });
    if (!directoryLink) directory(config);
    const original = snapshot(path.join(config, 'hooks.json'));
    const originalGroups = groups(original.kind === 'absent' ? '{}' : original.text);
    if (Object.hasOwn(originalGroups, GROUP)) throw new AgyHookOwnershipError('unknown');
    const owner = ownerRecord();
    const privateDir = path.join(root, `.remote-cli-agy-hooks-${owner.token}`);
    fs.mkdirSync(privateDir, { mode: 0o700 });
    preparation = { path: privateDir, identity: directory(privateDir) };
    const staged = path.join(privateDir, 'config');
    if (directoryLink) {
      fs.mkdirSync(staged, { mode: 0o700 });
      const source = fs.realpathSync(config);
      for (const name of fs.readdirSync(source)) fs.symlinkSync(path.join(source, name), path.join(staged, name));
      syncDirectory(staged);
    }
    const installedFile = path.join(privateDir, 'installed');
    write(installedFile, JSON.stringify({ ...originalGroups, [GROUP]: build(privateDir) }, null, 2) + '\n');
    const verify = () => { gate!.verify(); directory(root, t!.root); directory(gemini, t!.gemini); directory(privateDir, t!.private);
      if (JSON.stringify(load(metadata)) !== JSON.stringify(t)) throw new AgyHookOwnershipError('changed'); };
    journal = new ProcessJournal(path.join(privateDir, 'processes'), owner.token, verify);
    // Detached entries are new symlinks, not the original global target inode.
    t = { version: 1, token: owner.token, owner: encodeOwner(owner).toString(), root: directory(root), gemini: directory(gemini),
      directory: directory(directoryLink ? staged : config), private: directory(privateDir), directoryLink,
      original: directoryLink ? snapshot(path.join(staged, 'hooks.json')) : original, installed: snapshot(installedFile),
      sharedEntries: directoryLink ? fs.readdirSync(staged) : [],
      privateFiles: Object.fromEntries(fs.readdirSync(privateDir).filter(name => fs.lstatSync(path.join(privateDir, name)).isFile())
        .map(name => [name, identity(fs.lstatSync(path.join(privateDir, name)))])) };
    syncDirectory(privateDir); save(metadata, t);
    if (directoryLink) {
      if (!equal(fs.lstatSync(config), directoryLink.identity) || fs.readlinkSync(config) !== directoryLink.link) throw new AgyHookOwnershipError('changed');
      fs.renameSync(config, path.join(privateDir, 'config-link')); syncDirectory(gemini); syncDirectory(privateDir);
      fs.renameSync(staged, config); syncDirectory(gemini);
    }
    verify(); directory(config, t.directory);
    if (!matches(path.join(config, 'hooks.json'), t.original)) throw new AgyHookOwnershipError('changed');
    fs.renameSync(installedFile, path.join(config, 'hooks.json')); syncDirectory(config);
    let closed = false;
    const lease: AgyHookLease = Object.assign(async () => {
      if (closed) return;
      verify(); assertJoined(journal!.filename, t!.token);
      journal!.close(); restore(root, gate!, t!); closed = true; gate!.close();
    }, { run<T>(callback: () => T): T { if (closed) throw new AgyHookOwnershipError('changed'); verify(); return withProcessJournal(journal!, callback); } });
    return lease;
  } catch (error) {
    journal?.close();
    if (t) { try { restore(root, gate, t); } catch { /* Retain ambiguous filesystem evidence. */ } }
    else if (preparation) {
      try { directory(preparation.path, preparation.identity); fs.rmSync(preparation.path, { recursive: true }); syncDirectory(root); }
      catch { /* An unknown replacement is never cleanup authority. */ }
    }
    gate.close();
    if (error instanceof AgyHookOwnershipError) throw error;
    throw new AgyHookOwnershipError('changed');
  }
}

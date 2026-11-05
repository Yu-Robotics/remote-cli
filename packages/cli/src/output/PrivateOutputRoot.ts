import fs from 'fs/promises';
import { lstatSync, readlinkSync } from 'fs';
import path from 'path';
import { privateDirectory } from '../files/FileIO';

interface Identity { name: string; key: string }
function identity(name: string): Identity {
  const stat = lstatSync(name, { bigint: true });
  if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error('Unsafe output storage ancestor.');
  return { name, key: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.isSymbolicLink() ? readlinkSync(name) : 'directory'}` };
}
function ancestors(name: string): string[] {
  const result = [name];
  while (path.dirname(name) !== name) { name = path.dirname(name); result.push(name); }
  return result;
}
function verify(entries: Identity[]): void {
  try {
    for (const entry of entries) if (identity(entry.name).key !== entry.key) throw new Error('changed');
  } catch { throw new Error('Output storage identity changed.'); }
}

/** Resolve existing ancestor aliases once, without accepting an alias for the private leaf itself.
 * Canonical and configured ancestor identities remain pinned for this owner's lifetime.
 * Checks detect replacement; they do not sandbox a hostile process running as the same OS user.
 */
export class PrivateOutputRoot {
  private canonical?: string;
  private identities: Identity[] = [];
  private loading?: Promise<void>;
  constructor(private configured: string) { this.configured = path.resolve(configured); }
  initialize(): Promise<void> {
    if (this.canonical) { this.check(); return Promise.resolve(); }
    return this.loading ??= this.create();
  }
  private async create(): Promise<void> {
    let parent = path.dirname(this.configured);
    for (;;) {
      try { await fs.lstat(parent); break; }
      catch (error: any) { if (error.code !== 'ENOENT' || parent === path.dirname(parent)) throw error; parent = path.dirname(parent); }
    }
    const configuredAncestors = ancestors(parent).map(identity);
    const canonicalParent = await fs.realpath(parent);
    const pinned = [...configuredAncestors, ...ancestors(canonicalParent).map(identity)];
    verify(pinned);
    const canonical = path.join(canonicalParent, path.relative(parent, this.configured));
    // Validate the canonical spelling before mkdir/chmod; shared FileIO remains strict.
    await privateDirectory(canonical);
    verify(pinned);
    const leaf = await fs.lstat(this.configured);
    if (!leaf.isDirectory() || leaf.isSymbolicLink() || await fs.realpath(this.configured) !== canonical) throw new Error('Unsafe output storage root.');
    this.identities = [...new Set([...ancestors(this.configured), ...ancestors(canonical)])].map(identity);
    verify(pinned);
    this.canonical = canonical;
    this.check();
  }
  check = (): void => {
    if (!this.canonical) throw new Error('Output storage is not initialized.');
    verify(this.identities);
    const stat = lstatSync(this.canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw new Error('Unsafe output storage permissions.');
    }
  };
  get path(): string { this.check(); return this.canonical!; }
}

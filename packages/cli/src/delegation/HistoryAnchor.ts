import path from 'path';
import { LinuxHistoryAnchor } from './LinuxHistoryAnchor';
import { nativeBindings, type NativeBindings, type NativeHandle, type NativeStat } from '../native/NativeBindings';
import type { HistoryEntry } from './NativeHistoryFiles';
import type { NativeDirectoryIdentity } from './NativeSessionDeletion';

export interface HistoryAnchor {
  exists(file: string): Promise<boolean>;
  remove(entry: HistoryEntry): Promise<void>;
  close(): Promise<void>;
}
export function openHistoryAnchor(scope: NativeDirectoryIdentity, entries: HistoryEntry[]): Promise<HistoryAnchor> {
  return process.platform === 'linux' ? LinuxHistoryAnchor.open(scope, entries) : NativeHistoryAnchor.open(scope, entries);
}
function matches(stat: NativeStat, entry: NativeDirectoryIdentity): boolean {
  return stat.dev === entry.dev && stat.ino === entry.ino && (!process.getuid || stat.uid === String(process.getuid()));
}
/** Ancestors are held open; every destructive operation is relative to those handles. */
export class NativeHistoryAnchor implements HistoryAnchor {
  private readonly directories = new Map<string, NativeHandle | null>();
  private closed = false;
  private constructor(private readonly scope: NativeDirectoryIdentity, private readonly native: NativeBindings) {}
  static async open(scope: NativeDirectoryIdentity, entries: HistoryEntry[]): Promise<NativeHistoryAnchor> {
    const anchor = new NativeHistoryAnchor(scope, nativeBindings());
    try {
      const root = anchor.native.openRoot(scope.path);
      anchor.directories.set(scope.path, root);
      if (!matches(anchor.native.stat(root), scope)) throw new Error('Native history scope changed');
      for (const entry of entries.filter(item => item.kind === 'directory').sort((a, b) => a.path.length - b.path.length)) {
        const parent = await anchor.parent(entry.path);
        if (!parent) { anchor.directories.set(entry.path, null); continue; }
        let child: NativeHandle;
        try { child = anchor.native.openChild(parent, path.basename(entry.path), true); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (await anchor.exists(entry.path)) throw new Error('Native directory was replaced');
          anchor.directories.set(entry.path, null); continue;
        }
        anchor.directories.set(entry.path, child);
        if (!matches(anchor.native.stat(child), entry)) throw new Error('Native directory identity changed');
      }
      for (const entry of entries) await anchor.check(entry);
      return anchor;
    } catch (error) { await anchor.close(); throw error; }
  }
  private async parent(file: string): Promise<NativeHandle | undefined> {
    if (this.closed || !path.isAbsolute(file) || path.normalize(file) !== file || !file.startsWith(this.scope.path + path.sep)) {
      throw new Error('Native entry is outside the anchored scope');
    }
    const parent = path.dirname(file);
    if (!this.directories.has(parent)) throw new Error('Native manifest is missing an ancestor');
    const held = this.directories.get(parent);
    if (!held) {
      if (await this.exists(parent)) throw new Error('Missing native directory was replaced');
      return;
    }
    return held;
  }
  async exists(file: string): Promise<boolean> {
    const parent = await this.parent(file);
    return parent !== undefined && this.native.entries(parent).includes(path.basename(file));
  }
  private async check(entry: HistoryEntry): Promise<NativeHandle | undefined> {
    const parent = await this.parent(entry.path);
    if (!parent) return;
    let handle: NativeHandle;
    try { handle = this.native.openChild(parent, path.basename(entry.path), entry.kind === 'directory'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !await this.exists(entry.path)) return; throw error; }
    try {
      const stat = this.native.stat(handle);
      if (!matches(stat, entry) || stat.kind !== entry.kind || entry.kind === 'file' &&
        (stat.nlink !== '1' || stat.size !== entry.size || stat.mtime !== entry.mtime)) throw new Error('Prepared native entry changed');
    } finally { this.native.close(handle); }
    return parent;
  }
  async remove(entry: HistoryEntry): Promise<void> {
    const parent = await this.check(entry);
    if (!parent) return;
    this.native.remove(parent, path.basename(entry.path), entry.kind === 'directory', entry);
    if (await this.exists(entry.path)) throw new Error('Native deletion has not completed');
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.directories.values()) if (handle) this.native.close(handle);
    this.directories.clear();
  }
}

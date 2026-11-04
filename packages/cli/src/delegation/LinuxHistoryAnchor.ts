import fs, { type FileHandle } from 'fs/promises';
import { constants, type BigIntStats } from 'fs';
import path from 'path';
import type { NativeDirectoryIdentity } from './NativeSessionDeletion';
import type { HistoryEntry } from './NativeHistoryFiles';

function matches(stat: BigIntStats, expected: NativeDirectoryIdentity): boolean {
  return String(stat.dev) === expected.dev && String(stat.ino) === expected.ino
    && (!process.getuid || stat.uid === BigInt(process.getuid()));
}

/**
 * Linux procfs exposes live directory descriptors for fd-relative operations in Node.
 * Each appended name is one component. Never fall back to absolute-path mutations.
 * This anchors ancestors; it does not make leaf identity comparison and unlink atomic
 * against another process running as the same OS user.
 */
export class LinuxHistoryAnchor {
  private readonly directories = new Map<string, FileHandle | null>();
  private constructor(private readonly scope: NativeDirectoryIdentity) {}

  static async open(scope: NativeDirectoryIdentity, entries: HistoryEntry[]): Promise<LinuxHistoryAnchor> {
    if (process.platform !== 'linux' || !constants.O_DIRECTORY || !constants.O_NOFOLLOW) {
      throw new Error('Anchored native deletion requires Linux directory descriptors');
    }
    const anchor = new LinuxHistoryAnchor(scope);
    try {
      await anchor.openDirectory(scope, scope.path, false);
      for (const entry of entries.filter(value => value.kind === 'directory').sort((a, b) => a.path.length - b.path.length)) {
        const parent = await anchor.parentPath(entry.path);
        if (parent === undefined) anchor.directories.set(entry.path, null);
        else await anchor.openDirectory(entry, parent, true);
      }
      // Check every entry before admitting the first destructive operation.
      for (const entry of entries) await anchor.check(entry);
      return anchor;
    } catch (error) {
      await anchor.close();
      throw error;
    }
  }

  private fdPath(handle: FileHandle): string { return `/proc/self/fd/${handle.fd}`; }

  private async verifyExposed(handle: FileHandle): Promise<void> {
    const held = await handle.stat({ bigint: true });
    const exposed = await fs.stat(this.fdPath(handle), { bigint: true });
    if (!exposed.isDirectory() || exposed.dev !== held.dev || exposed.ino !== held.ino) {
      throw new Error('Native directory descriptor is unavailable in procfs');
    }
  }

  private async assertMissing(location: string, error: unknown): Promise<void> {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Distinguish a missing leaf from unavailable procfs, including during retries.
    if (!(await fs.stat(path.dirname(location))).isDirectory()) throw new Error('Native descriptor parent is unavailable');
  }

  private async openDirectory(expected: NativeDirectoryIdentity, location: string, allowMissing: boolean): Promise<void> {
    let handle: FileHandle;
    try { handle = await fs.open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A dangling link is not a deleted directory.
        try { await fs.lstat(location); }
        catch (missing) {
          await this.assertMissing(location, missing);
          this.directories.set(expected.path, null); return;
        }
      }
      throw error;
    }
    // Retain immediately so every subsequent failure closes the descriptor.
    this.directories.set(expected.path, handle);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || !matches(stat, expected)) throw new Error('Native directory descriptor identity changed');
    await this.verifyExposed(handle);
  }

  private async parentPath(file: string): Promise<string | undefined> {
    if (!path.isAbsolute(file) || path.normalize(file) !== file || !file.startsWith(this.scope.path + path.sep)) {
      throw new Error('Native entry is outside the anchored scope');
    }
    const parent = path.dirname(file);
    if (!this.directories.has(parent)) throw new Error('Native manifest is missing an ancestor directory');
    const handle = this.directories.get(parent);
    if (!handle) {
      // Retry only a still-absent subtree; never follow a newly substituted parent.
      if (await this.exists(parent)) throw new Error('A missing native directory was replaced');
      return;
    }
    const name = path.basename(file);
    if (!name || name === '.' || name === '..' || name.includes('\0')) throw new Error('Invalid native entry name');
    await this.verifyExposed(handle);
    return `${this.fdPath(handle)}/${name}`;
  }

  async exists(file: string): Promise<boolean> {
    const location = await this.parentPath(file);
    if (location === undefined) return false;
    try { await fs.lstat(location); return true; }
    catch (error) { await this.assertMissing(location, error); return false; }
  }

  private async check(entry: HistoryEntry): Promise<string | undefined> {
    const location = await this.parentPath(entry.path);
    if (location === undefined) return;
    let stat: BigIntStats;
    try { stat = await fs.lstat(location, { bigint: true }); }
    catch (error) { await this.assertMissing(location, error); return; }
    if (!matches(stat, entry) || (entry.kind === 'directory' ? !stat.isDirectory()
      : !stat.isFile() || stat.nlink !== 1n || String(stat.size) !== entry.size || String(stat.mtimeNs) !== entry.mtime)) {
      throw new Error('Prepared native entry changed');
    }
    return location;
  }

  async remove(entry: HistoryEntry): Promise<void> {
    const location = await this.check(entry);
    if (location === undefined) return;
    if (entry.kind === 'directory') await fs.rmdir(location);
    else await fs.unlink(location);
  }

  async close(): Promise<void> {
    const handles = [...this.directories.values()].filter((handle): handle is FileHandle => handle !== null);
    this.directories.clear();
    const outcomes = await Promise.allSettled(handles.map(handle => handle.close()));
    const failure = outcomes.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

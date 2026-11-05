import fs from 'fs';
import { createHash } from 'crypto';
import path from 'path';

export type NativeHandle = object;
export interface NativeStat {
  dev: string; ino: string; size: string; mtime: string; nlink: string; uid: string;
  kind: 'file' | 'directory' | 'other';
}
export interface NativeBindings {
  openRoot(path: string): NativeHandle;
  openChild(parent: NativeHandle, name: string, directory: boolean): NativeHandle;
  openEntry(parent: NativeHandle, name: string): NativeHandle;
  stat(handle: NativeHandle): NativeStat;
  remove(parent: NativeHandle, name: string, directory: boolean, expected: { dev: string; ino: string; size: string; mtime: string }): void;
  entries(handle: NativeHandle): string[];
  read(handle: NativeHandle, limit: number): Buffer;
  readChunk(handle: NativeHandle, offset: number, limit: number): Buffer;
  openOutputChild(parent: NativeHandle, name: string, directory: boolean): NativeHandle;
  close(handle: NativeHandle): void;
  createJob(name: string): NativeHandle;
  joinJob(name: string): void;
  jobMember(handle: NativeHandle, pid: number): boolean;
  jobCount(handle: NativeHandle): number;
  terminateJob(handle: NativeHandle): void;
  processInfo(pid: number): { pid: number; group: number; session: number; state: string; birth: string };
  processIds(group: number): string[];
}
export const nativeRoot = path.resolve(__dirname, '../../native');
export const nativeBindingPath = path.join(nativeRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'managed_native.node');
let loaded: NativeBindings | undefined;
export function nativeBindings(): NativeBindings {
  if (!loaded) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(nativeBindingPath), 'manifest.json'), 'utf8'));
      if (manifest.protocol !== 1 || manifest.napi !== 8 || manifest.platform !== process.platform || manifest.arch !== process.arch
        || !/^[a-f0-9]{64}$/.test(manifest.sha256) || createHash('sha256').update(fs.readFileSync(nativeBindingPath)).digest('hex') !== manifest.sha256) {
        throw new Error('Native helper integrity or target mismatch');
      }
      loaded = require(nativeBindingPath) as NativeBindings;
    }
    catch (cause) { throw new Error('Managed native cleanup support is unavailable for this platform or architecture', { cause }); }
  }
  return loaded;
}
export function supportsNativeCleanup(): boolean {
  if (process.platform === 'linux') return true;
  if (!['darwin', 'win32'].includes(process.platform)) return false;
  try { nativeBindings(); return true; } catch { return false; }
}

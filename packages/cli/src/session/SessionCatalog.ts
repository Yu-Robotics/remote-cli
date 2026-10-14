import fs from 'fs';
import path from 'path';

/**
 * Safe, bounded metadata for one native session. Never contains transcript content,
 * native locators beyond the opaque session ID, or account/profile values.
 */
export interface SessionCatalogCandidate {
  id: string;
  name?: string;
  /** Where the record was found or which local runtime created it. */
  source: 'native-local' | 'remote-cli';
  modifiedAt: number;
  messageCount: number;
  countComplete: boolean;
}

export interface SessionCatalog {
  candidates: SessionCatalogCandidate[];
  complete: boolean;
  notes: string[];
}

/** Shared options for read-only, non-executing native metadata readers. */
export interface SessionCatalogOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  remoteCliDirectory?: string;
}

/** One locally approved native store to scan. */
export interface SessionCatalogStore {
  directory: string;
  /** Provenance recorded on candidates found here. */
  source: SessionCatalogCandidate['source'];
  /** Case-insensitive file suffix to accept. Defaults to `.jsonl`. */
  suffix?: string;
  /** Recurse up to `maxDepth` directory levels (for date-partitioned layouts). */
  maxDepth?: number;
}

/** Bounded header/record metadata scan for file readers (menu resource limit, not a history limit). */
export const SESSION_CATALOG_HEADER_BYTES = 64 * 1024;
/** Retained candidates per snapshot. */
export const SESSION_CATALOG_MAX_FILES = 200;
export const SESSION_CATALOG_MAX_ID = 128;
/** Reject records whose on-disk modification time is unverifiable or future-dated. */
export const SESSION_CATALOG_MAX_MODIFIED_SKEW_MS = 24 * 60 * 60 * 1000;
export const SESSION_CATALOG_MAX_SETTINGS_BYTES = 1024 * 1024;
/** Synthetic delegated worker and temporary metadata identities never become user history. */
export const SYNTHETIC_SESSION = /^(?:remote-cli-)?(?:delegate-lane-|settings-meta-)/;

/** Expand `~`/`~/` against an explicit home; relative values are not locally resolvable. */
export function expandHomePath(value: string, home: string): string | undefined {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return path.isAbsolute(value) ? value : undefined;
}

export function canonicalPath(value: string): string | undefined {
  try { return fs.realpathSync.native(value); } catch { return undefined; }
}

export function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Display names are untrusted: remove control/markup characters and bound length. */
export function safeSessionLabel(value: string): string | undefined {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[`*_[\]()<>#|~\\!]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

/** A bounded read of the first bytes of a regular file; never follows a symlink or throws. */
export function readBoundedHead(file: string, bytes = SESSION_CATALOG_HEADER_BYTES): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const buffer = Buffer.alloc(bytes);
    const length = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, length).toString('utf8');
  } catch { return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Bounded private regular-file identity check for native metadata we did not create. */
export function isPrivateRegularFile(stat: fs.Stats, maxBytes: number): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= maxBytes
    && (!process.getuid || stat.uid === process.getuid());
}

/** Hard cap on files examined during a recursive listing, independent of the retained cap. */
export const SESSION_CATALOG_SCAN_FILES = 20 * SESSION_CATALOG_MAX_FILES;

export type SessionCatalogGap = 'truncated' | 'unreadable';

export interface SessionCatalogScanOptions {
  maxFiles?: number;
  /** Called once per detected coverage gap, with the store that produced it. */
  onGap?: (reason: SessionCatalogGap, store: SessionCatalogStore) => void;
}

/**
 * Bounded file listing for one store. An absent directory is simply empty; an
 * existing directory that cannot be listed is a coverage gap. Recursive stores
 * are bounded by both a scan cap and a depth limit, and the retained page is the
 * newest slice of a sorted listing so a cap never silently keeps old records.
 */
function listStoreFiles(root: string, store: SessionCatalogStore, maxFiles: number,
  onGap: (reason: SessionCatalogGap) => void): string[] {
  const suffix = store.suffix ?? '.jsonl';
  const accept = (name: string): boolean => name.endsWith(suffix);
  if (!store.maxDepth) {
    let names: string[];
    try { names = fs.readdirSync(root).filter(accept).sort(); }
    catch { onGap('unreadable'); return []; }
    if (names.length > maxFiles) { onGap('truncated'); names = names.slice(-maxFiles); }
    return names.map(name => path.join(root, name));
  }
  const files: string[] = [];
  let exhausted = false;
  let unreadable = false;
  const walk = (directory: string, depth: number): void => {
    if (exhausted) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch { if (fs.existsSync(directory)) unreadable = true; return; }
    for (const entry of entries) {
      if (exhausted) return;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (depth < store.maxDepth!) walk(full, depth + 1); continue; }
      if (!entry.isFile() || !accept(entry.name)) continue;
      if (files.length >= SESSION_CATALOG_SCAN_FILES) { exhausted = true; return; }
      files.push(full);
    }
  };
  walk(root, 0);
  if (unreadable) onGap('unreadable');
  files.sort();
  if (exhausted || files.length > maxFiles) onGap('truncated');
  return files.length > maxFiles ? files.slice(-maxFiles) : files;
}

/**
 * Scan locally approved stores for candidate session metadata. This is the single
 * authority for listing bounds: canonical root validation, bounded newest-first
 * retention, ambiguous duplicate-ID exclusion and modified-at ordering. A file
 * whose reader throws is skipped, never reported as a candidate.
 */
export function scanSessionCatalogs(stores: SessionCatalogStore[],
  read: (file: string, root: string, store: SessionCatalogStore) => SessionCatalogCandidate | undefined,
  options: SessionCatalogScanOptions = {}): { candidates: SessionCatalogCandidate[]; complete: boolean; duplicates: number; unreadableStores: number } {
  const maxFiles = options.maxFiles ?? SESSION_CATALOG_MAX_FILES;
  const byId = new Map<string, SessionCatalogCandidate>();
  const duplicates = new Set<string>();
  let complete = true;
  let unreadableStores = 0;
  for (const store of stores) {
    const root = canonicalPath(store.directory);
    if (!root) {
      // An absent optional store is empty, not a coverage gap. An existing but
      // uncanonicalizable store (symlink escape, permissions) is a real gap.
      if (fs.existsSync(store.directory)) { complete = false; unreadableStores++; options.onGap?.('unreadable', store); }
      continue;
    }
    const files = listStoreFiles(root, store, maxFiles, reason => {
      complete = false;
      if (reason === 'unreadable') unreadableStores++;
      options.onGap?.(reason, store);
    });
    for (const file of files) {
      let found: SessionCatalogCandidate | undefined;
      try { found = read(file, root, store); } catch { found = undefined; }
      if (!found || found.source !== store.source) continue;
      if (byId.has(found.id)) duplicates.add(found.id);
      else byId.set(found.id, found);
    }
  }
  for (const id of duplicates) byId.delete(id);
  return {
    candidates: [...byId.values()].sort((a, b) => b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id)),
    complete: complete && duplicates.size === 0,
    duplicates: duplicates.size,
    unreadableStores,
  };
}

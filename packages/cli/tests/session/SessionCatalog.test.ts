import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SESSION_CATALOG_HEADER_BYTES,
  SESSION_CATALOG_SCAN_FILES,
  canonicalPath,
  expandHomePath,
  isInside,
  isPrivateRegularFile,
  readBoundedHead,
  safeSessionLabel,
  scanSessionCatalogs,
  type SessionCatalogCandidate,
  type SessionCatalogStore,
} from '../../src/session/SessionCatalog';

describe('shared read-only catalog primitives', () => {
  const temporary = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'session-catalog-test-')));

  it('expands only explicitly supported home forms', () => {
    expect(expandHomePath('~', '/home/example')).toBe('/home/example');
    expect(expandHomePath('~/nested', '/home/example')).toBe(path.join('/home/example', 'nested'));
    expect(expandHomePath('/absolute', '/home/example')).toBe('/absolute');
    expect(expandHomePath('relative', '/home/example')).toBeUndefined();
    expect(expandHomePath('~other/value', '/home/example')).toBeUndefined();
  });

  it('resolves canonical paths and containment without following escapes', () => {
    const root = temporary();
    try {
      const inside = path.join(root, 'nested');
      fs.mkdirSync(inside);
      expect(canonicalPath(root)).toBe(root);
      expect(canonicalPath(path.join(root, 'missing'))).toBeUndefined();
      expect(isInside(root, inside)).toBe(true);
      expect(isInside(root, root)).toBe(false);
      expect(isInside(root, path.join(root, '..', 'outside'))).toBe(false);
      expect(isInside(root, '/absolute/elsewhere')).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reads only a bounded head of a regular file and refuses symlinks', () => {
    const root = temporary();
    try {
      const file = path.join(root, 'record.jsonl');
      fs.writeFileSync(file, `${'x'.repeat(200)}\nsecond-line\n`);
      const head = readBoundedHead(file, 32);
      expect(head).toBe('x'.repeat(32));
      expect(readBoundedHead(path.join(root, 'missing'))).toBeUndefined();
      const link = path.join(root, 'link.jsonl');
      fs.symlinkSync(file, link);
      expect(readBoundedHead(link)).toBeUndefined();
      expect(SESSION_CATALOG_HEADER_BYTES).toBe(64 * 1024);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts only private bounded single-link regular files', () => {
    const root = temporary();
    try {
      const file = path.join(root, 'metadata.json');
      fs.writeFileSync(file, '{}', { mode: 0o600 });
      expect(isPrivateRegularFile(fs.lstatSync(file), 1024)).toBe(true);
      expect(isPrivateRegularFile(fs.lstatSync(file), 1)).toBe(false);
      const link = path.join(root, 'link.json');
      fs.symlinkSync(file, link);
      expect(isPrivateRegularFile(fs.lstatSync(link), 1024)).toBe(false);
      expect(isPrivateRegularFile(fs.lstatSync(root), 1024)).toBe(false);
      fs.linkSync(file, path.join(root, 'hard.json'));
      expect(isPrivateRegularFile(fs.lstatSync(file), 1024)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('scans flat and recursive stores with bounded newest retention and gap reporting', () => {
    const root = temporary();
    try {
      const flat = path.join(root, 'flat');
      const nested = path.join(root, 'nested', '2026', '01', '02');
      fs.mkdirSync(flat, { recursive: true });
      fs.mkdirSync(nested, { recursive: true });
      for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(flat, `s${i}.jsonl`), '{}');
      fs.writeFileSync(path.join(nested, 'deep.jsonl'), '{}');
      fs.writeFileSync(path.join(root, 'nested', '2026', '01', 'ignored.jsonl'), '{}');
      const gaps: string[] = [];
      const stores: SessionCatalogStore[] = [
        { directory: flat, source: 'native-local' },
        { directory: path.join(root, 'nested'), source: 'remote-cli', maxDepth: 3 },
      ];
      const found = (file: string, _root: string, store: SessionCatalogStore): SessionCatalogCandidate => ({
        id: path.basename(file, '.jsonl'), source: store.source, modifiedAt: path.basename(file).length,
        messageCount: 0, countComplete: true,
      });
      const scan = scanSessionCatalogs(stores, found, { maxFiles: 3, onGap: reason => gaps.push(reason) });
      // The flat store keeps its newest three names; the recursive store keeps
      // both of its files. Ordering is newest-modified first, id ascending.
      expect(scan.candidates.map(c => c.id)).toEqual(['ignored', 'deep', 's2', 's3', 's4']);
      expect(scan.complete).toBe(false);
      expect(scan.duplicates).toBe(0);
      expect(gaps).toEqual(['truncated']);
      // An absent store is empty; duplicate IDs across stores are hidden.
      const empty = scanSessionCatalogs([{ directory: path.join(root, 'missing'), source: 'native-local' }], found);
      expect(empty).toMatchObject({ candidates: [], complete: true, duplicates: 0 });
      const duplicate = scanSessionCatalogs([
        { directory: flat, source: 'native-local' },
        { directory: flat, source: 'native-local' },
      ], found);
      // Every ID found in both stores is ambiguous and therefore hidden.
      expect(duplicate.duplicates).toBe(5);
      expect(duplicate.candidates).toEqual([]);
      expect(duplicate.complete).toBe(false);
      // A reader that throws must not surface a candidate.
      const throwing = scanSessionCatalogs([{ directory: flat, source: 'native-local' }], () => { throw new Error('synthetic'); });
      expect(throwing.candidates).toEqual([]);
      expect(throwing.complete).toBe(true);
      // The hard scan cap stops runaway recursive listings; hitting it is a gap.
      expect(SESSION_CATALOG_SCAN_FILES).toBe(20 * 200);
      const capped = scanSessionCatalogs([{ directory: path.join(root, 'nested'), source: 'native-local', maxDepth: 99 }],
        found, { maxFiles: 1, onGap: reason => gaps.push(reason) });
      expect(capped.candidates).toHaveLength(1);
      expect(gaps).toContain('truncated');
      // A locally configured store alias is canonicalized and read.
      const alias = path.join(root, 'alias');
      fs.symlinkSync(flat, alias);
      const throughLink = scanSessionCatalogs([{ directory: alias, source: 'native-local' }], found);
      expect(throughLink.candidates.map(c => c.id)).toEqual(['s0', 's1', 's2', 's3', 's4']);
      // A dangling alias has nothing to read and is treated as an absent store,
      // never as an unreadable history that could hide records.
      const dangling = path.join(root, 'dangling');
      fs.symlinkSync(path.join(root, 'absent-target'), dangling);
      expect(scanSessionCatalogs([{ directory: dangling, source: 'native-local' }], found)).toMatchObject({
        candidates: [], complete: true, unreadableStores: 0,
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reports an unlistable existing store and a wrong-source reader result', () => {
    const root = temporary();
    try {
      const blocked = path.join(root, 'blocked');
      fs.mkdirSync(blocked);
      if (process.getuid && process.getuid() !== 0) {
        fs.chmodSync(blocked, 0o000);
        const gaps: string[] = [];
        const scan = scanSessionCatalogs([{ directory: blocked, source: 'native-local' }],
          () => undefined, { onGap: reason => gaps.push(reason) });
        fs.chmodSync(blocked, 0o700);
        expect(scan.complete).toBe(false);
        expect(scan.unreadableStores).toBe(1);
        expect(gaps).toEqual(['unreadable']);
      }
      fs.writeFileSync(path.join(blocked, 'a.jsonl'), '{}');
      const mismatched = scanSessionCatalogs([{ directory: blocked, source: 'native-local' }],
        () => ({ id: 'x', source: 'remote-cli', modifiedAt: 0, messageCount: 0, countComplete: true }));
      expect(mismatched.candidates).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('sanitizes untrusted names and bounds their length', () => {
    expect(safeSessionLabel('[link](x) <b>#title</b>\u0000')).toBe('linkx btitle/b');
    expect(safeSessionLabel('   ')).toBeUndefined();
    expect(safeSessionLabel('x'.repeat(80))).toHaveLength(60);
  });
});

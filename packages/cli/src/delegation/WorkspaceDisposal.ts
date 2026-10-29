import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';

export class WorkspaceCleanupError extends Error {
  constructor(readonly reason: string, readonly retryable = false, message = reason) { super(message); }
}

export interface WorkspaceExport { path: string; sha256: string; bytes: number }
export const WORKSPACE_EXPORT_LIMITS = { files: 16, fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 } as const;

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function relativeExport(name: string): void {
  if (typeof name !== 'string' || !name || name.length > 4096 || path.isAbsolute(name)
    || /[:\0]/.test(name) || name.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part === '.git')) {
    throw new WorkspaceCleanupError('invalid-export-path');
  }
}

/** Read one bounded regular file, checking the opened identity and settlement. */
async function readFile(root: string, file: string): Promise<Buffer> {
  if (!inside(root, file) || await fs.realpath(path.dirname(file)) !== path.dirname(file)) {
    throw new WorkspaceCleanupError('unsafe-export-path');
  }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > WORKSPACE_EXPORT_LIMITS.fileBytes) {
    throw new WorkspaceCleanupError('export-unavailable-or-oversized');
  }
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      throw new WorkspaceCleanupError('export-changed');
    }
    const data = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < data.length) {
      const chunk = await handle.read(data, size, data.length - size, null);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new WorkspaceCleanupError('export-changed');
    }
    return data.subarray(0, size);
  } finally { await handle.close(); }
}

function digest(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }

/** The caller supplies an owned canonical exports directory outside the checkout. */
export async function exportWorkspaceFiles(checkout: string, directory: string, names: readonly string[]): Promise<WorkspaceExport[]> {
  if (!Array.isArray(names) || names.length > WORKSPACE_EXPORT_LIMITS.files || new Set(names).size !== names.length) {
    throw new WorkspaceCleanupError('invalid-export-manifest');
  }
  const result: WorkspaceExport[] = [];
  let total = 0;
  for (const name of names) {
    relativeExport(name);
    const data = await readFile(checkout, path.join(checkout, name));
    total += data.length;
    if (total > WORKSPACE_EXPORT_LIMITS.totalBytes) throw new WorkspaceCleanupError('exports-too-large');
    const sha256 = digest(data);
    const file = path.join(directory, sha256);
    try {
      const existing = await readFile(directory, file);
      if (digest(existing) !== sha256) throw new WorkspaceCleanupError('export-storage-changed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const temporary = path.join(directory, `${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); }
      finally { await handle.close(); }
      try { await fs.rename(temporary, file); }
      finally { await fs.rm(temporary, { force: true }); }
    }
    result.push({ path: name, sha256, bytes: data.length });
  }
  return result;
}

export async function verifyWorkspaceExports(directory: string, entries: WorkspaceExport[], checkout?: string): Promise<void> {
  if (!Array.isArray(entries) || entries.length > WORKSPACE_EXPORT_LIMITS.files) throw new WorkspaceCleanupError('invalid-export-manifest');
  const names = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    relativeExport(entry.path);
    if (names.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0 || entry.bytes > WORKSPACE_EXPORT_LIMITS.fileBytes) throw new WorkspaceCleanupError('invalid-export-manifest');
    names.add(entry.path);
    total += entry.bytes;
    if (total > WORKSPACE_EXPORT_LIMITS.totalBytes) throw new WorkspaceCleanupError('exports-too-large');
    const saved = await readFile(directory, path.join(directory, entry.sha256));
    if (saved.length !== entry.bytes || digest(saved) !== entry.sha256) throw new WorkspaceCleanupError('export-storage-changed');
    if (checkout) {
      const current = await readFile(checkout, path.join(checkout, entry.path));
      if (current.length !== entry.bytes || digest(current) !== entry.sha256) throw new WorkspaceCleanupError('export-changed');
    }
  }
}

/** Linux bind mounts can share st_dev, so device comparisons alone are insufficient. */
export async function mountedPaths(): Promise<string[]> {
  if (process.platform !== 'linux') return [];
  const handle = await fs.open('/proc/self/mountinfo', 'r');
  try {
    const data = Buffer.alloc(4 * 1024 * 1024 + 1);
    let count = 0;
    while (count < data.length) {
      const next = await handle.read(data, count, data.length - count, null);
      if (!next.bytesRead) break;
      count += next.bytesRead;
    }
    if (count === data.length) throw new WorkspaceCleanupError('mount-inventory-incomplete');
    return data.subarray(0, count).toString('utf8').split('\n').filter(Boolean).map(line => {
      const value = line.split(' ')[4];
      if (!value || !line.includes(' - ')) throw new WorkspaceCleanupError('mount-inventory-incomplete');
      return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    });
  } finally { await handle.close(); }
}

/** Inspect boundaries without following links or treating ignored names as trusted. */
export async function assertDisposableTree(root: string, mounts?: readonly string[]): Promise<void> {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root) {
    throw new WorkspaceCleanupError('unsafe-checkout-path');
  }
  const mounted = mounts ?? await mountedPaths();
  if (mounted.some(mount => inside(root, path.resolve(mount)))) throw new WorkspaceCleanupError('mounted-checkout');
  let count = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 128) throw new WorkspaceCleanupError('checkout-inventory-incomplete');
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== rootStat.dev || await fs.realpath(directory) !== directory) {
      throw new WorkspaceCleanupError('unsafe-checkout-boundary');
    }
    const handle = await fs.opendir(directory);
    const names = new Set<string>();
    for await (const entry of handle) {
      if (++count > 500_000) throw new WorkspaceCleanupError('checkout-inventory-incomplete');
      names.add(entry.name.toLowerCase());
      if (names.has('head') && names.has('objects') && names.has('refs')) {
        throw new WorkspaceCleanupError('nested-repository');
      }
      const file = path.join(directory, entry.name);
      const child = await fs.lstat(file);
      if (entry.name.toLowerCase() === '.git') {
        if (entry.name === '.git' && directory === root && child.isFile() && !child.isSymbolicLink()) continue;
        throw new WorkspaceCleanupError('nested-repository');
      }
      if (child.dev !== rootStat.dev) throw new WorkspaceCleanupError('unsafe-checkout-boundary');
      if (child.isSymbolicLink()) {
        // Git removes the link itself, never its target. Dependency environments
        // routinely contain ignored executable links; their targets are not owned.
        continue;
      } else if (child.isDirectory()) await walk(file, depth + 1);
      else if (!child.isFile()) throw new WorkspaceCleanupError('unsupported-checkout-entry');
    }
  };
  await walk(root, 0);
}

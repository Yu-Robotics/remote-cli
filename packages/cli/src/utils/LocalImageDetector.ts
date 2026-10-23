import { constants, type Stats } from 'fs';
import { lstat, open, realpath } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import type { DirectoryGuard } from '../security/DirectoryGuard';
import { MAX_IMAGE_BYTES, sniffImageMime } from './ImageValidation';

export { MAX_IMAGE_BYTES } from './ImageValidation';

export interface LocalImage {
  path: string;
  data: string;
  mimeType: string;
}

export type DetectedLocalImage = LocalImage;

const MAX_CANDIDATE_ATTEMPTS = 32;
const MAX_ACTIVE_READS = 4;
const READ_DEADLINE_MS = 15_000;
let activeReads = 0;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.ico']);
type ImagePolicy = DirectoryGuard | ((candidate: string, cwd: string) => boolean);

function isLocalPath(candidate: string): boolean {
  return !!candidate.trim() && !candidate.includes('\0') && !candidate.startsWith('//')
    && !candidate.startsWith('\\\\')
    && (!/^[a-z][a-z0-9+.-]*:/i.test(candidate) || /^[a-z]:[\\/]/i.test(candidate));
}

function trimCandidate(candidate: string): string {
  return candidate.trim().replace(/[.,;:!?]+$/, '').replace(/\\([\\!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/g, '$1');
}

function isImageCandidate(candidate: string): boolean {
  return isLocalPath(candidate) && IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase());
}

function addCandidate(candidates: Set<string>, candidate: string): void {
  const normalized = trimCandidate(candidate);
  if (isImageCandidate(normalized)) candidates.add(normalized);
}

function normalizeReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Extract at most 32 candidate attempts, including invalid and duplicate destinations. */
export function extractLocalImagePaths(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  const candidates = new Set<string>();
  const references = new Map<string, string>();
  const referenceDefinitionPattern = /^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|(\S+))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)]*\)))?[ \t]*$/gm;
  const markdownImagePattern = /!\[([^\]]*)\](?:\(\s*(?:<([^>\r\n]+)>|((?:\\.|[^\s)\\])+))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)]*\)))?[ \t]*\)|\[([^\]]*)\]|(?!\(|\[))/g;
  const pathPattern = /(?:^|[\s"'`])((?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/])?[^\s"'`<>()[\],;]+\.(?:jpe?g|png|webp|gif|bmp|tiff?|ico))(?=$|[\s"'`<>()[\],;.?!])/gim;
  const markdownSpans: Array<{ start: number; end: number }> = [];
  let definitions = 0;
  let attempts = 0;

  for (const match of text.matchAll(referenceDefinitionPattern)) {
    references.set(normalizeReferenceLabel(match[1]), match[2] ?? match[3]);
    if (++definitions >= MAX_CANDIDATE_ATTEMPTS) break;
  }
  for (const match of text.matchAll(markdownImagePattern)) {
    const start = match.index ?? 0;
    markdownSpans.push({ start, end: start + match[0].length });
    const destination = match[2] ?? match[3] ?? references.get(normalizeReferenceLabel(match[4] || match[1]));
    if (destination) addCandidate(candidates, destination);
    if (++attempts >= MAX_CANDIDATE_ATTEMPTS) return [...candidates];
  }
  for (const match of text.matchAll(pathPattern)) {
    const candidateStart = (match.index ?? 0) + match[0].length - match[1].length;
    if (markdownSpans.some(span => candidateStart >= span.start && candidateStart < span.end)) continue;
    const precedingText = text.slice(0, candidateStart);
    if (precedingText.lastIndexOf('<') <= precedingText.lastIndexOf('>')) addCandidate(candidates, match[1]);
    if (++attempts >= MAX_CANDIDATE_ATTEMPTS) break;
  }

  return [...candidates];
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function sameFile(left: Stats, right: Stats): boolean {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readBoundedPath(
  candidate: string, cwd: string, policy: ImagePolicy, expired: () => boolean,
): Promise<DetectedLocalImage | null> {
  const allowed = typeof policy === 'function' ? policy : (value: string, base: string) => policy.isSafePath(value, base);
  if (!allowed(candidate, cwd)) return null;
  const resolvedPath = typeof policy === 'function'
    ? path.resolve(cwd, candidate.startsWith('~/') ? path.join(homedir(), candidate.slice(2)) : candidate)
    : policy.normalizePath(candidate, cwd);
  const canonicalPath = await realpath(resolvedPath);
  if (expired()) return null;
  if (typeof policy === 'function') {
    // Legacy callbacks cannot expose configured roots; require canonical approval too.
    if (!allowed(canonicalPath, cwd)) return null;
  } else {
    let insideRoot = false;
    for (const root of policy.getAllowedDirectories()) {
      if (expired()) return null;
      try {
        const canonicalRoot = await realpath(policy.normalizePath(root, cwd));
        if (expired()) return null;
        if (contains(canonicalRoot, canonicalPath)) { insideRoot = true; break; }
      } catch { /* A missing configured root cannot authorize a file. */ }
    }
    if (!insideRoot) return null;
  }
  const beforeOpen = await lstat(canonicalPath);
  if (expired() || !beforeOpen.isFile() || beforeOpen.size <= 0 || beforeOpen.size > MAX_IMAGE_BYTES) return null;
  const handle = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (expired()) return null;
    const before = await handle.stat();
    if (expired() || !sameFile(beforeOpen, before)) return null;
    const bytes = Buffer.allocUnsafe(MAX_IMAGE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      if (expired()) return null;
      const { bytesRead } = await handle.read(bytes, length, Math.min(64 * 1024, bytes.length - length), length);
      if (expired()) return null;
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (!length || length > MAX_IMAGE_BYTES || length !== before.size) return null;
    const after = await handle.stat();
    if (expired() || !sameFile(before, after)) return null;
    const currentPath = await realpath(resolvedPath);
    if (expired() || currentPath !== canonicalPath) return null;
    const current = await lstat(canonicalPath);
    if (expired() || !sameFile(after, current) || !allowed(candidate, cwd)) return null;
    const data = bytes.subarray(0, length);
    const mimeType = sniffImageMime(data);
    return mimeType ? { path: resolvedPath, data: data.toString('base64'), mimeType } : null;
  } finally {
    await handle.close();
  }
}

async function readPath(candidate: string, cwd: string, policy: ImagePolicy): Promise<DetectedLocalImage | null> {
  if (typeof candidate !== 'string' || !isLocalPath(candidate) || activeReads >= MAX_ACTIVE_READS) return null;
  activeReads++;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = readBoundedPath(candidate, cwd, policy, () => expired)
    .catch(() => null)
    .finally(() => { activeReads--; });
  const deadline = new Promise<null>(resolve => {
    timer = setTimeout(() => { expired = true; resolve(null); }, READ_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    // A timeout fences delivery, not the filesystem operation. Keep its permit
    // until the underlying operation and handle cleanup actually settle.
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read exactly one native saved path. No text parsing or extension inference. */
export async function readLocalImagePath(
  filePath: string, cwd: string, directoryGuard: DirectoryGuard,
): Promise<DetectedLocalImage | null> {
  return readPath(filePath, cwd, directoryGuard);
}

/**
 * Read detected images using a guard or the existing callback API. Prefer the
 * guard to resolve allowed-root aliases. These checks are not an OS sandbox.
 */
export async function readLocalImages(
  text: unknown,
  cwd: string,
  isAllowed: ImagePolicy,
): Promise<LocalImage[]> {
  const images: LocalImage[] = [];
  const seen = new Set<string>();

  for (const candidate of extractLocalImagePaths(text)) {
    const resolvedPath = path.resolve(cwd, candidate.startsWith('~/') ? path.join(homedir(), candidate.slice(2)) : candidate);
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);

    const image = await readPath(candidate, cwd, isAllowed);
    if (image) images.push(image);
  }

  return images;
}

import { readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';

export interface LocalImage {
  path: string;
  data: string;
  mimeType: string;
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.ico']);
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ico': 'image/x-icon',
};

function trimCandidate(candidate: string): string {
  return candidate.trim().replace(/[.,;:!?]+$/, '').replace(/\\([\\!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/g, '$1');
}

function isImageCandidate(candidate: string): boolean {
  return !/^https?:\/\//i.test(candidate) && IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase());
}

function addCandidate(candidates: Set<string>, candidate: string): void {
  const normalized = trimCandidate(candidate);
  if (isImageCandidate(normalized)) candidates.add(normalized);
}

function normalizeReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Extract standard Markdown image destinations and plain local image paths. */
export function extractLocalImagePaths(text: string): string[] {
  const candidates = new Set<string>();
  const references = new Map<string, string>();
  const referenceDefinitionPattern = /^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|(\S+))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)]*\)))?[ \t]*$/gm;
  const angleImagePattern = /!\[[^\]]*\]\(\s*<([^>\r\n]+)>(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)]*\)))?[ \t]*\)/g;
  const inlineImagePattern = /!\[[^\]]*\]\(\s*((?:\\.|[^\s)])+)(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)]*\)))?[ \t]*\)/g;
  const referenceImagePattern = /!\[([^\]]*)\]\[([^\]]*)\]/g;
  const collapsedReferencePattern = /!\[([^\]]+)\](?!\(|\[)/g;
  const pathPattern = /(?:^|[\s"'`])((?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/])?[^\s"'`<>()[\],;]+\.(?:jpe?g|png|webp|gif|bmp|tiff?|ico))(?=$|[\s"'`<>()[\],;.?!])/gim;
  const markdownDestinations: Array<{ index: number; destination: string }> = [];

  for (const match of text.matchAll(referenceDefinitionPattern)) {
    references.set(normalizeReferenceLabel(match[1]), match[2] ?? match[3]);
  }
  for (const match of text.matchAll(angleImagePattern)) {
    markdownDestinations.push({ index: match.index ?? 0, destination: match[1] });
  }
  for (const match of text.matchAll(inlineImagePattern)) {
    markdownDestinations.push({ index: match.index ?? 0, destination: match[1] });
  }
  for (const match of text.matchAll(referenceImagePattern)) {
    const label = normalizeReferenceLabel(match[2] || match[1]);
    const destination = references.get(label);
    if (destination) markdownDestinations.push({ index: match.index ?? 0, destination });
  }
  for (const match of text.matchAll(collapsedReferencePattern)) {
    const destination = references.get(normalizeReferenceLabel(match[1]));
    if (destination) markdownDestinations.push({ index: match.index ?? 0, destination });
  }
  for (const match of markdownDestinations.sort((left, right) => left.index - right.index)) {
    addCandidate(candidates, match.destination);
  }
  for (const match of text.matchAll(pathPattern)) {
    const candidateStart = (match.index ?? 0) + match[0].length - match[1].length;
    const precedingText = text.slice(0, candidateStart);
    if (precedingText.lastIndexOf('<') > precedingText.lastIndexOf('>')) continue;
    addCandidate(candidates, match[1]);
  }

  return [...candidates];
}

/** Read detected images that are allowed by the caller's directory policy. */
export async function readLocalImages(
  text: string,
  cwd: string,
  isAllowed: (candidate: string, cwd: string) => boolean,
): Promise<LocalImage[]> {
  const images: LocalImage[] = [];
  const seen = new Set<string>();

  for (const candidate of extractLocalImagePaths(text)) {
    if (!isAllowed(candidate, cwd)) continue;
    const resolvedPath = path.resolve(cwd, candidate.startsWith('~/') ? path.join(homedir(), candidate.slice(2)) : candidate);
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);

    try {
      const metadata = await stat(resolvedPath);
      if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_IMAGE_BYTES) continue;
      const data = (await readFile(resolvedPath)).toString('base64');
      const mimeType = IMAGE_MIME_TYPES[path.extname(resolvedPath).toLowerCase()];
      if (mimeType) images.push({ path: resolvedPath, data, mimeType });
    } catch {
      // Tool output can contain paths that no longer exist; ignore them quietly.
    }
  }

  return images;
}

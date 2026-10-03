import fs from 'fs/promises';
import path from 'path';
import { compareNoticeVersions, validNoticeVersion } from './Version';

export const NOTICE_INTRODUCTION_VERSION = '1.6.123';
export const NOTICE_PAGE_BYTES = 20 * 1024;
export interface ReleaseSection { version: string; text: string }
export interface ReleaseIndex { format: 1; firstVersion: string; sections: ReleaseSection[] }
export interface ReleasePage {
  coverage: 'complete' | 'partial' | 'unavailable';
  sections: ReleaseSection[];
  offset: number;
  nextOffset?: number;
  totalSections: number;
}

/** Top-level headings inside fenced examples are not releases. Historical summaries are ignored. */
export function parseReleaseNotes(markdown: string): ReleaseSection[] {
  const result: ReleaseSection[] = [];
  let current: ReleaseSection | undefined;
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; }
    if (!fence && /^##\s/.test(line)) {
      const match = /^##\s+(?:\[([^\]]+)\]|(\S+))(?:\s+-\s+\d{4}-\d{2}-\d{2})?\s*$/.exec(line);
      const version = match?.[1] ?? match?.[2];
      current = version && validNoticeVersion(version) ? { version, text: '' } : undefined;
      if (current) {
        if (result.some(s => compareNoticeVersions(s.version, current!.version) === 0)) throw new Error('Duplicate release version.');
        result.push(current);
      }
    } else if (current) current.text += `${line}\n`;
  }
  return result.map(s => ({ ...s, text: s.text.trim() })).sort((a, b) => compareNoticeVersions(b.version, a.version));
}

export function buildReleaseIndex(markdown: string, currentVersion: string): ReleaseIndex {
  const sections = parseReleaseNotes(markdown).filter(s => compareNoticeVersions(s.version, NOTICE_INTRODUCTION_VERSION) >= 0
    && compareNoticeVersions(s.version, currentVersion) <= 0);
  if (!sections.some(s => compareNoticeVersions(s.version, currentVersion) === 0 && s.text)) throw new Error('Current release requires a changelog entry.');
  // Oversized sections are rejected at release time rather than silently chopped at runtime.
  if (sections.some(s => Buffer.byteLength(JSON.stringify(s)) > NOTICE_PAGE_BYTES - 1024)) throw new Error('Release section exceeds the notice page budget.');
  return { format: 1, firstVersion: NOTICE_INTRODUCTION_VERSION, sections };
}

export async function loadReleaseIndex(): Promise<ReleaseIndex | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(__dirname, 'release-notes.json'), 'utf8'));
    if (value?.format !== 1 || !validNoticeVersion(value.firstVersion) || !Array.isArray(value.sections)
      || value.sections.some((s: any) => !validNoticeVersion(s?.version) || typeof s.text !== 'string'
        || Buffer.byteLength(JSON.stringify(s)) > NOTICE_PAGE_BYTES - 1024)) return;
    return value;
  } catch { return; }
}

/** Pages contain complete Markdown sections. Missing publication history is never invented. */
export function releasePage(index: ReleaseIndex | undefined, from: string, to: string, offset = 0): ReleasePage {
  if (!validNoticeVersion(from) || !validNoticeVersion(to) || compareNoticeVersions(from, to) >= 0
    || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid release-note range.');
  const available = (index?.sections ?? []).filter(s => compareNoticeVersions(s.version, from) > 0
    && compareNoticeVersions(s.version, to) <= 0).sort((a, b) => compareNoticeVersions(b.version, a.version));
  const coverage = !available.length ? 'unavailable' : index && compareNoticeVersions(from, index.firstVersion) >= 0
    && available.some(s => compareNoticeVersions(s.version, to) === 0) ? 'complete' : 'partial';
  const sections: ReleaseSection[] = [];
  let bytes = 1024;
  for (const s of available.slice(offset)) {
    const size = Buffer.byteLength(JSON.stringify(s));
    if (sections.length >= 10 || bytes + size > NOTICE_PAGE_BYTES) break;
    sections.push(s); bytes += size;
  }
  const next = offset + sections.length;
  return { coverage, sections, offset, totalSections: available.length, ...(next < available.length ? { nextOffset: next } : {}) };
}

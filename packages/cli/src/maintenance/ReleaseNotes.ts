import fs from 'fs/promises';
import path from 'path';
import { compareNoticeVersions, validNoticeVersion } from './Version';
import { buildReleaseOverview, validReleaseChanges, type ReleaseChange, type ReleaseOverview } from './ReleaseOverview';

export const NOTICE_INTRODUCTION_VERSION = '1.6.123';
export const NOTICE_PAGE_BYTES = 20 * 1024;
export const USER_SUMMARY_BYTES = 2 * 1024;
// Text remains display-ready Markdown for old Routers; details are additive.
export interface ReleaseSection { version: string; text: string; details?: string; changes?: ReleaseChange[] }
export interface ReleaseIndex { format: 1; firstVersion: string; sections: ReleaseSection[] }
export interface ReleasePage {
  coverage: 'complete' | 'partial' | 'unavailable';
  sections: ReleaseSection[];
  offset: number;
  nextOffset?: number;
  totalSections: number;
  overview?: ReleaseOverview;
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

function validateUserSummary(section: ReleaseSection): { text: string; changes: ReleaseChange[] } {
  const lines = section.text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2 || lines.length > 4 || !/^###\s+\S/.test(lines[0]) || Array.from(lines[0]).length > 100
    || lines.slice(1).some(line => !/^- \S/.test(line))) {
    throw new Error('User release summaries require one short heading and one to three single-line bullets.');
  }
  if (!/\p{Script=Han}/u.test(section.text)) throw new Error('User release summaries require Chinese text.');
  if (Buffer.byteLength(section.text) > USER_SUMMARY_BYTES) throw new Error('User release summary exceeds the summary budget.');
  const changes = lines.slice(1).map(line => {
    const match = /^- \[([a-z][a-z0-9-]{0,39})\|([^\]\r\n|]+)\] (\S.*)$/.exec(line);
    if (!match) throw new Error('User release bullets require a stable feature tag and display title.');
    return { topic: match[1], title: match[2], text: match[3] };
  });
  if (!validReleaseChanges(changes)) throw new Error('Invalid user release feature metadata.');
  return { text: [lines[0], ...changes.map(change => `- ${change.text}`)].join('\n'), changes };
}

export function buildReleaseIndex(markdown: string, currentVersion: string, userMarkdown: string): ReleaseIndex {
  const technical = parseReleaseNotes(markdown).filter(s => compareNoticeVersions(s.version, NOTICE_INTRODUCTION_VERSION) >= 0
    && compareNoticeVersions(s.version, currentVersion) <= 0);
  if (!technical.some(s => compareNoticeVersions(s.version, currentVersion) === 0 && s.text)) throw new Error('Current release requires a changelog entry.');
  const summaries = parseReleaseNotes(userMarkdown).filter(s => compareNoticeVersions(s.version, NOTICE_INTRODUCTION_VERSION) >= 0
    && compareNoticeVersions(s.version, currentVersion) <= 0);
  if (!summaries.some(s => compareNoticeVersions(s.version, currentVersion) === 0 && s.text)) throw new Error('Current release requires a user release summary.');
  const localized = new Map<string, { text: string; changes: ReleaseChange[] }>();
  const titles = new Map<string, string>();
  for (const summary of summaries) {
    const parsed = validateUserSummary(summary);
    for (const change of parsed.changes) {
      if (titles.has(change.topic) && titles.get(change.topic) !== change.title) throw new Error('Release feature tags must retain a stable display title.');
      titles.set(change.topic, change.title);
    }
    localized.set(summary.version, parsed);
    if (!technical.some(s => compareNoticeVersions(s.version, summary.version) === 0 && s.text)) throw new Error('User release summary requires a matching changelog entry.');
  }
  const sections = technical.map(section => {
    const summary = summaries.find(s => compareNoticeVersions(s.version, section.version) === 0);
    return summary ? { version: section.version, ...localized.get(summary.version)!, details: section.text } : section;
  });
  // Oversized sections are rejected at release time rather than silently chopped at runtime.
  if (sections.some(s => Buffer.byteLength(JSON.stringify(s)) > NOTICE_PAGE_BYTES - 1024)) throw new Error('Release section exceeds the notice page budget.');
  return { format: 1, firstVersion: NOTICE_INTRODUCTION_VERSION, sections };
}

export async function loadReleaseIndex(): Promise<ReleaseIndex | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(__dirname, 'release-notes.json'), 'utf8'));
    if (value?.format !== 1 || !validNoticeVersion(value.firstVersion) || !Array.isArray(value.sections)
      || value.sections.some((s: any) => !validNoticeVersion(s?.version) || typeof s.text !== 'string'
        || s.details !== undefined && typeof s.details !== 'string'
        || s.changes !== undefined && !validReleaseChanges(s.changes)
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
  // Feature metadata remains local; only the bounded overview crosses the wire.
  const views = available.map(section => ({ version: section.version, text: section.text,
    ...(section.details === undefined ? {} : { details: section.details }) }));
  const largest = views.reduce((size, section) => Math.max(size, Buffer.byteLength(JSON.stringify(section))), 0);
  const overview = buildReleaseOverview(available, NOTICE_PAGE_BYTES - 1024 - largest);
  const sections: ReleaseSection[] = [];
  let bytes = 1024 + (overview ? Buffer.byteLength(JSON.stringify(overview)) : 0);
  for (const s of views.slice(offset)) {
    const size = Buffer.byteLength(JSON.stringify(s));
    if (sections.length >= 10 || bytes + size > NOTICE_PAGE_BYTES) break;
    sections.push(s); bytes += size;
  }
  const next = offset + sections.length;
  return { coverage, sections, offset, totalSections: available.length, ...(overview ? { overview } : {}),
    ...(next < available.length ? { nextOffset: next } : {}) };
}

import { parsePatch, structuredPatch, type StructuredPatchHunk } from 'diff';
import type { FeishuCardElement } from './ToolFormatter';

interface DiffFile {
  path: string;
  hunks: StructuredPatchHunk[];
  note?: string;
  raw?: string;
  contentOnly?: boolean;
}

const CONTEXT_LINES = 3;
const MAX_FILES = 6;
const MAX_HUNKS = 8;
const MAX_LINES = 160;
const MAX_RENDERED_CHARS = 24000;
const MAX_INPUT_CHARS = 1_000_000;

/** Escape source code before placing it in Feishu's interpreted rich text. */
export function escapeDiffText(text: string): string {
  return text.replace(/[&<>"'`*_\[\]~\\#|!]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function codeBlock(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}diff\n${text}\n${fence}`;
}

function coloredLine(line: string): string {
  const color = line.startsWith('+') ? 'green' : line.startsWith('-') ? 'red' : line.startsWith('@@') ? 'blue' : 'grey';
  // Nonbreaking spaces preserve indentation in rich text. The code block below
  // retains the original spaces and tabs for copying.
  const text = escapeDiffText(line).replace(/ /g, '\u00a0').replace(/\t/g, '\u00a0'.repeat(4));
  return `<font color='${color}'>${text || '\u00a0'}</font>`;
}

function compareText(oldText: string, newText: string, filePath: string, note?: string): DiffFile {
  if (oldText.length + newText.length > MAX_INPUT_CHARS) {
    return { path: filePath, hunks: [], note: 'Change is too large to calculate a preview. Inspect the file for the complete change.' };
  }
  const patch = structuredPatch(filePath, filePath, oldText, newText, '', '', {
    context: CONTEXT_LINES, timeout: 30, maxEditLength: 4000,
  });
  return patch ? { path: filePath, hunks: patch.hunks, note: patch.hunks.length ? note : 'No textual changes.' }
    : { path: filePath, hunks: [], note: 'Diff calculation limit reached. Inspect the file for the complete change.' };
}

/** Keep small context windows even when a backend sends a full-file hunk. */
function compactHunk(hunk: StructuredPatchHunk): StructuredPatchHunk[] {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < hunk.lines.length; i++) {
    if (!/^[+-]/.test(hunk.lines[i])) continue;
    const start = Math.max(0, i - CONTEXT_LINES);
    const end = Math.min(hunk.lines.length, i + CONTEXT_LINES + 1);
    const previous = ranges[ranges.length - 1];
    if (previous && previous.end >= start) previous.end = end;
    else ranges.push({ start, end });
  }
  const oldOffsets = [0];
  const newOffsets = [0];
  for (const line of hunk.lines) {
    oldOffsets.push(oldOffsets[oldOffsets.length - 1] + (/^[ -]/.test(line) ? 1 : 0));
    newOffsets.push(newOffsets[newOffsets.length - 1] + (/^[ +]/.test(line) ? 1 : 0));
  }
  return ranges.map(({ start, end }) => {
    const oldLines = oldOffsets[end] - oldOffsets[start];
    const newLines = newOffsets[end] - newOffsets[start];
    return {
      oldStart: hunk.oldStart + oldOffsets[start],
      oldLines,
      newStart: hunk.newStart + newOffsets[start],
      newLines,
      lines: hunk.lines.slice(start, end),
    };
  });
}

function displayPath(name: string): string {
  return name.replace(/^[ab]\//, '');
}

function parseFiles(diff: string, fallbackPath: string): DiffFile[] {
  if (diff.length > MAX_INPUT_CHARS) {
    return [{ path: fallbackPath, hunks: [], note: 'Diff is too large to preview. Inspect the files for the complete change.' }];
  }
  try {
    const patches = parsePatch(diff);
    if (patches.some((patch) => patch.hunks.some((hunk) =>
      ![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every((value) => Number.isSafeInteger(value) && value >= 0)))) {
      throw new Error('Invalid diff coordinates');
    }
    if (patches.some((patch) => patch.hunks.length > 0)) {
      return patches.map((patch, index) => ({
        path: displayPath(patch.newFileName === '/dev/null' ? patch.oldFileName || fallbackPath : patch.newFileName || patch.oldFileName || fallbackPath),
        hunks: index < MAX_FILES ? patch.hunks.flatMap(compactHunk) : [],
        note: patch.hunks.length ? undefined : 'No textual hunks were provided for this file.',
      }));
    }
  } catch {
    // ACP adapters may send old/new text with file headers but no hunk header.
  }
  const sections = diff.split(/(?=^--- .+\r?\n\+\+\+ )/m).filter(Boolean);
  return sections.map((section, index) => {
    if (index >= MAX_FILES) return { path: fallbackPath, hunks: [] };
    const lines = section.split(/\r?\n/);
    if (lines[0]?.startsWith('--- ') && lines[1]?.startsWith('+++ ')) {
      const oldPath = lines.shift()!.slice(4);
      const newPath = lines.shift()!.slice(4);
      const filePath = displayPath(newPath === '/dev/null' ? oldPath : newPath);
      if (lines.every((line) => /^[+-]/.test(line) || line === '')) {
        const oldText = lines.filter((line) => line.startsWith('-')).map((line) => line.slice(1)).join('\n');
        const newText = lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n');
        return compareText(oldText, newText, filePath, 'Line numbers are relative to the supplied text.');
      }
      return { path: filePath, hunks: [], raw: section, note: 'Raw diff preview; change counts are unavailable.' };
    }
    return { path: fallbackPath, hunks: [], raw: section, note: 'Raw diff preview; change counts are unavailable.' };
  });
}

function hunkHeader(hunk: StructuredPatchHunk): string {
  // jsdiff uses one-based insertion points internally, including empty ranges.
  return `@@ -${hunk.oldStart - (hunk.oldLines === 0 ? 1 : 0)},${hunk.oldLines} +${hunk.newStart - (hunk.newLines === 0 ? 1 : 0)},${hunk.newLines} @@`;
}

/** Allocate space to both deletions and additions before unchanged context. */
function selectLines(lines: string[], lineBudget: number, charBudget: number): { lines: string[]; omitted: number } {
  const cost = (line: string): number => coloredLine(line).length + line.length + 2;
  if (lines.length <= lineBudget && lines.reduce((sum, line) => sum + cost(line), 0) <= charBudget) {
    return { lines, omitted: 0 };
  }
  const deleted: number[] = [];
  const added: number[] = [];
  const context: number[] = [];
  lines.forEach((line, index) => (line.startsWith('-') ? deleted : line.startsWith('+') ? added : context).push(index));
  const priority: number[] = [];
  for (let i = 0; i < Math.max(deleted.length, added.length); i++) {
    if (i < deleted.length) priority.push(deleted[i]);
    if (i < added.length) priority.push(added[i]);
  }
  for (const index of context) priority.push(index);
  const selected = new Set<number>();
  for (const index of priority) {
    if (selected.size >= lineBudget) break;
    const size = cost(lines[index]);
    if (size > charBudget) continue;
    selected.add(index);
    charBudget -= size;
  }
  const result: string[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (!selected.has(index)) { skipped++; return; }
    if (skipped) result.push(`... ${skipped} lines omitted ...`);
    skipped = 0;
    result.push(line);
  });
  if (skipped) result.push(`... ${skipped} lines omitted ...`);
  return { lines: result, omitted: lines.length - selected.size };
}

function renderFiles(files: DiffFile[], statusTitle: string): FeishuCardElement[] {
  const visibleFiles = files.slice(0, MAX_FILES);
  const panels: FeishuCardElement[] = visibleFiles.map((file) => {
    const additions = file.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith('+')).length, 0);
    const deletions = file.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith('-')).length, 0);
    const stats = file.hunks.length && !file.contentOnly
      ? ` · <font color='green'>+${additions}</font> <font color='red'>−${deletions}</font>` : '';
    const hunks = file.hunks.slice(0, MAX_HUNKS);
    const count = Math.max(1, hunks.length);
    const lineBudget = Math.floor(MAX_LINES / visibleFiles.length / count);
    const charBudget = Math.floor((MAX_RENDERED_CHARS / visibleFiles.length - 600) / count) - 100;
    let omitted = 0;
    const preview = hunks.flatMap((hunk) => {
      const selected = selectLines(hunk.lines, lineBudget, Math.max(0, charBudget));
      omitted += selected.omitted;
      return [hunkHeader(hunk), ...selected.lines];
    });
    if (file.raw) {
      const selected = selectLines(file.raw.split(/\r?\n/), lineBudget, Math.max(0, charBudget));
      preview.push(...selected.lines);
      omitted += selected.omitted;
    }
    const hiddenHunks = file.hunks.length - hunks.length;
    const notes = [file.note];
    if (omitted || hiddenHunks) notes.push(`Preview shortened: ${omitted} lines and ${hiddenHunks} additional hunks omitted. Inspect the file for the complete change.`);
    const pathText = file.path.length > 500 ? `…${file.path.slice(-499)}` : file.path;
    const elements: FeishuCardElement[] = [{ tag: 'markdown', content: `**File:** ${escapeDiffText(pathText)}${notes.filter(Boolean).map((note) => `\n${note}`).join('')}` }];
    if (preview.length) {
      elements.push({ tag: 'markdown', content: preview.map(coloredLine).join('\n') });
      elements.push({ tag: 'markdown', content: `**Copyable diff preview${omitted || hiddenHunks ? ' (partial)' : ''}**\n${codeBlock(preview.join('\n'))}` });
    } else if (!file.note) {
      elements.push({ tag: 'markdown', content: 'No textual changes.' });
    }
    return {
      tag: 'collapsible_panel', expanded: false,
      header: {
        title: { tag: 'markdown', content: `${statusTitle} · **${escapeDiffText(file.path.length > 90 ? `…${file.path.slice(-89)}` : file.path)}**${stats}` },
        vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '14px 14px' },
        icon_position: 'right', icon_expanded_angle: -180,
      },
      vertical_spacing: '8px', padding: '4px 8px', elements,
    };
  });
  if (files.length > visibleFiles.length) panels.push({ tag: 'markdown', content: `${files.length - visibleFiles.length} additional files omitted from this preview.` });
  return panels;
}

export function createDiffPanels(diff: string, title: string, fallbackPath = 'Changes'): FeishuCardElement[] {
  return renderFiles(parseFiles(diff, fallbackPath), title);
}

export function createEditPanels(input: Record<string, unknown>, title: string): FeishuCardElement[] | null {
  const filePath = typeof input.file_path === 'string' ? input.file_path : 'Changes';
  if (typeof input.diff === 'string' && input.diff) return createDiffPanels(input.diff, title, filePath);
  if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return null;
  return renderFiles([compareText(input.old_string, input.new_string, filePath, 'Line numbers are relative to the edited snippet.')], title);
}

export function createWritePanels(input: Record<string, unknown>, title: string): FeishuCardElement[] | null {
  if (typeof input.content !== 'string') return null;
  const filePath = typeof input.file_path === 'string' ? input.file_path : 'Changes';
  const file = compareText('', input.content, filePath, 'Written content preview; previous file contents are unavailable.');
  if (!input.content) file.note = 'Written content is empty; previous file contents are unavailable.';
  file.contentOnly = true;
  return renderFiles([file], title);
}

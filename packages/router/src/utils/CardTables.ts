// Conservative budget used by Feishu's official plugin after observed 11310 errors:
// https://github.com/larksuite/openclaw-lark/blob/main/src/card/card-error.ts
export const CARD_TABLE_LIMIT = 3;

interface TableRange { start: number; end: number }

/** Locate pipe tables while leaving fenced code, indented code, and raw text alone. */
function tableRanges(text: string): TableRange[] {
  const lines = text.split('\n');
  const offsets: number[] = [];
  const visible: boolean[] = [];
  let offset = 0;
  let fence: string | undefined;
  let raw = false;
  const unquote = (line: string) => line.replace(/^(?: {0,3}> ?)+/, '');
  const hasPipe = (line: string) => line.replace(/\\./g, '').includes('|');
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
    const body = unquote(line);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body);
    if (fence) {
      visible.push(false);
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (raw) {
      visible.push(false);
      if (/<\/raw>/i.test(body)) raw = false;
    } else if (marker) {
      fence = marker[1];
      visible.push(false);
    } else if (/<raw>/i.test(body)) {
      raw = !/<\/raw>/i.test(body);
      visible.push(false);
    } else {
      visible.push(!/^(?: {4}|\t)/.test(body));
    }
  }

  const ranges: TableRange[] = [];
  for (let index = 1; index < lines.length; index++) {
    if (!visible[index] || !visible[index - 1]) continue;
    const header = unquote(lines[index - 1]).trim();
    const separator = unquote(lines[index]).trim();
    const cells = separator.replace(/^\|/, '').replace(/\|$/, '').split('|');
    if (!hasPipe(header) || !separator.includes('|') || !cells.every(cell => /^\s*:?-{1,}:?\s*$/.test(cell))) continue;
    let end = index + 1;
    while (end < lines.length && visible[end] && lines[end].trim() && hasPipe(lines[end])) end++;
    ranges.push({ start: offsets[index - 1], end: end < lines.length ? offsets[end] : text.length });
    index = end;
  }
  return ranges;
}

function textBlock(text: string): string {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text.trimEnd()}\n${fence}`;
}

function isMarkdown(value: any): boolean {
  return (value?.tag === 'markdown' || value?.tag === 'lark_md') && typeof value.content === 'string';
}

export function countCardTables(value: any): number {
  if (!value || typeof value !== 'object') return 0;
  if (value.tag === 'table') return 1;
  if (isMarkdown(value)) return tableRanges(value.content).length;
  return Object.values(value).reduce<number>((total, child) => total + countCardTables(child), 0);
}

/** Keep oversized indivisible containers readable without dropping table rows. */
export function limitCardTables(value: any, limit = CARD_TABLE_LIMIT): any {
  let remaining = limit;
  const visit = (node: any): any => {
    if (!node || typeof node !== 'object') return node;
    if (node.tag === 'table') {
      if (remaining-- > 0) return node;
      return { tag: 'markdown', content: textBlock(JSON.stringify(node, null, 2)) };
    }
    if (isMarkdown(node)) {
      const ranges = tableRanges(node.content);
      const keep = Math.max(0, remaining);
      remaining -= ranges.length;
      if (ranges.length <= keep) return node;
      let content = node.content;
      for (const range of ranges.slice(keep).reverse()) {
        content = content.slice(0, range.start) + '\n' + textBlock(content.slice(range.start, range.end)) + '\n\n' + content.slice(range.end);
      }
      return { ...node, content };
    }
    if (Array.isArray(node)) return node.map(visit);
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
  };
  return visit(value);
}

/** Split large top-level Markdown blocks at table boundaries before packing cards. */
export function prepareTableElements(elements: any[]): any[] {
  return elements.flatMap(element => {
    if (countCardTables(element) <= CARD_TABLE_LIMIT) return [element];
    if (!isMarkdown(element)) return [limitCardTables(element)];
    const ranges = tableRanges(element.content);
    const parts: any[] = [];
    let start = 0;
    for (let index = CARD_TABLE_LIMIT; index < ranges.length; index += CARD_TABLE_LIMIT) {
      parts.push({ ...element, content: element.content.slice(start, ranges[index].start) });
      start = ranges[index].start;
    }
    parts.push({ ...element, content: element.content.slice(start) });
    return parts;
  });
}

/** API fallback also covers Markdown forms the conservative preflight scanner missed. */
export function plainTextCard(value: any): any {
  if (!value || typeof value !== 'object') return value;
  if (value.tag === 'table') return { tag: 'markdown', content: textBlock(JSON.stringify(value, null, 2)) };
  if (isMarkdown(value)) return { ...value, content: textBlock(value.content) };
  if (Array.isArray(value)) return value.map(plainTextCard);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainTextCard(child)]));
}

export function isCardTableLimitError(error: any): boolean {
  const detail = error?.response?.data ?? error;
  return Number(detail?.code) === 230099 && typeof detail?.msg === 'string'
    && /ErrCode:\s*11310\b/.test(detail.msg) && /table number over limit/i.test(detail.msg);
}

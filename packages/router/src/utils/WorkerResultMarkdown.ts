import MarkdownIt from 'markdown-it';

const parser = new MarkdownIt({ html: false, linkify: false });
type Token = ReturnType<typeof parser.parse>[number];

function literal(text: string): string {
  return text.replace(/[\\`*_[\]{}()#+.!|~=-]/g, '\\$&')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function backticks(text: string, minimum: number): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  return '`'.repeat(Math.max(minimum, longest + 1));
}

function closingIndex(tokens: Token[], start: number): number {
  let depth = 1;
  for (let index = start + 1; index < tokens.length; index++) {
    depth += tokens[index].nesting;
    if (depth === 0) return index;
  }
  return tokens.length;
}

function inline(tokens: Token[]): string {
  let output = '';
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    switch (token.type) {
      case 'text': output += literal(token.content); break;
      case 'softbreak': output += '\n'; break;
      case 'hardbreak': output += '  \n'; break;
      case 'code_inline': {
        const fence = backticks(token.content, 1);
        const padding = /^`|`$/.test(token.content) || (/^ .* $/.test(token.content) && /\S/.test(token.content)) ? ' ' : '';
        output += `${fence}${padding}${token.content}${padding}${fence}`;
        break;
      }
      case 'strong_open': case 'strong_close': output += '**'; break;
      case 'em_open': case 'em_close': output += '*'; break;
      case 's_open': case 's_close': output += '~~'; break;
      case 'link_open': {
        const end = closingIndex(tokens, index);
        const label = inline(tokens.slice(index + 1, end));
        const href = token.attrGet('href') ?? '';
        const safe = /^(https?:\/\/|mailto:)/i.test(href);
        const destination = href.replace(/[\s()<>\\"]/g,
          character => encodeURIComponent(character).replace(/\(/g, '%28').replace(/\)/g, '%29'));
        output += safe ? `[${label}](${destination})` : label;
        index = end;
        break;
      }
      case 'image': output += inline(token.children ?? []) || 'Image'; break;
      default: output += literal(token.content);
    }
  }
  return output;
}

/** Serialize parsed Markdown, never worker-supplied Feishu tags, into card text. */
function blocks(tokens: Token[], sourceLines: string[] = [], cutEnd = false): string {
  const parts: string[] = [];
  let compact = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'paragraph_open' || token.type === 'heading_open' || token.type === 'blockquote_open') {
      if (token.type === 'paragraph_open' && token.hidden) compact = true;
      const end = closingIndex(tokens, index);
      const content = blocks(tokens.slice(index + 1, end), sourceLines, cutEnd);
      parts.push(token.type === 'heading_open' ? `${'#'.repeat(Number(token.tag.slice(1)))} ${content}`
        : token.type === 'blockquote_open' ? content.split('\n').map(line => `> ${line}`).join('\n') : content);
      index = end;
    } else if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      const end = closingIndex(tokens, index);
      const items: string[] = [];
      let number = Number(token.attrGet('start') ?? 1);
      for (let item = index + 1; item < end; item++) {
        if (tokens[item].type !== 'list_item_open') continue;
        const itemEnd = closingIndex(tokens, item);
        const prefix = token.type === 'ordered_list_open' ? `${number++}. ` : '- ';
        const content = blocks(tokens.slice(item + 1, itemEnd), sourceLines, cutEnd);
        items.push(prefix + content.replace(/\n/g, `\n${' '.repeat(prefix.length)}`));
        item = itemEnd;
      }
      parts.push(items.join('\n'));
      index = end;
    } else if (token.type === 'table_open') {
      const end = closingIndex(tokens, index);
      const rows: string[][] = [];
      for (let row = index + 1; row < end; row++) {
        if (tokens[row].type !== 'tr_open') continue;
        const rowEnd = closingIndex(tokens, row);
        const cells: string[] = [];
        for (let cell = row + 1; cell < rowEnd; cell++) {
          if (tokens[cell].type === 'inline') cells.push(inline(tokens[cell].children ?? []).replace(/\n/g, ' ')
            .replace(/(^|[^\\])((?:\\\\)*)\|/g, '$1$2\\|'));
        }
        rows.push(cells);
        row = rowEnd;
      }
      const source = sourceLines.slice(token.map?.[0], token.map?.[1]).join('\n');
      // Keep cut or oversized tables readable without inventing missing cells.
      if ((cutEnd && token.map?.[1] === sourceLines.length) || rows.length > 13 || rows[0]?.length > 6) {
        const fence = backticks(source, 3);
        parts.push(`${fence}\n${source}\n${fence}`);
      } else if (rows.length) {
        const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
        parts.push([line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n'));
      }
      index = end;
    } else if (token.type === 'inline') {
      parts.push(inline(token.children ?? []));
    } else if (token.type === 'fence' || token.type === 'code_block') {
      const fence = backticks(token.content, 3);
      const language = token.info.trim().split(/\s/)[0].replace(/[^\w-]/g, '');
      parts.push(`${fence}${language}\n${token.content.replace(/\n$/, '')}\n${fence}`);
    } else if (token.type === 'hr') {
      parts.push('---');
    } else if (token.content) {
      parts.push(literal(token.content));
    }
  }
  return parts.join(compact ? '\n' : '\n\n');
}

/** Keep bounded result and activity previews while preserving layout and closing cut fences. */
export function formatWorkerResultMarkdown(value: string, limit = 1000, preview: 'result' | 'activity' = 'result'): string {
  const characters = Array.from(value.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ''));
  const truncated = characters.length > limit;
  let source = characters.slice(0, limit).join('');
  if (truncated && preview === 'activity') {
    const prefix = characters.slice(0, -limit).join('');
    source = characters.slice(-limit).join('');
    const cutLine = prefix.split('\n').length - 1;
    const context = parser.parse(characters.join(''), {}).find(token =>
      token.map && token.map[0] < cutLine && token.map[1] > cutLine
      && (token.type === 'fence' || token.type === 'table_open'));
    if (context?.type === 'fence') source = `${context.markup}${context.info}\n${source}`;
    // A table tail has lost its header; display the fragment literally.
    if (context?.type === 'table_open') {
      const fence = backticks(source, 3);
      source = `${fence}\n${source}\n${fence}`;
    }
  }
  const content = blocks(parser.parse(source, {}), source.split('\n'), truncated && preview === 'result');
  const empty = preview === 'activity' ? '_No activity text yet._' : '_No text result._';
  const notice = preview === 'activity' ? '_Earlier activity omitted._' : '_Result preview truncated._';
  return (preview === 'activity' && truncated ? `${notice}\n\n` : '')
    + (content.trim() ? content : empty)
    + (preview === 'result' && truncated ? `\n\n${notice}` : '');
}

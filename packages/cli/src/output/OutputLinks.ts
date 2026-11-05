import MarkdownIt from 'markdown-it';
import path from 'path';
import { OUTPUT_LIMITS } from './Protocol';

const markdown = new MarkdownIt('commonmark', { html: false, linkify: false });
// CommonMark's URL normalizer preserves Windows drives but treats backslashes as escapes.
markdown.validateLink = href => !/^(?:javascript|vbscript|data):/i.test(href);
export function localDestination(href: string, flavor: typeof path = path): string | undefined {
  let value: string;
  try { value = decodeURIComponent(href); } catch { return; }
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)
    || /^(?:[/\\]{2}|~)/.test(value)) return;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[/\\]/i.test(value)
    && !/^[^/\\:]+\.[a-z0-9]{1,16}:\d+(?::\d+)?$/i.test(value)) return;
  value = value.replace(/#L\d+(?:-L?\d+)?$/i, '');
  // On Windows colons after the drive cannot be ordinary filenames; reject ADS.
  if (flavor.sep === '\\') {
    value = value.replace(/:\d+(?::\d+)?$/, '');
    if (value.slice(/^[a-z]:/i.test(value) ? 2 : 0).includes(':')) return;
  }
  return value;
}
export class OutputLinks {
  private text = '';
  private capped = false;
  append(text: string): void {
    const left = OUTPUT_LIMITS.text - this.text.length;
    if (text.length > left) this.capped = true;
    this.text += text.slice(0, Math.max(left, 0));
  }
  finish(finalText?: string): { paths: string[]; omitted: boolean } {
    // Final output often repeats the stream; parse separately and deduplicate.
    const texts = [this.text];
    if (finalText) { texts.push(finalText.slice(0, OUTPUT_LIMITS.text)); this.capped ||= finalText.length > OUTPUT_LIMITS.text; }
    const paths = new Set<string>();
    for (const text of texts) for (const block of markdown.parse(text, {})) {
      if (block.type !== 'inline') continue;
      for (const token of block.children ?? []) {
        if (token.type !== 'link_open') continue;
        const candidate = localDestination(token.attrGet('href') ?? '');
        if (!candidate || paths.has(candidate)) continue;
        if (paths.size >= OUTPUT_LIMITS.candidates) { this.capped = true; continue; }
        paths.add(candidate);
      }
    }
    this.text = '';
    return { paths: [...paths], omitted: this.capped };
  }
}

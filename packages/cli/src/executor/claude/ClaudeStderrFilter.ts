import { StringDecoder } from 'string_decoder';

const PREFIX = '[claude-code:unrecognized_model]';
const MAX_PENDING_LENGTH = 8192;

function isModelDiagnostic(line: string): boolean {
  if (!line.startsWith(PREFIX) || !/^[ \t]+/.test(line.slice(PREFIX.length))) return false;
  try {
    const value = JSON.parse(line.slice(PREFIX.length).trim());
    return value !== null && typeof value === 'object' && Object.keys(value).length === 2
      && typeof value.model === 'string' && value.model.trim().length > 0 && value.query_source === 'sdk';
  } catch { return false; }
}

/** Suppress only the SDK model-recognition diagnostic, never general stderr. */
export class ClaudeStderrFilter {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private passthrough = false;

  write(chunk: Buffer | string): string {
    return this.consume(typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
  }

  flush(): string {
    const decoded = this.consume(this.decoder.end());
    const remainder = isModelDiagnostic(this.pending) ? '' : this.pending;
    this.pending = '';
    this.passthrough = false;
    return decoded + remainder;
  }

  private consume(text: string): string {
    let output = '';
    for (const part of text.split(/(?<=\n)/)) {
      if (!part) continue;
      const complete = part.endsWith('\n');
      if (this.passthrough) {
        output += part;
        if (complete) this.passthrough = false;
        continue;
      }
      this.pending += part;
      const candidate = this.pending.startsWith(PREFIX) || PREFIX.startsWith(this.pending);
      if (!candidate || this.pending.length > MAX_PENDING_LENGTH) {
        output += this.pending;
        this.pending = '';
        this.passthrough = !complete;
      } else if (complete) {
        if (!isModelDiagnostic(this.pending)) output += this.pending;
        this.pending = '';
      }
    }
    return output;
  }
}

export function filterClaudeStderr(text: string): string {
  const filter = new ClaudeStderrFilter();
  return filter.write(text) + filter.flush();
}

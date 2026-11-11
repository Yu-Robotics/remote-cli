import type { ScheduleRule } from '../types';

export const VERSION = 1;
export const COMMAND = '_remote_cli/native_schedule_command';
export const EVENT = '_remote_cli/native_schedule_event';
export const MAX_FRAME = 1024 * 1024;
export const MAX_OUTPUT = 256 * 1024;
export const MAX_PROMPT = 64 * 1024;
export type ObjectValue = Record<string, any>;
export function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export function exact(value: unknown, keys: string[]): value is ObjectValue {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function instant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
/** Compare matched fields and Vixie DOM/DOW star semantics, never calculate firing times. */
export function cronSignature(expression: string): string {
  if (typeof expression !== 'string' || expression.length > 512) throw new Error('Invalid DSH cron expression.');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('DSH requires five cron fields.');
  return JSON.stringify(fields.map((field, index) => {
    const [min, max] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]][index];
    const values = new Set<number>();
    for (const part of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match || (match[2] && match[1] !== '*' && !match[1].includes('-'))) throw new Error('Invalid DSH cron field.');
      const range = match[1] === '*' ? [min, max] : match[1].split('-').map(Number);
      const [start, end = start] = range;
      const step = match[2] ? Number(match[2]) : 1;
      if (!Number.isSafeInteger(step) || step < 1 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < min || end > max || start > end) throw new Error('Invalid DSH cron range.');
      for (let n = start; n <= end; n += step) values.add(index === 4 && n === 7 ? 0 : n);
    }
    return { values: [...values].sort((a, b) => a - b), star: (index === 2 || index === 4) && field.startsWith('*') };
  }));
}
export function normalizeRule(value: unknown, now = Date.now()): ScheduleRule {
  if (exact(value, ['kind', 'at']) && value.kind === 'once' && typeof value.at === 'string'
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value.at)) {
    const [year, month, day] = value.at.slice(0, 10).split('-').map(Number);
    const [hour, minute] = value.at.slice(11, 16).split(':').map(Number);
    const second = value.at[16] === ':' ? Number(value.at.slice(17, 19)) : 0;
    const calendar = new Date(0); calendar.setUTCFullYear(year, month, 0);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > calendar.getUTCDate() || hour > 23 || minute > 59 || second > 59) {
      throw new Error('Invalid DSH schedule instant.');
    }
    const time = Date.parse(value.at);
    if (Number.isFinite(time) && time > now) return { kind: 'once', at: new Date(time).toISOString() };
  }
  if (exact(value, ['kind', 'expression', 'timezone']) && value.kind === 'cron' && typeof value.timezone === 'string'
    && value.timezone.length <= 128 && !/^[+-]/.test(value.timezone)) {
    cronSignature(value.expression);
    const timezone = new Intl.DateTimeFormat('en', { timeZone: value.timezone }).resolvedOptions().timeZone;
    return { kind: 'cron', expression: value.expression.trim().replace(/\s+/g, ' '), timezone };
  }
  throw new Error('Invalid or expired DSH schedule rule.');
}
export function validPrompt(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= MAX_PROMPT;
}
/** Validate the native row itself, including its canonical rule, rather than assistant prose. */
export function matchesRecord(row: unknown, rule: ScheduleRule, prompt: string, title: string, nativeId?: string): row is ObjectValue {
  if (!object(row) || !identifier(row.id) || (nativeId !== undefined && row.id !== nativeId)
    || row.prompt !== prompt || row.title !== title || !instant(row.scheduledAt)) return false;
  if (rule.kind === 'once') return row.kind === 'at' && row.scheduledAt === rule.at;
  try {
    return row.kind === 'cron' && typeof row.timeZone === 'string' && row.timeZone.length > 0 && cronSignature(row.expression) === cronSignature(rule.expression)
      && new Intl.DateTimeFormat('en', { timeZone: row.timeZone }).resolvedOptions().timeZone === rule.timezone;
  } catch { return false; }
}
/** Bound each line before concatenation; a single chunk may contain many complete frames. */
export class JsonLines {
  private buffer = Buffer.alloc(0);
  constructor(private readonly accept: (frame: ObjectValue) => void, private readonly limit = MAX_FRAME) {}
  read(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      if (this.buffer.length + end - offset > this.limit) throw new Error('DSH protocol frame limit exceeded.');
      this.buffer = Buffer.concat([this.buffer, bytes.subarray(offset, end)]);
      if (newline < 0) return;
      const line = this.buffer.toString('utf8');
      this.buffer = Buffer.alloc(0);
      offset = newline + 1;
      if (!line.trim()) continue;
      const frame: unknown = JSON.parse(line);
      if (!object(frame)) throw new Error('Invalid DSH protocol object.');
      this.accept(frame);
    }
  }
}
export function boundedText(text: string, remaining: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= remaining) return text;
  // Drop a partial UTF-8 code point at the boundary, rather than expanding it into replacement bytes.
  let end = Math.max(0, remaining);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

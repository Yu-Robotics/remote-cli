import type { ScheduleRule } from './types';

export const MAX_SCHEDULE_PROMPT_BYTES = 16 * 1024;
export const MAX_SCHEDULE_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
export const SCHEDULE_USAGE = [
  '/schedule',
  '/schedule capabilities',
  '/schedule list',
  '/schedule cancel <id>',
  '/schedule after <positive integer><m|h|d> -- <prompt>',
  '/schedule at <ISO timestamp with Z or offset> -- <prompt>',
  '/schedule cron "<five numeric fields>" --tz <IANA timezone> -- <prompt>',
  'Claude and DSH schedules require their native host process to remain running; Claude shares the foreground conversation.',
  'Restarted schedules are marked interrupted and are never automatically recreated.',
  'One-shot times round up to the next minute; native firing times may include jitter.',
].join('\n');

export type ScheduleCommand =
  | { kind: 'help' | 'capabilities' | 'list' }
  | { kind: 'cancel'; id: string }
  | { kind: 'create'; rule: ScheduleRule; prompt: string }
  | { kind: 'invalid'; message: string };

export function validateScheduleId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)
    || ['__proto__', 'constructor', 'prototype'].includes(id)) {
    throw new Error('Schedule ID must contain 1-128 letters, digits, underscores or hyphens.');
  }
}

export function validateSchedulePrompt(prompt: unknown): asserts prompt is string {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0')
    || Buffer.byteLength(prompt, 'utf8') > MAX_SCHEDULE_PROMPT_BYTES) {
    throw new Error('Schedule prompt must be nonempty, contain no NUL, and fit within 16 KiB.');
  }
}

/** Validate field values and grammar, not just the number of cron tokens. */
export function validateScheduleCron(expression: unknown, timezone: unknown): void {
  if (typeof expression !== 'string' || expression.length > 256) throw new Error('Invalid cron expression.');
  const fields = expression.trim().split(/\s+/);
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  if (fields.length !== bounds.length) throw new Error('Cron requires exactly five numeric fields.');
  fields.forEach((field, index) => {
    const [min, max] = bounds[index];
    for (const part of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match) throw new Error(`Invalid cron field ${index + 1}.`);
      const [base, step] = [match[1], match[2]];
      if (step !== undefined && (base !== '*' && !base.includes('-')
        || !Number.isSafeInteger(Number(step)) || Number(step) < 1 || Number(step) > max - min + 1)) {
        throw new Error(`Invalid cron step in field ${index + 1}.`);
      }
      if (base !== '*') {
        const [start, end = start] = base.split('-').map(Number);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
          || start < min || end > max || start > end) {
          throw new Error(`Cron field ${index + 1} must be within ${min}-${max}, with ascending ranges.`);
        }
      }
    }
  });
  if (typeof timezone !== 'string' || timezone.length > 128
    || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(timezone)) {
    throw new Error('An explicit IANA timezone is required.');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new Error('Unknown IANA timezone.'); }
}

/** Date.parse normalizes invalid calendar days, so validate the calendar first. */
export function parseScheduleTimestamp(value: unknown): number {
  if (typeof value !== 'string') throw new Error('An ISO timestamp with an explicit offset or Z is required.');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error('An ISO timestamp with an explicit offset or Z is required.');
  const [, year, month, day, hour, minute, second = '0', , zone] = match;
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(Number(year), Number(month), 0);
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > lastDay.getUTCDate()
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    throw new Error('Invalid ISO calendar date or time.');
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('Invalid ISO timestamp.');
  return time;
}

export function validateScheduleRule(rule: ScheduleRule, nowMs?: number): void {
  if (!rule || typeof rule !== 'object') throw new Error('Invalid schedule rule.');
  const keys = rule.kind === 'once' ? ['kind', 'at'] : ['kind', 'expression', 'timezone'];
  if (Array.isArray(rule) || Object.keys(rule).some(key => !keys.includes(key))) throw new Error('Invalid schedule rule fields.');
  if (rule.kind === 'cron') {
    validateScheduleCron(rule.expression, rule.timezone);
  } else if (rule.kind === 'once') {
    const time = parseScheduleTimestamp(rule.at);
    if (time % 60_000 !== 0) throw new Error('One-shot timestamps must be aligned to a minute.');
    if (nowMs !== undefined && (!Number.isFinite(nowMs) || time <= nowMs || time - nowMs > MAX_SCHEDULE_DELAY_MS)) {
      throw new Error('One-shot time must be in the future and within 365 days.');
    }
  } else throw new Error('Unknown schedule rule.');
}

function once(time: number, nowMs: number): ScheduleRule {
  if (!Number.isFinite(nowMs) || !Number.isFinite(time) || time <= nowMs) {
    throw new Error('One-shot time must be in the future.');
  }
  const rounded = Math.ceil(time / 60_000) * 60_000;
  if (rounded - nowMs > MAX_SCHEDULE_DELAY_MS) throw new Error('One-shot time must be within 365 days after rounding.');
  const rule: ScheduleRule = { kind: 'once', at: new Date(rounded).toISOString() };
  validateScheduleRule(rule, nowMs);
  return rule;
}

/** Unrelated messages return undefined; malformed schedule commands never pass through. */
export function parseScheduleCommand(content: string, nowMs = Date.now()): ScheduleCommand | undefined {
  const command = /^\/schedule(?:\s+([\s\S]*))?$/.exec(content.trim());
  if (!command) return undefined;
  const args = (command[1] ?? '').trim();
  if (!args || args === 'help') return { kind: 'help' };
  if (args === 'capabilities' || args === 'list') return { kind: args };
  try {
    const cancel = /^cancel\s+(\S+)$/.exec(args);
    if (cancel) { validateScheduleId(cancel[1]); return { kind: 'cancel', id: cancel[1] }; }
    const split = /\s+--(?:\s+|$)/.exec(args);
    if (!split) throw new Error('Unknown operation or missing " -- " prompt separator.');
    const options = args.slice(0, split.index);
    const prompt = args.slice(split.index + split[0].length).trim();
    validateSchedulePrompt(prompt);
    let rule: ScheduleRule;
    const after = /^after\s+([1-9]\d*)([mhd])$/.exec(options);
    const at = /^at\s+(\S+)$/.exec(options);
    const cron = /^cron\s+"([^"\r\n]+)"\s+--tz\s+(\S+)$/.exec(options);
    if (after) {
      const count = Number(after[1]);
      if (!Number.isSafeInteger(count)) throw new Error('Invalid schedule delay.');
      const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[after[2] as 'm' | 'h' | 'd'];
      rule = once(nowMs + count * unit, nowMs);
    } else if (at) rule = once(parseScheduleTimestamp(at[1]), nowMs);
    else if (cron) {
      validateScheduleCron(cron[1], cron[2]);
      rule = { kind: 'cron', expression: cron[1].trim().replace(/\s+/g, ' '), timezone: cron[2] };
    } else throw new Error('Unknown operation or malformed schedule arguments.');
    return { kind: 'create', rule, prompt };
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : 'Invalid schedule command.' };
  }
}

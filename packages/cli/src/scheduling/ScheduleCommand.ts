import type { ScheduleRule } from './types';
import { parseScheduleTimestamp, validateHostCron } from './host/HostScheduleRule';
export { parseScheduleTimestamp } from './host/HostScheduleRule';

export const MAX_SCHEDULE_PROMPT_BYTES = 16 * 1024;
export const MAX_SCHEDULE_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
export const SCHEDULE_USAGE = [
  '/schedule',
  '/schedule capabilities',
  '/schedule list',
  '/schedule cancel <id>',
  '/schedule purge <managed-id,...|all>',
  '/schedule purge <managed-id,...> --forget-unresolved',
  '/schedule cleanup review [native-id,...]',
  '/schedule cleanup confirm <review-token> <request-id> <native-id,...>',
  '/schedule after <positive integer><m|h|d> -- <prompt>',
  '/schedule at <ISO timestamp with Z or offset> -- <prompt>',
  '/schedule cron "<five cron fields>" --tz <IANA timezone> -- <prompt>',
  'Claude and DSH schedules require their native host process to remain running; Claude shares the foreground conversation.',
  'Restarted schedules are marked interrupted and are never automatically recreated.',
  'One-shot times round up to the next minute; native firing times may include jitter.',
].join('\n');

export type ScheduleCommand =
  | { kind: 'help' | 'capabilities' | 'list' }
  | { kind: 'cancel'; id: string }
  | { kind: 'purge'; selection: { ids: string[]; forgetUnresolved?: true } | { all: true } }
  | { kind: 'cleanup-review'; ids?: string[] }
  | { kind: 'cleanup-confirm'; token: string; requestId: string; ids: string[] }
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

export function validateScheduleCron(expression: unknown, timezone: unknown): void {
  if (typeof expression !== 'string' || typeof timezone !== 'string') throw new Error('Invalid cron expression or timezone.');
  validateHostCron(expression, timezone);
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
    const review = /^cleanup review(?:\s+(\S+))?$/.exec(args);
    if (review) {
      const ids = review[1]?.split(','); ids?.forEach(validateScheduleId);
      return { kind: 'cleanup-review', ids };
    }
    const confirm = /^cleanup confirm\s+([a-f0-9-]{36})\s+(\S+)\s+(\S+)$/.exec(args);
    if (confirm) {
      validateScheduleId(confirm[2]); const ids = confirm[3].split(','); ids.forEach(validateScheduleId);
      return { kind: 'cleanup-confirm', token: confirm[1], requestId: confirm[2], ids };
    }
    const purge = /^purge\s+(\S+)(\s+--forget-unresolved)?$/.exec(args);
    if (purge) {
      if (purge[1] === '--forget-unresolved') throw new Error('Forgetting unresolved cleanup requires exact managed IDs.');
      if (purge[1] === 'all') {
        if (purge[2]) throw new Error('Forgetting unresolved cleanup requires exact managed IDs.');
        return { kind: 'purge', selection: { all: true } };
      }
      const ids = purge[1].split(','); ids.forEach(validateScheduleId);
      if (new Set(ids).size !== ids.length || ids.length > 500) throw new Error('Invalid purge selection.');
      return { kind: 'purge', selection: { ids, ...(purge[2] ? { forgetUnresolved: true } : {}) } };
    }
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

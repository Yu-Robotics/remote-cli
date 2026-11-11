import type { ScheduleRule } from '../types';

export function nativeRule(rule: ScheduleRule, now: number): { cron: string; timezone: string; recurring: boolean; at?: number } {
  if (rule.kind === 'once') {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00(?:\.000)?(Z|[+-]\d{2}:\d{2})$/.exec(rule.at);
    const at = Date.parse(rule.at);
    if (!match || !Number.isFinite(at) || at <= now) {
      throw new Error('One-shot schedules require a future absolute ISO timestamp at an exact minute; native timing is approximate.');
    }
    const [, year, month, day, hour, minute] = match;
    if (+month < 1 || +month > 12 || +day < 1 || +day > new Date(Date.UTC(+year, +month, 0)).getUTCDate()
      || +hour > 23 || +minute > 59) throw new Error('Invalid one-shot timestamp.');
    const date = new Date(at);
    // Five-field cron has no year. Reject dates whose previous annual match is still in the future.
    const previous = new Date(at);
    previous.setUTCFullYear(date.getUTCFullYear() - 1);
    if (previous.getTime() > now) throw new Error('One-shot time exceeds the native cron year horizon.');
    return { cron: `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`, timezone: 'UTC', recurring: false, at };
  }
  try { new Intl.DateTimeFormat('en', { timeZone: rule.timezone }).format(0); }
  catch { throw new Error('Cron schedules require a valid IANA timezone.'); }
  if (!rule.timezone || /^[+-]/.test(rule.timezone)) throw new Error('Cron schedules require a valid IANA timezone.');
  const fields = rule.expression.trim().split(/\s+/);
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  if (fields.length !== 5 || fields.some((field, index) => field.split(',').some(part => {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!match) return true;
    const [, start, end, step] = match;
    const [min, max] = bounds[index];
    return (start === '*' && end !== undefined) || (start !== '*' && (+start < min || +start > max))
      || (end !== undefined && (+end < +start || +end > max))
      || (step !== undefined && (+step < 1 || +step > max - min + 1));
  }))) throw new Error('Native cron requires five numeric fields with valid ranges, lists, and steps.');
  return { cron: fields.join(' '), timezone: rule.timezone, recurring: true };
}

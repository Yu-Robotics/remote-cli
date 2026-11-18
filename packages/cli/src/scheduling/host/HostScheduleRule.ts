import type { ScheduleRule } from '../types';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const DATE_LIMIT = 100_000_000 * DAY;
const MONTHS = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ');
const WEEKDAYS = 'SUN MON TUE WED THU FRI SAT'.split(' ');

function fieldValues(field: string, min: number, max: number, names: string[] = []): number[] {
  const values = new Set<number>();
  function value(token: string): number {
    if (/^\d+$/.test(token)) return Number(token);
    const index = names.indexOf(token.toUpperCase());
    return index === -1 ? NaN : min + index;
  }
  for (const part of field.split(',')) {
    const match = /^(\*|[a-zA-Z]+|\d+)(?:-([a-zA-Z]+|\d+))?(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error('Invalid cron field.');
    const [, first, last, stride] = match;
    const wildcard = first === '*';
    const step = stride === undefined ? 1 : Number(stride);
    if ((wildcard && last) || (stride && !wildcard && !last) || step < 1 || step > max - min + 1) {
      throw new Error('Invalid cron range or step.');
    }
    const start = wildcard ? min : value(first);
    let end = wildcard ? max : value(last ?? first);
    if (names === WEEKDAYS && last?.toUpperCase() === 'SUN' && start > 0) end = 7;
    if (!(start >= min && end <= max && start <= end)) throw new Error('Invalid cron value or descending range.');
    for (let n = start; n <= end; n += step) values.add(names === WEEKDAYS && n === 7 ? 0 : n);
  }
  return [...values].sort((a, b) => a - b);
}

function parseCron(expression: string, timezone: string) {
  if (typeof expression !== 'string' || expression.length > 256) throw new Error('Invalid cron expression.');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron requires exactly five fields.');
  if (typeof timezone !== 'string' || timezone.length > 128 || !/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(timezone)) {
    throw new Error('An explicit IANA timezone is required.');
  }
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }); }
  catch { throw new Error('Unknown IANA timezone.'); }
  return {
    minutes: fieldValues(fields[0], 0, 59), hours: fieldValues(fields[1], 0, 23),
    days: fieldValues(fields[2], 1, 31), months: fieldValues(fields[3], 1, 12, MONTHS),
    weekdays: fieldValues(fields[4], 0, 7, WEEKDAYS),
    eitherDay: !fields[2].startsWith('*') && !fields[4].startsWith('*'), formatter,
  };
}

export function validateHostCron(expression: string, timezone: string): void {
  parseCron(expression, timezone);
}

function offsetAt(formatter: Intl.DateTimeFormat, instant: number): number {
  const offset = formatter.formatToParts(instant).find(part => part.type === 'timeZoneName')?.value;
  if (offset === 'GMT') return 0;
  const match = /^GMT([+-])(\d\d):(\d\d)(?::(\d\d))?$/.exec(offset ?? '');
  if (!match) throw new Error('Cannot resolve IANA timezone offset.');
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0);
  return (match[1] === '+' ? 1000 : -1000) * seconds;
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

export function nextHostDue(rule: ScheduleRule, afterMs: number): number | undefined {
  if (!Number.isFinite(new Date(afterMs).getTime())) throw new Error('Invalid schedule reference time.');
  if (rule.kind === 'once') {
    const at = parseScheduleTimestamp(rule.at);
    return at > afterMs ? at : undefined;
  }
  const cron = parseCron(rule.expression, rule.timezone);
  if (afterMs >= DATE_LIMIT) return undefined;
  const localAfter = afterMs + offsetAt(cron.formatter, afterMs);
  // Treat UTC calendar fields as wall-clock coordinates until a matching minute is found.
  const date = new Date(Math.floor(localAfter / DAY) * DAY);
  const lastYear = date.getUTCFullYear() + 400; // One complete Gregorian calendar cycle.
  while (date.getUTCFullYear() <= lastYear) {
    if (!cron.months.includes(date.getUTCMonth() + 1)) {
      date.setUTCMonth(date.getUTCMonth() + 1, 1);
      continue;
    }
    const dom = cron.days.includes(date.getUTCDate());
    const dow = cron.weekdays.includes(date.getUTCDay());
    if (cron.eitherDay ? dom || dow : dom && dow) {
      const day = date.getTime();
      // Sample on both sides of this civil day, including transitions that skip an entire date.
      const offsets = [...new Set([offsetAt(cron.formatter, Math.max(-DATE_LIMIT, day - DAY)),
        offsetAt(cron.formatter, Math.min(DATE_LIMIT, day + 2 * DAY))])]
        .sort((a, b) => b - a);
      for (const hour of cron.hours) {
        for (const minute of cron.minutes) {
          const wall = day + (hour * 60 + minute) * MINUTE;
          if (wall <= localAfter) continue;
          for (const offset of offsets) {
            const instant = wall - offset;
            if (Math.abs(instant) > DATE_LIMIT || offsetAt(cron.formatter, instant) !== offset) continue;
            // The largest valid offset is the first instant in an overlap, even if it already passed.
            if (instant > afterMs) return instant;
            break;
          }
        }
      }
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return undefined;
}

import { describe, expect, it } from 'vitest';
import { nextHostDue, validateHostCron } from '../../src/scheduling/host/HostScheduleRule';

function next(expression: string, after: string, timezone = 'UTC'): string | undefined {
  const due = nextHostDue({ kind: 'cron', expression, timezone }, Date.parse(after));
  return due === undefined ? undefined : new Date(due).toISOString();
}

describe('host schedule clock', () => {
  it('returns a one-shot only strictly before its instant', () => {
    const once = { kind: 'once' as const, at: '2032-02-29T05:45:00+05:45' };
    const due = Date.parse('2032-02-29T00:00:00Z');
    expect(nextHostDue(once, due - 1)).toBe(due);
    expect(nextHostDue(once, due)).toBeUndefined();
    expect(nextHostDue(once, due + 1)).toBeUndefined();
    expect(() => nextHostDue({ ...once, at: '2031-02-29T00:00Z' }, due)).toThrow();
    expect(() => nextHostDue(once, NaN)).toThrow();
  });

  it('handles sparse and impossible Gregorian dates', () => {
    expect(next('0 0 29 feb *', '2096-02-29T00:00Z')).toBe('2104-02-29T00:00:00.000Z');
    expect(next('5 8 31 apr *', '2030-01-01T00:00Z')).toBeUndefined();
    const everyMinute = { kind: 'cron' as const, expression: '* * * * *', timezone: 'UTC' };
    const maxInstant = 8_640_000_000_000_000;
    expect(nextHostDue(everyMinute, maxInstant - 1)).toBe(maxInstant);
    expect(nextHostDue(everyMinute, maxInstant)).toBeUndefined();
  });

  it('combines restricted DOM and DOW using OR and recognizes both numeric Sundays', () => {
    const start = '2030-05-31T23:59:59Z';
    for (const sunday of ['0', '7', 'sUn']) {
      const expression = `0 0 1 * ${sunday}`;
      expect(next(expression, start)).toBe('2030-06-01T00:00:00.000Z'); // Saturday, the first.
      expect(next(expression, '2030-06-01T00:00Z')).toBe('2030-06-02T00:00:00.000Z');
    }
    expect(next('0 0 * * FRI-SUN', '2030-06-02T00:00Z')).toBe('2030-06-07T00:00:00.000Z');
    expect(next('0 0 */2 * MON', '2030-06-03T00:00Z')).toBe('2030-06-17T00:00:00.000Z');
  });

  it('expands named ranges, lists and steps with strict minute boundaries', () => {
    const expression = '5-35/15,55 8,10 * jan-mar/2,sep mon-fri';
    expect(next(expression, '2030-02-01T00:00Z')).toBe('2030-03-01T08:05:00.000Z');
    expect(next(expression, '2030-03-01T08:05Z')).toBe('2030-03-01T08:20:00.000Z');
    expect(next(expression, '2030-03-01T08:04:59.999Z')).toBe('2030-03-01T08:05:00.000Z');
  });

  it('skips nonexistent local minutes and uses only the earlier instant of a repeated minute', () => {
    const zone = 'America/New_York';
    expect(next('30 2 * * *', '2024-03-09T07:30Z', zone)).toBe('2024-03-11T06:30:00.000Z');
    expect(next('30 1 * * *', '2024-11-03T05:29Z', zone)).toBe('2024-11-03T05:30:00.000Z');
    for (const after of ['2024-11-03T05:30Z', '2024-11-03T06:05Z', '2024-11-03T06:30Z']) {
      expect(next('30 1 * * *', after, zone)).toBe('2024-11-04T06:30:00.000Z');
    }
    expect(next('* * * * *', '2024-11-03T05:59Z', zone)).toBe('2024-11-03T07:00:00.000Z');
  });

  it('resolves non-hour offsets, half-hour overlaps and skipped calendar dates', () => {
    expect(next('0 0 * * *', '2030-06-01T00:00Z', 'Asia/Kathmandu')).toBe('2030-06-01T18:15:00.000Z');
    expect(next('45 1 * * *', '2024-04-06T14:44Z', 'Australia/Lord_Howe')).toBe('2024-04-06T14:45:00.000Z');
    expect(next('45 1 * * *', '2024-04-06T15:00Z', 'Australia/Lord_Howe')).toBe('2024-04-07T15:15:00.000Z');
    expect(next('0 0 30 dec *', '2011-12-29T10:00Z', 'Pacific/Apia')).toBe('2012-12-29T10:00:00.000Z');
  });

  it('rejects invalid input at both validation and calculation', () => {
    for (const [expression, timezone] of [['0 0 * * XYZ', 'UTC'], ['0 0 * FEB-JAN *', 'UTC'],
      ['0 0 * * *', 'Unknown/Zone'], ['0 0 * * *', '+05:45']]) {
      expect(() => validateHostCron(expression, timezone)).toThrow();
      expect(() => next(expression, '2030-01-01T00:00Z', timezone)).toThrow();
    }
  });
});

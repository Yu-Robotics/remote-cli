import { describe, expect, it } from 'vitest';
import { MAX_SCHEDULE_DELAY_MS, parseScheduleCommand, SCHEDULE_USAGE } from '../src/scheduling/ScheduleCommand';

const now = Date.parse('2030-01-01T00:00:10Z');
const parse = (text: string) => parseScheduleCommand(text, now);

describe('ScheduleCommand', () => {
  it('recognizes only the command and returns explicit control actions', () => {
    expect(parse('Explain /schedule')).toBeUndefined();
    expect(parse('/schedules')).toBeUndefined();
    expect(parse('/schedule')).toEqual({ kind: 'help' });
    expect(parse('/schedule help')).toEqual({ kind: 'help' });
    expect(parse('/schedule capabilities')).toEqual({ kind: 'capabilities' });
    expect(parse('/schedule list')).toEqual({ kind: 'list' });
    expect(parse('/schedule cancel schedule-1')).toEqual({ kind: 'cancel', id: 'schedule-1' });
    expect(SCHEDULE_USAGE).toContain('Claude and DSH');
    expect(SCHEDULE_USAGE).toContain('Claude shares the foreground conversation');
    expect(SCHEDULE_USAGE).toContain('never automatically recreated');
  });

  it.each([
    ['1m', '2030-01-01T00:02:00.000Z'],
    ['2h', '2030-01-01T02:01:00.000Z'],
    ['1d', '2030-01-02T00:01:00.000Z'],
  ])('rounds relative delay %s upward to a minute', (delay, at) => {
    expect(parse(`/schedule after ${delay} -- Check CI`)).toEqual({ kind: 'create', rule: { kind: 'once', at }, prompt: 'Check CI' });
  });

  it('accepts explicit offsets and preserves multiline prompts and literal shell text', () => {
    expect(parse('/schedule at 2030-01-01T08:01:01+08:00 -- Check CI\nThen explain -- $(example)')).toEqual({
      kind: 'create', rule: { kind: 'once', at: '2030-01-01T00:02:00.000Z' }, prompt: 'Check CI\nThen explain -- $(example)',
    });
    expect(parse('/schedule at 2030-01-01T00:01Z -- Check')).toMatchObject({ rule: { at: '2030-01-01T00:01:00.000Z' } });
    expect(parse('/schedule at 2032-02-29T00:00Z -- Check')).toMatchObject({ kind: 'invalid' });
    expect(parseScheduleCommand('/schedule at 2032-02-29T00:00Z -- Check', Date.parse('2032-02-28T00:00Z'))).toMatchObject({ kind: 'create' });
  });

  it('enforces the future horizon after rounding', () => {
    const aligned = Date.parse('2030-01-01T00:00:00Z');
    expect(parseScheduleCommand('/schedule after 365d -- Check', aligned)).toMatchObject({ kind: 'create' });
    expect(parse('/schedule after 365d -- Check')).toMatchObject({ kind: 'invalid' });
    expect(parseScheduleCommand(`/schedule at ${new Date(aligned + MAX_SCHEDULE_DELAY_MS + 1).toISOString()} -- Check`, aligned)).toMatchObject({ kind: 'invalid' });
    expect(parseScheduleCommand('/schedule after 1m -- Check', NaN)).toMatchObject({ kind: 'invalid' });
  });

  it.each([
    'after 0m -- Check', 'after -1h -- Check', 'after 1.5m -- Check', 'after 1s -- Check',
    'after 9007199254740992d -- Check', 'after 366d -- Check', 'after 1m Check', 'after 1m --',
    'at 2030-01-01T00:00:09Z -- Check', 'at 2030-01-01T00:00:10Z -- Check',
    'at 2030-01-01T01:00:00 -- Check', 'at 2030-02-30T00:00:00Z -- Check',
    'at 2030-02-29T00:00:00Z -- Check', 'at 2030-00-01T00:00:00Z -- Check',
    'at 2030-01-00T00:00:00Z -- Check', 'at 2030-01-02T24:00:00Z -- Check',
    'at 2030-01-02T00:60:00Z -- Check', 'at 2030-01-02T00:00:60Z -- Check',
    'at 2030-01-02T00:00:00+24:00 -- Check', 'at 2030-01-02T00:00:00+01:60 -- Check',
    'cancel ../escape', 'cancel __proto__', 'cancel constructor', 'cancel id extra',
    'cancel', 'list extra', 'capabilities extra', 'unknown -- Check', 'after 1m -- \0',
  ])('rejects malformed command %j without passthrough', args => {
    expect(parse(`/schedule ${args}`)).toMatchObject({ kind: 'invalid' });
  });

  it.each(['*/5 * * * *', '0,15,30,45 8-18/2 1-31 1,6,12 0-7', '0 9 * * 1-5'])('accepts numeric cron grammar %s', expression => {
    expect(parse(`/schedule cron "${expression}" --tz America/New_York -- Check`)).toEqual({
      kind: 'create', rule: { kind: 'cron', expression, timezone: 'America/New_York' }, prompt: 'Check',
    });
  });

  it.each([
    '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8',
    '*/0 * * * *', '*/61 * * * *', '1-5/0 * * * *', '20-10 * * * *', '1-60 * * * *',
    '1,,2 * * * *', ',1 * * * *', '1, * * * *', '1/2 * * * *', '*/-2 * * * *',
    '1.2 * * * *', '? * * * *', '0 0 L * *', '0 0 * JAN MON', '@daily',
    '0 0 * * 1#2', '* * * * 1W', '* * * * *;echo', '999999999999999999999 * * * *',
  ])('rejects invalid cron values or dialect %s', expression => {
    expect(parse(`/schedule cron "${expression}" --tz UTC -- Check`)).toMatchObject({ kind: 'invalid' });
  });

  it.each(['cron "* * * * *" -- Check', 'cron * * * * * --tz UTC -- Check',
    'cron "* * * * *" --tz Unknown/Zone -- Check', 'cron "* * * * *" --tz +08:00 -- Check',
    'cron "* * * * *" --tz UTC extra -- Check'])('requires quoted cron and a valid explicit timezone: %s', args => {
    expect(parse(`/schedule ${args}`)).toMatchObject({ kind: 'invalid' });
  });

  it('bounds UTF-8 prompt bytes rather than JavaScript string length', () => {
    expect(parse(`/schedule after 1m -- ${'x'.repeat(16 * 1024)}`)).toMatchObject({ kind: 'create' });
    expect(parse(`/schedule after 1m -- ${'x'.repeat(16 * 1024 + 1)}`)).toMatchObject({ kind: 'invalid' });
    expect(parse(`/schedule after 1m -- ${'\u{1f680}'.repeat(4097)}`)).toMatchObject({ kind: 'invalid' });
  });
});

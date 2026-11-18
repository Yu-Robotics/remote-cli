import { describe, expect, it } from 'vitest';
import { assertHostScheduleBackend, assertNativeScheduleBackend, isNativeScheduleBackend, HOST_SCHEDULE_CAPABILITIES, SCHEDULE_CAPABILITIES } from '../src/scheduling/ScheduleCapabilities';

describe('managed scheduling eligibility', () => {
  it('advertises host timing for each registered backend', () => {
    expect(Object.keys(HOST_SCHEDULE_CAPABILITIES).sort()).toEqual([
      'agy', 'claude', 'codex', 'dsh', 'kimi', 'opencode', 'pi', 'zcode',
    ]);
    expect(Object.values(HOST_SCHEDULE_CAPABILITIES).every(value => value.supported)).toBe(true);
    for (const backend of ['claude', 'agy', 'dsh'] as const) {
      expect(() => assertNativeScheduleBackend(backend)).not.toThrow();
      expect(isNativeScheduleBackend(backend)).toBe(true);
      expect(HOST_SCHEDULE_CAPABILITIES[backend].detail).toContain('one-shot or recurring cron');
    }
    expect(isNativeScheduleBackend(null)).toBe(false);
  });

  it('distinguishes durable definitions, safe dispatch and legacy cleanup', () => {
    expect(SCHEDULE_CAPABILITIES).toContain('keeps new task definitions across restarts');
    expect(SCHEDULE_CAPABILITIES).toContain('skips firings missed while the CLI was offline');
    expect(SCHEDULE_CAPABILITIES).toContain('require access to the original conversation');
    expect(SCHEDULE_CAPABILITIES).toContain('Feishu thread');
    expect(SCHEDULE_CAPABILITIES).toContain('does not repeat a dispatch with an unknown outcome');
    expect(SCHEDULE_CAPABILITIES).toContain('manual cleanup');
  });

  it.each(['codex', 'kimi', 'opencode', 'pi', 'zcode'] as const)(
    'admits %s host timing independently of native provider availability', backend => {
      const capability = HOST_SCHEDULE_CAPABILITIES[backend];
      expect(isNativeScheduleBackend(backend)).toBe(false);
      expect(() => assertNativeScheduleBackend(backend)).toThrow(/Native scheduling is unsupported/);
      expect(() => assertHostScheduleBackend(backend)).not.toThrow();
      expect(SCHEDULE_CAPABILITIES).toContain(`- ${capability.label}: supported (runtime checks required). ${capability.detail}`);
    },
  );

  it.each(['unknown', 'auto', 'constructor', '__proto__', ''])('rejects unrecognized backend %s', backend => {
    expect(isNativeScheduleBackend(backend)).toBe(false);
    expect(() => assertNativeScheduleBackend(backend)).toThrow('unknown backend');
  });
});

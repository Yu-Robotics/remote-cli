import { describe, expect, it } from 'vitest';
import { assertNativeScheduleBackend, isNativeScheduleBackend, NATIVE_SCHEDULE_CAPABILITIES, SCHEDULE_CAPABILITIES } from '../src/scheduling/ScheduleCapabilities';

describe('native scheduling eligibility', () => {
  it('describes abrupt AGY interruption without granting legacy admission', () => {
    const detail = NATIVE_SCHEDULE_CAPABILITIES.agy.detail;
    expect(detail).toContain('Fresh original ACP conversations');
    expect(detail).toContain('Legacy stream-json selections refuse execution until explicit clear');
    expect(detail).toContain('managed workers use ACP without native scheduling');
    expect(detail).not.toContain('retain their compatible transport');
    expect(detail).toContain('Scheduling recovery after any exit is unsupported');
    expect(detail).toContain('Uncertain work retains ownership');
    expect(detail).not.toMatch(/\d+\.\d+\.\d+/);
    expect(() => assertNativeScheduleBackend('agy')).not.toThrow();
  });

  it('accounts for all eight backends and advertises only verified adapters', () => {
    expect(Object.keys(NATIVE_SCHEDULE_CAPABILITIES).sort()).toEqual([
      'agy', 'claude', 'codex', 'dsh', 'kimi', 'opencode', 'pi', 'zcode',
    ]);
    expect(Object.entries(NATIVE_SCHEDULE_CAPABILITIES).filter(([, value]) => value.supported)
      .map(([backend]) => backend)).toEqual(['claude', 'agy', 'dsh']);
    expect(NATIVE_SCHEDULE_CAPABILITIES.claude.supported).toBe(true);
    expect(() => assertNativeScheduleBackend('claude')).not.toThrow();
    expect(() => assertNativeScheduleBackend('dsh')).not.toThrow();
    expect(isNativeScheduleBackend('dsh')).toBe(true);
    expect(isNativeScheduleBackend('claude')).toBe(true);
    expect(isNativeScheduleBackend(null)).toBe(false);
    expect(SCHEDULE_CAPABILITIES).toContain('runtime checks required');
    expect(SCHEDULE_CAPABILITIES).toContain('automatic restoration is not provided');
    expect(SCHEDULE_CAPABILITIES).not.toContain('2.1.311');
    expect(SCHEDULE_CAPABILITIES).toContain('Every exit is treated as abrupt');
    expect(SCHEDULE_CAPABILITIES).toContain('Active work, unsettled native mutations and pending results remain independent safety gates');
    expect(SCHEDULE_CAPABILITIES).toContain('runs expired one-shots late');
    expect(NATIVE_SCHEDULE_CAPABILITIES.dsh.detail).toContain('never automatically restored');
    expect(SCHEDULE_CAPABILITIES).toContain('Claude, fresh AGY ACP and DSH tasks share their original native conversation and later chat messages');
    expect(NATIVE_SCHEDULE_CAPABILITIES.claude.detail).toContain('timezone must match the native session');
  });

  it.each(['codex', 'kimi', 'opencode', 'pi', 'zcode'] as const)(
    'explains the %s admission failure consistently with capability reporting', backend => {
      const capability = NATIVE_SCHEDULE_CAPABILITIES[backend];
      expect(isNativeScheduleBackend(backend)).toBe(false);
      expect(() => assertNativeScheduleBackend(backend)).toThrow(capability.detail);
      expect(SCHEDULE_CAPABILITIES).toContain(`- ${capability.label}: temporarily unsupported. ${capability.detail}`);
    },
  );

  it.each(['unknown', 'auto', 'constructor', '__proto__', ''])('rejects unrecognized backend %s', backend => {
    expect(isNativeScheduleBackend(backend)).toBe(false);
    expect(() => assertNativeScheduleBackend(backend)).toThrow('unknown backend');
  });
});

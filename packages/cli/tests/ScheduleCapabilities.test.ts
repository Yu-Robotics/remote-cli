import { describe, expect, it } from 'vitest';
import { assertNativeScheduleBackend, isNativeScheduleBackend, NATIVE_SCHEDULE_CAPABILITIES, SCHEDULE_CAPABILITIES } from '../src/scheduling/ScheduleCapabilities';

describe('native scheduling eligibility', () => {
  it('accounts for all eight backends and advertises only verified adapters', () => {
    expect(Object.keys(NATIVE_SCHEDULE_CAPABILITIES).sort()).toEqual([
      'agy', 'claude', 'codex', 'dsh', 'kimi', 'opencode', 'pi', 'zcode',
    ]);
    expect(Object.entries(NATIVE_SCHEDULE_CAPABILITIES).filter(([, value]) => value.supported)
      .map(([backend]) => backend)).toEqual(['claude', 'dsh']);
    expect(NATIVE_SCHEDULE_CAPABILITIES.claude.supported).toBe(true);
    expect(() => assertNativeScheduleBackend('claude')).not.toThrow();
    expect(() => assertNativeScheduleBackend('dsh')).not.toThrow();
    expect(isNativeScheduleBackend('dsh')).toBe(true);
    expect(isNativeScheduleBackend('claude')).toBe(true);
    expect(isNativeScheduleBackend(null)).toBe(false);
    expect(SCHEDULE_CAPABILITIES).toContain('runtime checks required');
    expect(SCHEDULE_CAPABILITIES).toContain('Eligible waiting jobs permit verified handoff');
    expect(SCHEDULE_CAPABILITIES).toContain('Running or unconfirmed work still blocks upgrades');
    expect(SCHEDULE_CAPABILITIES).toContain('Expired one-shots are not run late');
    expect(NATIVE_SCHEDULE_CAPABILITIES.dsh.detail).toContain('Dirty crashes and uncertain native work remain blocked');
    expect(SCHEDULE_CAPABILITIES).toContain('Claude and DSH tasks share their original native conversation and later chat messages');
    expect(NATIVE_SCHEDULE_CAPABILITIES.claude.detail).toContain('timezone must match the native session');
  });

  it.each(['codex', 'agy', 'kimi', 'opencode', 'pi', 'zcode'] as const)(
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

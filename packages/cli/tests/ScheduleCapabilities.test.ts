import { describe, expect, it } from 'vitest';
import { assertNativeScheduleBackend, isNativeScheduleBackend, NATIVE_SCHEDULE_CAPABILITIES, SCHEDULE_CAPABILITIES } from '../src/scheduling/ScheduleCapabilities';

describe('native scheduling eligibility', () => {
  it('describes checkpointed AGY recovery without granting legacy or dirty-exit admission', () => {
    const detail = NATIVE_SCHEDULE_CAPABILITIES.agy.detail;
    expect(detail).toContain('Fresh or clean-checkpointed original ACP conversations');
    expect(detail).toContain('Saved stream-json conversations without a trusted checkpoint');
    expect(detail).toContain('exact host retirement before every possible first wake');
    expect(detail).toContain('Due work, dirty exits and ambiguous operations remain blocked');
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
    expect(SCHEDULE_CAPABILITIES).toContain('Claude jobs with verified native runtime capabilities');
    expect(SCHEDULE_CAPABILITIES).not.toContain('2.1.311');
    expect(SCHEDULE_CAPABILITIES).toContain('Eligible waiting jobs permit verified handoff');
    expect(SCHEDULE_CAPABILITIES).toContain('Running or unconfirmed work still blocks upgrades');
    expect(SCHEDULE_CAPABILITIES).toContain('Expired one-shots are not run late');
    expect(NATIVE_SCHEDULE_CAPABILITIES.dsh.detail).toContain('Dirty crashes and uncertain native work remain blocked');
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

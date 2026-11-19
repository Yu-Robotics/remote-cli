import { describe, expect, it } from 'vitest';
import {
  assertHostScheduleBackend, assertNativeScheduleBackend, HOST_SCHEDULE_CAPABILITIES,
  isHostScheduleBackend, isNativeScheduleBackend, SCHEDULE_CAPABILITIES,
} from '../src/scheduling/ScheduleCapabilities';

describe('managed scheduling eligibility', () => {
  const backends = [
    { key: 'agy', label: 'AGY', nativeHistory: true },
    { key: 'claude', label: 'Claude', nativeHistory: true },
    { key: 'codex', label: 'Codex', nativeHistory: false },
    { key: 'dsh', label: 'DSH', nativeHistory: true },
    { key: 'kimi', label: 'Kimi', nativeHistory: false },
    { key: 'opencode', label: 'OpenCode', nativeHistory: false },
    { key: 'pi', label: 'Pi', nativeHistory: false },
    { key: 'zcode', label: 'ZCode', nativeHistory: false },
  ] as const;

  it('lists exactly the supported backend keys', () => {
    expect(Object.keys(HOST_SCHEDULE_CAPABILITIES).sort()).toEqual(backends.map(backend => backend.key));
  });

  it.each(backends)('advertises and admits host timing for $label', ({ key, label, nativeHistory }) => {
    const capability = HOST_SCHEDULE_CAPABILITIES[key];
    expect(() => assertHostScheduleBackend(key)).not.toThrow();
    expect(capability.supported).toBe(true);
    expect(capability.detail).toContain('one-shot or recurring cron');
    expect(SCHEDULE_CAPABILITIES.split('\n')).toContain(`- ${label}: supported (runtime checks required). ${capability.detail}`);

    expect(isNativeScheduleBackend(key)).toBe(nativeHistory);
    if (nativeHistory) {
      expect(() => assertNativeScheduleBackend(key)).not.toThrow();
    } else {
      expect(() => assertNativeScheduleBackend(key)).toThrow(/Native scheduling is unsupported/);
    }
  });

  it('distinguishes durable definitions, safe dispatch and legacy cleanup', () => {
    expect(SCHEDULE_CAPABILITIES).toContain('keeps new task definitions across restarts');
    expect(SCHEDULE_CAPABILITIES).toContain('skips firings missed while the CLI was offline');
    expect(SCHEDULE_CAPABILITIES).toContain('require access to the original conversation');
    expect(SCHEDULE_CAPABILITIES).toContain('Feishu thread');
    expect(SCHEDULE_CAPABILITIES).toContain('does not repeat a dispatch with an unknown outcome');
    expect(SCHEDULE_CAPABILITIES).toContain('manual cleanup');
  });

  it('rejects a missing backend identity', () => {
    expect(isHostScheduleBackend(null)).toBe(false);
    expect(isNativeScheduleBackend(null)).toBe(false);
  });

  it.each(['unknown', 'auto', 'constructor', '__proto__', ''])('rejects unrecognized backend %s', backend => {
    expect(() => assertHostScheduleBackend(backend)).toThrow('unknown backend');
    expect(isNativeScheduleBackend(backend)).toBe(false);
    expect(() => assertNativeScheduleBackend(backend)).toThrow('unknown backend');
  });
});

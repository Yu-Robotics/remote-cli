import { randomUUID } from 'crypto';
import { vi } from 'vitest';
import type * as OwnershipRuntime from '../../src/delegation/OwnershipRuntime';

/** Replace boot discovery only for in-process fake-worker manager fixtures. */
export function syntheticOwnershipRuntime(actual: typeof OwnershipRuntime) {
  // Keep the host's real PID/birth semantics, gates, journals, and recovery
  // validation. Native ownership suites must not use this fixture.
  const identity = { host: 'synthetic-manager-host', boot: 'synthetic-manager-boot', namespace: 'host' };
  return {
    ...actual,
    ownerRecord: vi.fn(() => ({ version: 2 as const, token: randomUUID(), pid: process.pid,
      birth: actual.processBirth(process.pid), ...identity })),
    assertRecoverable: (raw: Buffer, journalPath: string, current = identity) =>
      actual.assertRecoverable(raw, journalPath, current),
  };
}

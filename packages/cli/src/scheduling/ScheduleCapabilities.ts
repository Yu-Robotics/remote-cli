import type { BackendKey } from '../types/config';

interface ScheduleCapability {
  readonly label: string;
  readonly supported: boolean;
  readonly detail: string;
}

/** Backend eligibility for new CLI-timed tasks in the original thread. */
export const HOST_SCHEDULE_CAPABILITIES = {
  claude: {
    label: 'Claude', supported: true,
    detail: 'The CLI can submit a one-shot or recurring cron task to the original Claude thread.',
  },
  codex: {
    label: 'Codex', supported: true,
    detail: 'The CLI can submit a one-shot or recurring cron task to the original Codex thread.',
  },
  agy: {
    label: 'AGY', supported: true,
    detail: 'The CLI can submit a one-shot or recurring cron task to the original AGY ACP thread. Existing ACP session and ownership checks apply. Legacy stream-json selections require explicit clear.',
  },
  dsh: {
    label: 'DSH', supported: true,
    detail: 'The CLI can submit a one-shot or recurring cron task to the original DSH thread. Existing session and ownership checks apply.',
  },
  kimi: {
    label: 'Kimi', supported: true,
    detail: 'The CLI can submit a one-shot or recurring cron task to the original Kimi thread.',
  },
  opencode: {
    label: 'OpenCode', supported: true,
    detail: 'The CLI can submit a one-shot or recurring cron task to the original OpenCode thread.',
  },
  pi: {
    label: 'Pi', supported: true,
    detail: 'The CLI can submit a one-shot or recurring cron task to the original Pi thread.',
  },
  zcode: {
    label: 'ZCode', supported: true,
    detail: 'The CLI can submit a one-shot or recurring cron task to the original ZCode thread.',
  },
} as const satisfies Record<BackendKey, ScheduleCapability>;

export function isHostScheduleBackend(value: unknown): value is BackendKey {
  return typeof value === 'string' && Object.hasOwn(HOST_SCHEDULE_CAPABILITIES, value);
}

export function assertHostScheduleBackend(value: string): asserts value is BackendKey {
  if (!isHostScheduleBackend(value)) throw new Error('Scheduling is unsupported for this unknown backend. Use /schedule capabilities.');
}

/** Historical catalog/result identities remain readable when new creation is disabled. */
export type NativeScheduleBackend = 'claude' | 'dsh' | 'agy';

export function isNativeScheduleBackend(value: unknown): value is NativeScheduleBackend {
  return value === 'claude' || value === 'dsh' || value === 'agy';
}

/** Foreground product admission; catalog identity and installed provider support are separate. */
export function assertNativeScheduleBackend(backend: string): asserts backend is NativeScheduleBackend {
  assertHostScheduleBackend(backend);
  if (!isNativeScheduleBackend(backend)) throw new Error('Native scheduling is unsupported for this backend.');
}

/** Product capabilities are deliberately distinct from an available adapter. */
export const SCHEDULE_CAPABILITIES = [
  'CLI-hosted scheduled tasks by backend',
  ...Object.values(HOST_SCHEDULE_CAPABILITIES).map(capability =>
    `- ${capability.label}: ${capability.supported ? 'supported (runtime checks required)' : 'temporarily unsupported'}. ${capability.detail}`),
  '',
  'The local CLI keeps new task definitions across restarts. Keep it running when a task is due. Cron uses the specified IANA timezone and skips firings missed while the CLI was offline.',
  'Runs require access to the original conversation. The CLI sends results to its Feishu thread and does not repeat a dispatch with an unknown outcome.',
  'Use /schedule list to find the task ID and /schedule cancel <id> to stop future runs. Existing native tasks stay in the catalog for manual cleanup.',
].join('\n');

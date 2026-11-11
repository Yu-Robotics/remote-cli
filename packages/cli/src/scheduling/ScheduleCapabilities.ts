import type { BackendKey } from '../types/config';

interface ScheduleCapability {
  readonly label: string;
  readonly supported: boolean;
  readonly detail: string;
}

/** Native timing AND an existing-transport result path are required for admission. */
export const NATIVE_SCHEDULE_CAPABILITIES = {
  claude: {
    label: 'Claude', supported: true,
    detail: 'One-shot and recurring cron; requires advertised native tools/lifecycle capabilities, unrestricted execution, and a compatible Router.',
  },
  codex: {
    label: 'Codex', supported: false,
    detail: 'Codex 0.167.0 app-server delegates automation tools to its client; it has no native scheduled-job engine. In-turn sleep is not a managed schedule.',
  },
  agy: {
    label: 'AGY', supported: false,
    detail: 'AGY 1.5.5 has native scheduling, but tested stream-json recurring results appeared only after another input, without separate occurrence completion.',
  },
  dsh: {
    label: 'DSH', supported: true,
    detail: 'Native one-shot and recurring scheduling through a process-owned plugin overlay and ACP event adapter; isolated job storage is never automatically reopened.',
  },
  kimi: {
    label: 'Kimi', supported: false,
    detail: 'Kimi 2.5.0 has native cron, but its ACP server filters output to the active client prompt and drops autonomous scheduled turns.',
  },
  opencode: {
    label: 'OpenCode', supported: false,
    detail: 'OpenCode 1.19.5 has no built-in scheduler. Version 2.2.7 has native scheduling, but its ACP bridge closes root-output subscriptions after the client prompt ends.',
  },
  pi: {
    label: 'Pi', supported: false,
    detail: 'Pi coding-agent 1.5.2 has no built-in scheduler in its CLI RPC runtime; the first-party durable timer harness is a separate runtime.',
  },
  zcode: {
    label: 'ZCode', supported: false,
    detail: 'ZCode 3.17.2 / CLI 0.17.1 app-server delegates Cron management to its host; native timing and dispatch require the separate desktop scheduler and host services.',
  },
} as const satisfies Record<BackendKey, ScheduleCapability>;

export type NativeScheduleBackend = {
  [Key in BackendKey]: typeof NATIVE_SCHEDULE_CAPABILITIES[Key]['supported'] extends true ? Key : never;
}[BackendKey];

export function isNativeScheduleBackend(value: unknown): value is NativeScheduleBackend {
  return typeof value === 'string' && Object.hasOwn(NATIVE_SCHEDULE_CAPABILITIES, value)
    && NATIVE_SCHEDULE_CAPABILITIES[value as BackendKey].supported;
}

/** Reject unsupported/unknown backends without falling back to another executor. */
export function assertNativeScheduleBackend(backend: string): asserts backend is NativeScheduleBackend {
  if (!Object.hasOwn(NATIVE_SCHEDULE_CAPABILITIES, backend)) {
    throw new Error('Native scheduling is temporarily unsupported for this unknown backend. Use /schedule capabilities to inspect supported backends.');
  }
  const capability = NATIVE_SCHEDULE_CAPABILITIES[backend as BackendKey];
  if (!capability.supported) {
    throw new Error(`${capability.label} scheduling is temporarily unsupported. ${capability.detail} Use /schedule capabilities to inspect supported backends.`);
  }
}

/** Product capabilities are deliberately distinct from an available adapter. */
export const SCHEDULE_CAPABILITIES = [
  'Native scheduling adapters:',
  ...Object.values(NATIVE_SCHEDULE_CAPABILITIES).map(capability =>
    `- ${capability.label}: ${capability.supported ? 'supported (runtime checks required)' : 'temporarily unsupported'}. ${capability.detail}`),
  '',
  'Each task uses a separate native session with its own prompt and captured working directory/model. Conversation history is not copied.',
  'The native backend owns timing. No Router timer or periodic model polling is used.',
  'Keep the CLI running. Restart reports interruption instead of recreating tasks. Claude jobs are session-only; DSH uses isolated native storage that is never automatically reopened.',
  'Timing is approximate and recurring Claude jobs expire after seven days. Use an explicit IANA timezone for recurring cron.',
].join('\n');

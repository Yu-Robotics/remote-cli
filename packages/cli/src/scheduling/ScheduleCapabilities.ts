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
    detail: 'One-shot and recurring cron in the foreground native conversation, including later messages. Requires native tools, lifecycle/hooks, unrestricted execution, and a compatible Router. Recurring timezone must match the native session.',
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
    detail: 'Native scheduling in the foreground conversation through supported host CRUD and ACP extensions. Eligible new jobs recover in the original session after confirmed orderly shutdown or upgrade. Dirty crashes and uncertain native work remain blocked.',
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

/** Historical catalog/result identities remain readable when new creation is disabled. */
export type NativeScheduleBackend = 'claude' | 'dsh';

export function isNativeScheduleBackend(value: unknown): value is NativeScheduleBackend {
  return value === 'claude' || value === 'dsh';
}

/** Validate catalog identities, including retained Claude jobs. Creation checks supported separately. */
export function assertNativeScheduleBackend(backend: string): asserts backend is NativeScheduleBackend {
  if (!Object.hasOwn(NATIVE_SCHEDULE_CAPABILITIES, backend)) {
    throw new Error('Native scheduling is temporarily unsupported for this unknown backend. Use /schedule capabilities to inspect supported backends.');
  }
  const capability = NATIVE_SCHEDULE_CAPABILITIES[backend as BackendKey];
  if (!isNativeScheduleBackend(backend)) {
    throw new Error(`${capability.label} scheduling is temporarily unsupported. ${capability.detail} Use /schedule capabilities to inspect supported backends.`);
  }
}

/** Product capabilities are deliberately distinct from an available adapter. */
export const SCHEDULE_CAPABILITIES = [
  'Native scheduling adapters:',
  ...Object.values(NATIVE_SCHEDULE_CAPABILITIES).map(capability =>
    `- ${capability.label}: ${capability.supported ? 'supported (runtime checks required)' : 'temporarily unsupported'}. ${capability.detail}`),
  '',
  'Claude and DSH tasks share their original native conversation and later chat messages. Separate schedules in that thread share context; no transcript copy is made.',
  'The native backend owns timing. No Router timer or periodic model polling is used.',
  'Keep the CLI running for native timing. Supported Claude 2.1.311 Linux x64 and DSH jobs recover after verified orderly handoff in the original session. Dirty crashes remain unsupported.',
  'Restart recovery is a separate provider capability. Eligible waiting jobs permit verified handoff before automatic upgrades. Claude may skip fired but not-yet-admitted occurrences; admitted execution and background work must drain. DSH drains queued work. Running or unconfirmed work still blocks upgrades. Expired one-shots are not run late and missed cron firings are not replayed.',
  'Timing is approximate and recurring Claude jobs expire after seven days. Use an explicit IANA timezone for recurring cron.',
].join('\n');

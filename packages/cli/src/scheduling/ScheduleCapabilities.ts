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
    label: 'AGY', supported: true,
    detail: 'Fresh or clean-checkpointed original ACP conversations, after native hook/receipt qualification. Saved stream-json conversations without a trusted checkpoint and managed workers stay on their compatible transport. Native once/cron, exact cancellation and idle batch delivery are supported; cron timezone must match the host. Foreground cancellation and orderly restart can restore never-fired future definitions only after exact host retirement before every possible first wake, with no unknown queued work. Due work, dirty exits and ambiguous operations remain blocked with ownership retained. No executable-version gate.',
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
export type NativeScheduleBackend = 'claude' | 'dsh' | 'agy';

export function isNativeScheduleBackend(value: unknown): value is NativeScheduleBackend {
  return value === 'claude' || value === 'dsh' || value === 'agy';
}

/** Foreground product admission; catalog identity and installed provider support are separate. */
export function assertNativeScheduleBackend(backend: string): asserts backend is NativeScheduleBackend {
  if (!Object.hasOwn(NATIVE_SCHEDULE_CAPABILITIES, backend)) {
    throw new Error('Native scheduling is temporarily unsupported for this unknown backend. Use /schedule capabilities to inspect supported backends.');
  }
  const capability = NATIVE_SCHEDULE_CAPABILITIES[backend as BackendKey];
  if (!isNativeScheduleBackend(backend) || !capability.supported) {
    throw new Error(`${capability.label} scheduling is temporarily unsupported. ${capability.detail} Use /schedule capabilities to inspect supported backends.`);
  }
}

/** Product capabilities are deliberately distinct from an available adapter. */
export const SCHEDULE_CAPABILITIES = [
  'Native scheduling adapters:',
  ...Object.values(NATIVE_SCHEDULE_CAPABILITIES).map(capability =>
    `- ${capability.label}: ${capability.supported ? 'supported (runtime checks required)' : 'temporarily unsupported'}. ${capability.detail}`),
  '',
  'Claude, fresh AGY ACP and DSH tasks share their original native conversation and later chat messages. Separate schedules in that thread share context; no transcript copy is made.',
  'The native backend owns timing. No Router timer or periodic model polling is used.',
  'Keep the CLI running for native timing. Claude jobs with verified native runtime capabilities and DSH jobs recover after verified orderly handoff in the original session. New Claude recurring jobs can also adopt exact native definitions after verified same-machine reboot. Same-boot crashes, unexplained missing definitions and uncertain one-shots remain blocked.',
  'Restart recovery is a separate provider capability. Eligible waiting jobs permit verified handoff before automatic upgrades. Claude may skip fired but not-yet-admitted occurrences; admitted execution and background work must drain. DSH drains queued work. Running or unconfirmed work still blocks upgrades. Expired one-shots are not run late and missed cron firings are not replayed.',
  'Timing is approximate and recurring Claude jobs expire after seven days. Use an explicit IANA timezone for recurring cron.',
].join('\n');

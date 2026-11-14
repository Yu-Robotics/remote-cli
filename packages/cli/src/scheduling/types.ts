import type { NativeScheduleBackend } from './ScheduleCapabilities';

/** Backend-native timing; adapters must never substitute a local scheduler. */
export type ScheduleRule =
  | { kind: 'once'; at: string }
  | { kind: 'cron'; expression: string; timezone: string };

export interface NativeScheduleInput {
  id: string;
  /** Captured by the framework, never supplied by the model. */
  threadId?: string;
  /** Omitted by legacy callers to select the original Claude provider. */
  backend?: NativeScheduleBackend;
  rule: ScheduleRule;
  prompt: string;
  cwd: string;
  command?: string;
  model?: string;
  effort?: string;
  /** Framework-issued identity persisted before CREATE, never model supplied. */
  recovery?: ScheduleRecoveryCheckpoint;
}

export type ScheduleHandoffPolicy = 'drain-all' | 'skip-unadmitted';
export interface NativeScheduleRelease {
  nativeDefinitionAbsent: true; policy?: ScheduleHandoffPolicy;
  /** Inventory absence before deletion: do not reconstruct this one-shot, without inventing an occurrence ID. */
  onceDefinitionAlreadyAbsent?: true;
}

export interface ScheduleRecoveryCheckpoint {
  version: 1;
  provider: string;
  strategy: 'reattach' | 'reconstruct';
  /** Provider-owned native session and ownership identity; not a transcript. */
  identity: string;
  orderlyOnly?: true;
  handoffPolicy?: ScheduleHandoffPolicy;
  handoff?: 'clean';
  /** Separate release evidence: a clean pause alone does not prove deletion. */
  nativeDefinitionAbsent?: true;
}

/** Opt-in protocol. A conversation resume ID or a catalog lookup is not evidence. */
export interface NativeScheduleRecovery {
  readonly provider: string;
  readonly strategy: ScheduleRecoveryCheckpoint['strategy'];
  readonly orderlyOnly?: true;
  readonly handoffPolicy?: ScheduleHandoffPolicy;
  /** After all job releases: stop and join the exact owned native host. */
  finishRestart?(): Promise<void>;
  /** All jobs for this owner are terminal after recovery (for example expired).
   * Release only a confirmed exited host's admission fence; never start a host.
   */
  releaseRestartAdmission?(): void;
  /** Pure description: MUST NOT start a host or mutate native state. */
  describe(input: NativeScheduleInput, owner: ScheduleOwner): string;
  /**
   * Reconcile authoritative inventory under the original identity, excluding any
   * surviving predecessor. Never blindly CREATE, adopt unmanaged jobs, replay an
   * uncertain occurrence or catch up missed cron ticks. Restore original native
   * context, not a summary/fork. Repeated attempts MUST be idempotent even after
   * an error-after-commit. Refuse unknown inventory, ownership or execution state.
   * Honor cancellation before admission, bound native operations, and retain a
   * cleanup handle in NativeScheduleCleanupError for any uncertain mutation.
   */
  reconcile(record: ScheduleRecord, context: { notBefore: number; signal: AbortSignal; isCurrent(): boolean; isOwnerCurrent?(): boolean },
    onEvent: (event: NativeScheduleEvent) => void): Promise<NativeScheduleHandle>;
}

export type NativeScheduleEvent =
  | { type: 'started'; occurrenceId: string }
  | { type: 'skipped'; occurrenceId: string; reason: string }
  | { type: 'completed'; occurrenceId: string; success: boolean; output?: string; error?: string }
  | { type: 'stopped'; reason: string; exitConfirmed?: boolean };

/** Native job ownership; process exit or job retirement is never automatically reversed. */
export interface NativeScheduleHandle {
  readonly nativeId: string;
  /** Confirmed original native context, captured after initial creation. */
  readonly recoveryIdentity?: string;
  readonly onceDefinitionAlreadyAbsent?: true;
  /** Shared-session deletion leaves an already started occurrence running. */
  readonly cancellationKeepsRunning?: boolean;
  /**
   * Optional orderly shutdown handoff. Exclude new firings and prove
   * no admitted execution remains. A negotiated skip-unadmitted policy may discard
   * queued/pre-admission occurrences without replay, preserving future intent.
   * Reject uncertainty. This is not cancellation and must not kill shared work.
   * Return absence evidence only after verifying native deletion; a paused
   * persistent definition still needs cleanup if the durable intent is cancelled.
   */
  releaseForRestart?(): Promise<void | NativeScheduleRelease>;
  /** Native list verification, not a local catalog lookup. */
  list(): Promise<boolean>;
  /** Confirm native deletion; an already executing occurrence may finish. */
  cancel(): Promise<void>;
  /** Retire this job; a shared provider must never stop other jobs or their conversation. */
  stop(): Promise<void>;
}

export interface NativeScheduleProvider {
  /** Pure capability lookup; absent means restart recovery is unsupported. */
  recoveryFor?(input: NativeScheduleInput): NativeScheduleRecovery | undefined;
  create(input: NativeScheduleInput, onEvent: (event: NativeScheduleEvent) => void): Promise<NativeScheduleHandle>;
}

/** Failed creation must retain a cleanup handle when native exit is unconfirmed. */
export class NativeScheduleCleanupError extends Error {
  constructor(message: string, readonly handle: NativeScheduleHandle) { super(message); }
}

export interface ScheduleOwner {
  threadId: string;
  openId: string;
  generation: string;
}

export interface ScheduleRecord extends ScheduleOwner {
  id: string;
  backend: NativeScheduleBackend;
  cwd: string;
  prompt: string;
  rule: ScheduleRule;
  createdAt: number;
  nativeId?: string;
  state: 'creating' | 'active' | 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed';
  error?: string;
  /** Durable intent, even on adapters that cannot yet recover it. */
  execution?: { command?: string; model?: string; effort?: string };
  /** Cancellation intent is written before native deletion; never resurrect it. */
  cancelRequested?: true;
  recovery?: ScheduleRecoveryCheckpoint & { status: 'eligible' | 'pending' | 'blocked' };
  /** Bounded replay suppression; external delivery is not globally exactly-once. */
  completedOccurrences?: string[];
  /** Observed pre-admission skips, a subset of the dedupe history, not successes. */
  skippedOccurrences?: string[];
}

/** Deliver a complete occurrence to the original owner, using its stable ID. */
export interface ScheduleDelivery {
  id: string;
  schedule: ScheduleRecord;
  occurrenceId: string;
  success: boolean;
  output?: string;
  error?: string;
}

/** A backend tool action authorized by a managed operation, never arbitrary model dispatch. */
export interface NativeScheduleToolAction { tool: string; input: Record<string, unknown> }

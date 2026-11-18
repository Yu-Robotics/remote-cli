import type { NativeScheduleBackend } from './ScheduleCapabilities';
import type { BackendKey } from '../types/config';

export type ScheduleRule =
  | { kind: 'once'; at: string }
  | { kind: 'cron'; expression: string; timezone: string };

export interface NativeScheduleInput {
  id: string;
  /** Framework-selected timing engine and original conversation binding. */
  engine?: 'host';
  sessionId?: string;
  /** Original Router binding for host execution and result delivery. */
  bindingEpoch?: string;
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
  /** Framework-issued cleanup identity persisted before CREATE; legacy storage shape. */
  recovery?: ScheduleOwnershipMetadata;
}

export type HostScheduleInput = Omit<NativeScheduleInput, 'engine' | 'backend' | 'recovery'> & {
  engine: 'host';
  backend: BackendKey;
  sessionId: string;
  bindingEpoch: string;
};

/** Legacy catalog shape retained for exact cleanup and diagnostics, never a resume capability. */
export interface ScheduleOwnershipMetadata {
  version: 1;
  provider: string;
  strategy: 'reattach' | 'reconstruct';
  /** Provider-owned native session and ownership identity; not a transcript. */
  identity: string;
  /** Legacy diagnostic field; never authorizes recovery. */
  orderlyOnly?: true;
  abrupt?: true;
  /** Legacy diagnostics only; no field here authorizes execution after host loss. */
  futureOnly?: true;
  handoffPolicy?: 'drain-all' | 'skip-unadmitted';
  handoff?: 'clean';
  /** Legacy diagnostic only; current native absence requires fresh framework verification. */
  nativeDefinitionAbsent?: true;
}

/** Exact ownership metadata and deletion only; never starts or restores a scheduled job. */
export interface NativeScheduleCleanup {
  readonly provider: string;
  /** Legacy catalog identity discriminator, not a restart strategy. */
  readonly strategy: ScheduleOwnershipMetadata['strategy'];
  describe(input: NativeScheduleInput, owner: ScheduleOwner): string;
  cancelRetained?(record: ScheduleRecord, context: { isCurrent(): boolean }): Promise<void>;
}

export type NativeScheduleEvent =
  /** Await durable original-session attribution before any native CREATE mutation. */
  | { type: 'attributed'; cleanupIdentity: string }
  | { type: 'started'; occurrenceId: string }
  | { type: 'completed'; occurrenceId: string; success: boolean; output?: string; error?: string }
  | { type: 'stopped'; reason: string; exitConfirmed?: boolean };

/** Native job ownership; process exit or job retirement is never automatically reversed. */
export interface NativeScheduleHandle {
  readonly nativeId: string;
  /** Original native context for exact deletion, never execution authorization. */
  readonly cleanupIdentity?: string;
  readonly onceDefinitionAlreadyAbsent?: true;
  /** Shared-session deletion leaves an already started occurrence running. */
  readonly cancellationKeepsRunning?: boolean;
  /** False retains execution ownership even with no observed running occurrence.
   * A native definition list may omit queued, not-yet-observed notifications.
   * Undefined preserves the existing providers' retirement contract. */
  readonly retirementConfirmed?: boolean;
  /** Fresh local absence evidence; invalidated when its native host exits. */
  readonly nativeDefinitionAbsent?: boolean;
  /** Native list verification, not a local catalog lookup. */
  list(): Promise<boolean>;
  /** Confirm native deletion; an already executing occurrence may finish. */
  cancel(): Promise<void>;
  /** Retire this job; a shared provider must never stop other jobs or their conversation. */
  stop(): Promise<void>;
}

/** Provider proved refusal before starting native admission or mutation. Not absence evidence. */
export class NativeScheduleNotAdmittedError extends Error {}

/** Failed creation must retain a cleanup handle when native exit is unconfirmed. */
export class NativeScheduleCleanupError extends Error {
  constructor(message: string, readonly handle: NativeScheduleHandle) { super(message); }
}

export interface ScheduleOwner {
  threadId: string;
  openId: string;
  generation: string;
  /** Authenticated Router binding for host schedules. Legacy native ownership predates epochs. */
  bindingEpoch?: string;
}

export interface ScheduleRecord extends ScheduleOwner {
  id: string;
  engine?: 'host';
  sessionId?: string;
  /** Host occurrence identity is derived from its scheduled UTC millisecond. */
  nextDueAt?: number;
  /** Admission was persisted before the native turn. Never replay this slot. */
  inFlightDueAt?: number;
  backend: BackendKey;
  cwd: string;
  prompt: string;
  rule: ScheduleRule;
  createdAt: number;
  nativeId?: string;
  state: 'creating' | 'active' | 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed';
  error?: string;
  /** Original execution settings retained for exact cleanup attribution. */
  execution?: { command?: string; model?: string; effort?: string };
  /** Cancellation intent is written before native deletion; never resurrect it. */
  cancelRequested?: true;
  /** Provider explicitly refused before any native admission; not inferred from
   * an error, missing native ID, process exit or terminal catalog state. */
  creationRefused?: true;
  /** Framework-observed native deletion AND execution retirement, not a state inference.
   * Cancellation remains permanent; this receipt never grants execution recovery. */
  cleanupConfirmed?: true;
  /** Historical field name is retained for catalog compatibility; execution restoration is absent. */
  recovery?: ScheduleOwnershipMetadata & { status: 'eligible' | 'pending' | 'blocked' };
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

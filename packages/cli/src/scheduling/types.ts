import type { NativeScheduleBackend } from './ScheduleCapabilities';

/** Backend-native timing; adapters must never substitute a local scheduler. */
export type ScheduleRule =
  | { kind: 'once'; at: string }
  | { kind: 'cron'; expression: string; timezone: string };

export interface NativeScheduleInput {
  id: string;
  /** Omitted by legacy callers to select the original Claude provider. */
  backend?: NativeScheduleBackend;
  rule: ScheduleRule;
  prompt: string;
  cwd: string;
  command?: string;
  model?: string;
  effort?: string;
}

export type NativeScheduleEvent =
  | { type: 'started'; occurrenceId: string }
  | { type: 'completed'; occurrenceId: string; success: boolean; output?: string; error?: string }
  | { type: 'stopped'; reason: string; exitConfirmed?: boolean };

/** A dedicated native process owns one schedule; its store must never be automatically reopened. */
export interface NativeScheduleHandle {
  readonly nativeId: string;
  /** Native list verification, not a local catalog lookup. */
  list(): Promise<boolean>;
  /** Confirm native deletion; an already executing occurrence may finish. */
  cancel(): Promise<void>;
  /** Confirm process exit and retire owned native jobs/storage without resuming them. */
  stop(): Promise<void>;
}

export interface NativeScheduleProvider {
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

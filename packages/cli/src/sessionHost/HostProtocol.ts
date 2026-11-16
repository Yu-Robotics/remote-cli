import { createHash, createHmac, timingSafeEqual } from 'crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const HOST_PROTOCOL = 1;
export const HOST_CAPABILITIES = ['frontend-lease-v1', 'durable-operation-v1', 'output-replay-v1', 'sequenced-requests-v1', 'launcher-recovery-v1'] as const;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Private launcher metadata, never a model tool result or native resume proof. */
export interface HostAddress { port: number; hostId: string; installationId: string }
export interface FrontendLease { frontendId: string; epoch: number; token: string }
export interface OperationReceipt {
  requestId: string;
  status: 'pending' | 'completed' | 'failed' | 'unknown';
  result?: Json;
  error?: 'runtime_failed' | 'invalid_runtime_result' | 'host_restarted' | 'storage_unavailable';
}
export interface HostEvent extends OperationReceipt { id: string; sequence: number }
export interface HostRuntime {
  /** Stable authority within this live host, not a PID or a restored-session claim. */
  readonly authorityId: string;
  /** The adapter validates native owner/scope; this protocol does not invent native APIs.
   * Return at most MAX_PAYLOAD_BYTES of JSON. Larger native output requires an
   * adapter-owned durable artifact reference, not truncation by this protocol.
   */
  execute(operation: { requestId: string; method: string; args: Json }): Promise<Json>;
  /** Explicit host shutdown only. Must settle all accepted executions before resolving. */
  stop(): Promise<void>;
  /** Synchronous admission check before closing command transport. No native side effects. */
  assertCanStop?(): void;
  /** Read-only runtime snapshot; must not dispatch native work. */
  inspect?(method: string, args: Json): Promise<Json>;
}

export class HostError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function fields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new HostError('invalid_request');
}
export function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new HostError('invalid_identifier');
}
export function integer(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new HostError('invalid_integer');
}
export function secret(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new HostError('invalid_secret');
}
/** Canonical JSON rejects lossy values and bounds nesting before hashing or dispatch. */
export function canonical(value: unknown, depth = 0): string {
  if (depth > 16) throw new HostError('invalid_payload');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
  }
  throw new HostError('invalid_payload');
}
export function payload(value: unknown): Json {
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES) throw new HostError('payload_too_large');
  return JSON.parse(encoded) as Json;
}
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
/** Domain-separated authentication; the installation secret never crosses IPC. */
export function sign(key: string, direction: 'request' | 'response', nonce: string, timestamp: string, data: string): string {
  return createHmac('sha256', key).update([direction, nonce, timestamp, data].join('\n')).digest('hex');
}
export function matchesSignature(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual)
    && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

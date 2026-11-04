import path from 'path';
import { stableHistoryHash, validHistoryDirectory, verifyHistoryDirectory } from './NativeHistoryFiles';
import type { NativeDirectoryIdentity, NativeDeletionResult } from './NativeSessionDeletion';
import { ZCodeClient } from '../executor/zcode/ZCodeClient';
import { resolveZCodeLaunch } from '../executor/zcode/ZCodeCommand';

/** zai-org/ZCode@a9fe401eede6e6e5e01be9048679c206fe6f02d9:
 * packages/shared/src/zcode-protocol-v4/session-data/contract.ts;
 * apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-data/index.ts.
 * Purge cascades to native owned descendants (not forks), removes their native
 * files before their DB rows, and retains running/referenced roots. Empty
 * directories is mandatory: workspace memory is outside this adapter's scope.
 */
export interface ZCodeDeletionTarget {
  version: 1;
  backend: 'zcode';
  nativeVersion: 'zcode-session-data-v4';
  provenance: 'created';
  sessionId: string;
  executorThreadId: string;
  cwd: string;
  command: string;
  home: NativeDirectoryIdentity;
  /** Resolved storage.dir, not storage.dir/cli. Captured before native creation. */
  nativeHome: NativeDirectoryIdentity;
  pointerHash: string;
}
export interface ZCodeArtifactReceipt {
  /** Durable export outside nativeHome; never the disposable task worktree. */
  root: NativeDirectoryIdentity;
  manifestHash: string;
}
export interface ZCodeDeletionPreparation {
  version: 1;
  nativeVersion: 'zcode-session-data-v4';
  targetHash: string;
  sessionIds: string[];
  artifacts: ZCodeArtifactReceipt;
}
/** Required integration seam: the shared store owns parent/generation/exit and
 * pointer exclusivity. Native measure aggregates sizes; it DOES NOT enumerate
 * descendants or prove ownership. Never implement inspectOwnedTree using it.
 */
export interface ZCodeDeletionRecovery {
  prepared?: ZCodeDeletionPreparation;
  persistPrepared?: (value: ZCodeDeletionPreparation) => Promise<void>;
  persistMaintenanceState?: (unconfirmed: boolean) => Promise<void>;
  /** Recheck creation receipt, exact pointers, all writers and complete native
   * owned closure, including session_task_link. Reject adopted/shared members.
   * A missing root is admissible only with this exact durable prepared receipt.
   */
  inspectOwnedTree: (target: ZCodeDeletionTarget, prepared?: ZCodeDeletionPreparation) => Promise<string[]>;
  /** Export all required native deliverables BEFORE purge: artifacts, exec,
   * agents, sessions and any deliverables in DB cascade rows for the whole tree.
   * Preserve remote-cli task/code/Git recovery artifacts independently.
   */
  preserveArtifacts: (target: ZCodeDeletionTarget, sessionIds: readonly string[]) => Promise<ZCodeArtifactReceipt>;
  /** Verify the immutable export manifest and bytes, also on absent-root retries. */
  verifyArtifacts: (receipt: ZCodeArtifactReceipt, target: ZCodeDeletionTarget, sessionIds: readonly string[]) => Promise<void>;
}
export interface ZCodeDeletionTransport {
  requestSessionData(action: 'measure' | 'purge', sessionId: string): Promise<unknown>;
  destroy(): void;
  waitForExit(): Promise<void>;
  waitForManagedProcessGroupExit(): Promise<void>;
}
export type ZCodeDeletionFactory = (target: ZCodeDeletionTarget) => ZCodeDeletionTransport;
const safeId = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 128 && !/[^A-Za-z0-9_-]/.test(s);
const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: any, expected: string[]) => object(v) && Object.keys(v).sort().join(',') === [...expected].sort().join(',');
const sha = (s: unknown) => typeof s === 'string' && s.length === 64 && /^[a-f0-9]{64}$/.test(s);
const absolute = (s: unknown): s is string => typeof s === 'string' && path.isAbsolute(s) && path.normalize(s) === s && !s.includes('\0');
export function validZCodeDeletionTarget(value: any): value is ZCodeDeletionTarget {
  return object(value) && value.version === 1 && value.backend === 'zcode' && value.nativeVersion === 'zcode-session-data-v4'
    && value.provenance === 'created' && safeId(value.sessionId) && absolute(value.cwd)
    && safeId(value.executorThreadId) && /^delegate-lane-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.executorThreadId)
    && typeof value.command === 'string' && value.command.length > 0 && value.command.length < 4096 && !value.command.includes('\0')
    && validHistoryDirectory(value.home) && validHistoryDirectory(value.nativeHome) && sha(value.pointerHash);
}
function closure(ids: unknown, root: string): string[] {
  if (!Array.isArray(ids) || !ids.length || ids.length > 4096 || !ids.every(safeId)
    || new Set(ids).size !== ids.length || !ids.includes(root)) throw new Error('ZCode owned tree is incomplete');
  return [...ids].sort();
}
function validArtifacts(receipt: any, target: ZCodeDeletionTarget): receipt is ZCodeArtifactReceipt {
  return keys(receipt, ['root', 'manifestHash']) && validHistoryDirectory(receipt.root) && sha(receipt.manifestHash)
    && receipt.root.path !== target.nativeHome.path && !receipt.root.path.startsWith(target.nativeHome.path + path.sep)
    && receipt.root.path !== target.cwd && !receipt.root.path.startsWith(target.cwd + path.sep);
}
export function validZCodeDeletionPreparation(target: ZCodeDeletionTarget, value: any): value is ZCodeDeletionPreparation {
  try {
    return validZCodeDeletionTarget(target) && keys(value, ['version', 'nativeVersion', 'targetHash', 'sessionIds', 'artifacts'])
      && value.version === 1 && value.nativeVersion === target.nativeVersion && value.targetHash === stableHistoryHash(target)
      && JSON.stringify(value.sessionIds) === JSON.stringify(closure(value.sessionIds, target.sessionId)) && validArtifacts(value.artifacts, target);
  } catch { return false; }
}
function measure(value: unknown, id: string): void {
  if (!keys(value, ['sessions', 'memory'])) throw new Error('Unsupported ZCode measure response');
  const v = value as any;
  if (!Array.isArray(v.memory) || v.memory.length || !Array.isArray(v.sessions) || v.sessions.length !== 1
    || !keys(v.sessions[0], ['sessionId', 'bytes']) || v.sessions[0].sessionId !== id
    || !Number.isSafeInteger(v.sessions[0].bytes) || v.sessions[0].bytes < 0) throw new Error('Unsupported ZCode measure scope');
}
function outcome(value: unknown, id: string): NativeDeletionResult {
  if (!keys(value, ['deleted', 'kept', 'failed', 'memory'])) throw new Error('Invalid ZCode purge response');
  const v = value as any;
  if (![v.deleted, v.kept, v.failed, v.memory].every(Array.isArray) || v.memory.length
    || v.deleted.length + v.kept.length + v.failed.length !== 1) throw new Error('Ambiguous ZCode purge result');
  if (v.deleted.length) {
    const row = v.deleted[0];
    if (!keys(row, ['sessionId', 'bytes']) || row.sessionId !== id || !Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new Error('Wrong ZCode deletion acknowledgement');
    return { state: 'deleted', reason: 'ZCode permanent native purge acknowledged; durable artifacts were preserved' };
  }
  if (v.kept.length) {
    const row = v.kept[0];
    if (!keys(row, ['sessionId', 'reason']) || row.sessionId !== id || !['running', 'referenced'].includes(row.reason)) throw new Error('Ambiguous ZCode retained root');
    return { state: 'held', reason: row.reason === 'running' ? 'ZCode retained a running native tree' : 'ZCode retained a native tree referenced by another session' };
  }
  const row = v.failed[0];
  if (!keys(row, ['sessionId', 'code']) || row.sessionId !== id || typeof row.code !== 'string' || !row.code.length) throw new Error('Ambiguous ZCode purge failure');
  return { state: 'uncertain', reason: 'ZCode reported a partial native purge; exact preparation and exports are retained for retry' };
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('ZCode maintenance timed out')), 15_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
const defaultFactory: ZCodeDeletionFactory = target => {
  const launch = resolveZCodeLaunch(target.command);
  launch.env = { ...launch.env, HOME: target.home.path, USERPROFILE: target.home.path, ZCODE_STORAGE_DIR: target.nativeHome.path };
  return new ZCodeClient({ cwd: target.cwd, launch, delegationWorker: true, maintenance: true }, {});
};
/** This adapter deliberately has no unchecked purge-only entrypoint. Every call,
 * including retry, requires the shared ownership verifier and artifact verifier.
 * There is no archive fallback, DB write, session/create/resume or model turn.
 */
export async function deleteOwnedZCodeSession(target: ZCodeDeletionTarget, recovery: ZCodeDeletionRecovery,
  factory: ZCodeDeletionFactory = defaultFactory): Promise<NativeDeletionResult> {
  let client: ZCodeDeletionTransport | undefined;
  let deleting = false;
  let result: NativeDeletionResult = { state: 'held', reason: 'ZCode ownership or artifact preservation is unconfirmed' };
  try {
    if (process.platform !== 'linux') return { state: 'unsupported', reason: 'ZCode native writer proof requires Linux' };
    if (!validZCodeDeletionTarget(target) || !recovery.persistMaintenanceState || !recovery.inspectOwnedTree
      || !recovery.preserveArtifacts || !recovery.verifyArtifacts) throw new Error('Missing ZCode safety contract');
    await verifyHistoryDirectory(target.home); await verifyHistoryDirectory(target.nativeHome);
    let prepared = recovery.prepared;
    if (prepared && !validZCodeDeletionPreparation(target, prepared)) throw new Error('ZCode preparation changed');
    const ids = closure(await recovery.inspectOwnedTree(target, prepared), target.sessionId);
    if (prepared && JSON.stringify(ids) !== JSON.stringify(prepared.sessionIds)) throw new Error('ZCode cascade changed');
    await recovery.persistMaintenanceState(true);
    client = factory(target);
    measure(await bounded(client.requestSessionData('measure', target.sessionId)), target.sessionId);
    if (!prepared) {
      if (!recovery.persistPrepared) throw new Error('Durable ZCode preparation is required');
      const artifacts = await recovery.preserveArtifacts(target, ids);
      prepared = { version: 1, nativeVersion: target.nativeVersion, targetHash: stableHistoryHash(target), sessionIds: ids, artifacts };
      if (!validZCodeDeletionPreparation(target, prepared)) throw new Error('Invalid ZCode artifact receipt');
      await recovery.verifyArtifacts(artifacts, target, ids);
      await recovery.persistPrepared(prepared);
    }
    if (!validZCodeDeletionPreparation(target, prepared)) throw new Error('ZCode preparation changed');
    await recovery.verifyArtifacts(prepared.artifacts, target, prepared.sessionIds);
    await verifyHistoryDirectory(target.home); await verifyHistoryDirectory(target.nativeHome);
    if (JSON.stringify(closure(await recovery.inspectOwnedTree(target, prepared), target.sessionId)) !== JSON.stringify(prepared.sessionIds)) throw new Error('ZCode cascade changed');
    deleting = true;
    result = outcome(await bounded(client.requestSessionData('purge', target.sessionId)), target.sessionId);
  } catch (error) {
    result = (error as { code?: number })?.code === -32601
      ? { state: 'unsupported', reason: 'ZCode native permanent purge protocol is unavailable' }
      : { state: deleting ? 'uncertain' : 'held', reason: deleting
        ? 'ZCode native purge outcome is uncertain; exact preparation and exports are retained'
        : 'ZCode ownership, cascade, protocol or artifact preparation could not be verified' };
  } finally {
    if (client) {
      try {
        client.destroy();
        await bounded(client.waitForExit()); await bounded(client.waitForManagedProcessGroupExit());
        await recovery.persistMaintenanceState!(false);
      } catch { result = { state: 'uncertain', reason: 'ZCode maintenance writer exit is unconfirmed' }; }
    }
  }
  return result;
}

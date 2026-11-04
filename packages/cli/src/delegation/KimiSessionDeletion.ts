import { AcpClient } from '../executor/acp/AcpClient';
import { verifyHistoryTarget, type OwnedHistoryTarget } from './NativeHistoryFiles';
import { deletionPreparation, validDeletionPreparation, type NativeDeletionRecovery, type NativeDeletionResult } from './NativeSessionDeletion';

/** MoonshotAI/kimi-code@ec495f0cb00f6db9a9118bf979112886f4264a41, packages/acp-server/src/server.ts. */
export function kimiDeletionCapability(value: any): boolean {
  const capability = value?.agentCapabilities?.sessionCapabilities?.delete;
  return value?.protocolVersion === 1
    && !!capability && typeof capability === 'object' && !Array.isArray(capability);
}
export interface KimiDeletionTransport {
  initialize(): Promise<unknown>;
  permanentDelete(sessionId: string): Promise<unknown>;
  destroy(): void;
  waitForExit(): Promise<void>;
  waitForManagedProcessGroupExit(): Promise<void>;
}
/** No new/load/resume, authentication, MCP setup, KAP, or model requests. */
export class KimiDeletionClient extends AcpClient implements KimiDeletionTransport {
  protected override sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!['initialize', 'session/delete'].includes(method)) return Promise.reject(new Error('Disallowed Kimi maintenance request'));
    return super.sendRequest(method, params);
  }
  permanentDelete(sessionId: string): Promise<unknown> { return this.sendRequest('session/delete', { sessionId }); }
}
export type KimiDeletionFactory = (target: OwnedHistoryTarget) => KimiDeletionTransport;
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Kimi maintenance timed out')), 15_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
export async function deleteOwnedKimiSession(target: OwnedHistoryTarget, recovery: NativeDeletionRecovery,
  factory: KimiDeletionFactory = value => new KimiDeletionClient(value.command, ['acp'], value.cwd, {}, true, {
    delegationWorker: true,
    env: { ...process.env, HOME: value.home.path, USERPROFILE: value.home.path, KIMI_CODE_HOME: value.nativeHome.path },
    onStderr: () => {},
  })): Promise<NativeDeletionResult> {
  let client: KimiDeletionTransport | undefined;
  let deleting = false;
  let result: NativeDeletionResult = { state: 'held', reason: 'Kimi ownership could not be verified' };
  try {
    if (process.platform !== 'linux' || target.backend !== 'kimi') return { state: 'unsupported', reason: 'Kimi native writer proof is unsupported' };
    await verifyHistoryTarget(target, recovery.detachedPointer);
    if (recovery.prepared && !validDeletionPreparation(target, recovery.prepared)) throw new Error('Kimi preparation changed');
    if (!recovery.persistMaintenanceState) throw new Error('Durable maintenance fencing is required');
    await recovery.persistMaintenanceState(true);
    client = factory(target);
    if (!kimiDeletionCapability(await bounded(client.initialize()))) {
      result = { state: 'unsupported', reason: 'Kimi ACP permanent deletion capability is unavailable' };
    } else {
      if (!recovery.prepared) {
        if (!recovery.persistPrepared) throw new Error('Durable preparation is required');
        await recovery.persistPrepared(deletionPreparation(target));
      }
      await verifyHistoryTarget(target, recovery.detachedPointer);
      deleting = true;
      let response: unknown;
      try { response = await bounded(client.permanentDelete(target.sessionId)); }
      catch (error) {
        const rpc = error as { code?: number; data?: any; rpcMessage?: string };
        // acp-server/server.ts:358 at ec495f0: exact missing identity, never list absence.
        if (recovery.prepared && rpc.code === -32602 && rpc.rpcMessage === `Unknown sessionId: ${target.sessionId}`
          && rpc.data?.sessionId === target.sessionId && Object.keys(rpc.data).length === 1) response = {};
        else throw error;
      }
      if (!response || typeof response !== 'object' || Array.isArray(response) || Object.keys(response).length) throw new Error('Invalid Kimi deletion acknowledgement');
      result = { state: 'deleted', reason: 'Kimi permanent native deletion acknowledged' };
    }
  } catch {
    result = { state: deleting ? 'uncertain' : 'held', reason: 'Kimi native deletion could not be confirmed; exact ownership was retained' };
  } finally {
    if (client) {
      try {
        client.destroy();
        await bounded(client.waitForExit()); await bounded(client.waitForManagedProcessGroupExit());
        await recovery.persistMaintenanceState!(false);
      }
      catch { result = { state: 'uncertain', reason: 'Kimi maintenance writer exit is unconfirmed' }; }
    }
  }
  return result;
}

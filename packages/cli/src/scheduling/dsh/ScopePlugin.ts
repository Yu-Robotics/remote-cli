import { verifyScope, type DshContext } from './HostBridge';

export const name = 'remote-cli-schedule-scope';
export const inject = ['sessionPersistence', 'storage', 'storage.backend.json'];
/** The first-party schedule service must depend on this gate, so no retained job can start first. */
export async function apply(ctx: DshContext, config: { directory: string; scope: string }): Promise<void> {
  await verifyScope(ctx, config);
  ctx.provide('remoteCliScheduleScope', {});
}

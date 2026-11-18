export const name = 'remote-cli-dsh-schedule-guard';
export const inject = ['tools'];

interface GuardContext {
  tools: { guard(check: (execution: { name: string }) => string | undefined): () => void };
  provide(name: string, value: object): void;
}

/** DSH checks global guards immediately before native tool dispatch. */
export function apply(ctx: GuardContext): void {
  ctx.tools.guard(({ name }) => name.startsWith('schedule_') ? 'Use the managed scheduling tools in the original conversation.' : undefined);
  ctx.provide('remoteCliScheduleGuardReady', {});
}

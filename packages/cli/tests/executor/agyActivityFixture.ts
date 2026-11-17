import type { AcpEventCallbacks, AcpSessionSetup } from '../../src/executor/acp/AcpClient';
import type { HookPayload } from '../../src/scheduling/agy/AgySessionSchedules';
import type { TranscriptRecord } from '../../src/scheduling/agy/transcript';

/** Synthetic ACP transport and hook boundaries; never starts a child process. */
export const agyActivity = {
  clients: [] as SyntheticAgyActivityClient[],
  accept: undefined as undefined | ((event: string, payload: HookPayload, rows: TranscriptRecord[]) => unknown),
};
export class SyntheticAgyActivityClient {
  readonly session = 'synthetic-activity-session';
  readonly prompts: unknown[] = [];
  readonly rows: TranscriptRecord[] = [];
  private cursor = 0;
  private start = 0;
  private finishPrompt?: (result: { stopReason: string }) => void;
  private exit!: () => void;
  private exited = new Promise<void>(resolve => { this.exit = resolve; });
  private closed = false;
  private admission = {};
  constructor(_command: string, _args: string[], readonly cwd: string, readonly callbacks: AcpEventCallbacks) {
    if (_args[0] !== 'acp' || !_args.includes('--stdio')) throw new Error('Expected AGY ACP launch');
    agyActivity.clients.push(this);
  }
  async initialize() { return {}; }
  async newSessionWithSetup(_cwd: string, _servers: unknown, setup?: AcpSessionSetup) {
    const state = { sessionId: this.session, configOptions: [] };
    await setup?.(state, async () => { throw new Error('Unexpected settings in activity fixture'); });
    return state;
  }
  sessionAdmission() { return this.admission; }
  hook(event: string, extra: Record<string, unknown> = {}) {
    if (!agyActivity.accept) throw new Error('Missing synthetic AGY hook relay');
    return agyActivity.accept(event, { conversationId: this.session, cwd: this.cwd, hookEventName: event,
      ...(['PreInvocation', 'PostInvocation'].includes(event) ? { invocationNum: 0, initialNumSteps: this.start } : {}), ...extra }, this.rows);
  }
  prompt(_id: string, blocks: unknown[]) {
    this.prompts.push(blocks); this.start = this.cursor;
    this.hook('SessionStart'); this.hook('PreInvocation');
    return new Promise<{ stopReason: string }>(resolve => { this.finishPrompt = resolve; });
  }
  text(text: string) { this.callbacks.onTextChunk?.({ type: 'text', text }); }
  tool() {
    const step = this.cursor++;
    const decision = this.hook('PreToolUse', { stepIdx: step, toolCall: {
      id: 'synthetic-tool', name: 'run_command', args: { CommandLine: 'echo synthetic', toolSummary: 'Inspect fixture' },
    } });
    if ((decision as any).decision !== 'allow') throw new Error('Fixture tool was denied');
    this.rows.push({ step_index: step, type: 'GENERIC', source: 'MODEL', status: 'DONE', content: 'Synthetic tool result' });
    this.hook('PostToolUse');
  }
  finish(error = false) {
    this.rows.push({ step_index: this.cursor++, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'Done' });
    this.hook('PostInvocation'); this.hook('Stop', { terminationReason: error ? 'ERROR' : 'NO_TOOL_CALL', error: error ? 'Synthetic failure' : '' });
    this.finishPrompt?.({ stopReason: 'end_turn' }); this.finishPrompt = undefined;
  }
  sendCancel() { this.finishPrompt?.({ stopReason: 'cancelled' }); this.finishPrompt = undefined; }
  destroy() { this.closed = true; this.sendCancel(); this.exit(); }
  waitForExit() { return this.exited; }
  async waitForManagedProcessGroupExit() { if (!this.closed) throw new Error('Synthetic process is still active'); }
}
export const syntheticAgyHooks = {
  installAgyScheduleHooks: async () => Object.assign(async () => {}, { run: (callback: () => unknown) => callback() }),
  AgyHookRelay: class {
    constructor(_home: string, accept: typeof agyActivity.accept) { agyActivity.accept = accept; }
    async start() { return { url: 'http://127.0.0.1:1/hook', token: 'synthetic-token' }; }
    bindSession() {}
    async close() { agyActivity.accept = undefined; }
  },
};

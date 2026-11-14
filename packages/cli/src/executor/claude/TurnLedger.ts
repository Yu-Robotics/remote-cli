/** Observed stream-json identities, scoped to one native process. No model transcript is retained. */
export class TurnLedger {
  version?: string;
  pid?: number;
  session?: string;
  capabilities = new Set<string>();
  foreground?: string;
  readonly inputs = new Set<string>();
  active?: string;
  readonly turns = new Map<string, { result: boolean; terminal: boolean; started: boolean }>();
  readonly tools = new Map<string, string>();
  readonly tasks = new Map<string, { owner?: string; terminal: boolean }>();
  inventory?: Set<string>;
  invalid = false;
  private listeners = new Set<() => void>();
  private rejectors = new Set<() => void>();
  retire(): void {
    this.invalid = true;
    for (const reject of [...this.rejectors]) reject();
  }

  supported(pid: number | undefined): boolean {
    return process.platform === 'linux' && process.arch === 'x64' && this.version === '2.1.311' && this.pid === pid && !!pid
      && !!this.session && !this.invalid
      && ['interrupt_receipt_v1', 'msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'].every(x => this.capabilities.has(x));
  }
  dispatched(id: string, continuation = false): void {
    if (!continuation) this.inputs.clear();
    this.inputs.add(id);
    this.foreground = id;
    this.turns.set(id, { result: false, terminal: false, started: false });
    if (this.turns.size > 256) this.turns.delete(this.turns.keys().next().value!);
    if (this.inputs.size > 128) this.invalid = true;
  }
  observe(frame: Record<string, any>): void {
    if (typeof frame.session_id === 'string') {
      if (this.session && this.session !== frame.session_id) this.invalid = true;
      this.session = frame.session_id;
    }
    if (frame.type === 'system' && frame.subtype === 'init' && Array.isArray(frame.capabilities)) {
      this.capabilities = new Set(frame.capabilities.filter((x: unknown) => typeof x === 'string'));
    }
    if (frame.type === 'command_lifecycle') {
      const turn = this.turns.get(frame.command_uuid);
      if (frame.state === 'started') { this.active = frame.command_uuid; if (turn) turn.started = true; }
      if (['completed', 'cancelled', 'discarded', 'refused'].includes(frame.state)) {
        if (turn) turn.terminal = true;
        if (this.active === frame.command_uuid) this.active = undefined;
      }
    }
    if (frame.type === 'result' && !frame.parent_tool_use_id) {
      const ids = [frame.user_message_uuid, ...(Array.isArray(frame.user_message_uuids) ? frame.user_message_uuids : [])];
      for (const id of ids) { const turn = this.turns.get(id); if (turn) turn.result = true; }
    }
    if (frame.type === 'assistant') {
      const owner = frame.parent_tool_use_id ? this.tools.get(frame.parent_tool_use_id) : this.active;
      for (const block of frame.message?.content ?? []) {
        if (block.type === 'tool_use' && typeof block.id === 'string' && owner && this.turns.has(owner)) {
          if (this.tools.size >= 4096) this.invalid = true;
          else this.tools.set(block.id, owner);
        }
      }
    }
    if (frame.type === 'system' && frame.subtype === 'task_started' && typeof frame.task_id === 'string') {
      if (this.tasks.size >= 4096) this.invalid = true;
      else this.tasks.set(frame.task_id, { owner: this.tools.get(frame.tool_use_id) ?? this.tasks.get(frame.parent_task_id)?.owner, terminal: false });
    }
    if (frame.type === 'system' && frame.subtype === 'background_tasks_changed') {
      // Native inventory contains task_id entries. Malformed/missing inventory is unknown, never empty.
      if (Array.isArray(frame.tasks) && frame.tasks.every((t: any) => t && typeof t.task_id === 'string')) this.inventory = new Set(frame.tasks.map((t: any) => t.task_id));
      else this.inventory = undefined;
    }
    if (frame.type === 'system' && frame.subtype === 'task_notification' && ['completed', 'failed', 'stopped'].includes(frame.status)) {
      const task = this.tasks.get(frame.task_id); if (task) task.terminal = true;
    }
    this.changed();
  }
  settled(id: string): boolean { const turn = this.turns.get(id); return !!turn?.result && turn.terminal; }
  joined(frame: Record<string, any>, id: string | undefined): boolean {
    return !!id && (frame.user_message_uuid === id || Array.isArray(frame.user_message_uuids) && frame.user_message_uuids.includes(id));
  }
  changed(): void { for (const listener of [...this.listeners]) listener(); }
  wait(check: () => boolean, milliseconds: number, label: string): Promise<void> {
    if (check()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(finish); this.rejectors.delete(retired); };
      const retired = () => { cleanup(); reject(new Error('Native cancellation host closed; session-only schedules were lost. Use /clear to recover.')); };
      const finish = () => { if (check()) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`${label} remains unconfirmed. Retry /abort, or use /clear to stop the host and lose its session-only schedules.`)); }, milliseconds);
      this.listeners.add(finish); this.rejectors.add(retired);
    });
  }
}

import type { TaskNotificationInfo } from '../types';
import type { ExecuteOptions } from './IExecutor';

type Notify = NonNullable<ExecuteOptions['onTaskNotification']>;
interface Task {
  turnId: string;
  label: string;
  notify: Notify;
  background: boolean;
}
interface AgentTask extends Task {
  launchId: string;
  reading?: boolean;
}

/** Tracks native tasks independently of the currently executing remote request. */
export class CodexTaskNotifications {
  private commands = new Map<string, Task>();
  private agents = new Map<string, AgentTask>();
  private finished = new Set<string>();

  constructor(private request: (method: string, params: any) => Promise<any>) {}

  clear(): void {
    this.commands.clear();
    this.agents.clear();
    this.finished.clear();
  }

  /** Returns true when an item completion belongs to a separately notified task. */
  handle(method: string, params: any, notify?: Notify): boolean {
    const turnId = params.turnId ?? params.turn?.id;
    if (method === 'turn/completed') {
      this.markBackground(turnId);
      return false;
    }
    if (method !== 'item/started' && method !== 'item/completed') return false;
    const item = params.item;
    if (!item || typeof item.id !== 'string' || typeof turnId !== 'string') return false;
    const completed = method === 'item/completed';

    // A subsequent model message means an unfinished command yielded control.
    if (item.type === 'agentMessage') this.markBackground(turnId);

    if (item.type === 'commandExecution') {
      const key = `command:${item.id}`;
      if (this.finished.has(key)) return true;
      if (!completed && notify && !this.commands.has(item.id)) {
        this.commands.set(item.id, { turnId, label: item.command ?? 'Background command', notify, background: false });
      }
      if (completed) {
        const task = this.commands.get(item.id);
        if (!task || task.turnId !== turnId) return false;
        this.commands.delete(item.id);
        this.remember(key);
        if (task.background) {
          const status = ['interrupted', 'cancelled', 'canceled', 'stopped'].includes(item.status)
            ? 'stopped' : item.status === 'completed' && (item.exitCode == null || item.exitCode === 0)
              ? 'completed' : 'failed';
          const exit = typeof item.exitCode === 'number' ? `\nExit code: ${item.exitCode}` : '';
          const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.trim() : '';
          this.emit(task, item.id, status, `${task.label.slice(0, 400)}${exit}${output ? `\n\n${output.slice(-1000)}` : ''}`);
          return true;
        }
      }
      return false;
    }

    if (item.type === 'collabAgentToolCall' && completed) {
      if (this.finished.has(`item:${item.id}`)) return false;
      this.remember(`item:${item.id}`);
      const states = item.agentsStates ?? {};
      for (const id of item.receiverThreadIds ?? []) {
        if (typeof id !== 'string') continue;
        if (notify && ['spawnAgent', 'resumeAgent', 'followupTask', 'sendInput'].includes(item.tool)) {
          this.startAgent(id, item.id, turnId, item.prompt ?? `Sub-agent ${id}`, notify);
        }
        const task = this.agents.get(id);
        if (task) this.finishAgent(id, task, states[id]?.status, states[id]?.message);
      }
    }

    if (item.type === 'subAgentActivity' && completed && typeof item.agentThreadId === 'string') {
      if (this.finished.has(`item:${item.id}`)) return false;
      this.remember(`item:${item.id}`);
      const id = item.agentThreadId;
      if (item.kind === 'started' && notify) {
        this.startAgent(id, item.id, turnId, item.agentPath ?? `Sub-agent ${id}`, notify);
      }
      const task = this.agents.get(id);
      if (task && item.kind === 'completed' && !task.reading) {
        task.reading = true;
        // Read just the last turn. This does not resume the child or invoke a model.
        void this.request('thread/turns/list', {
          threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'full',
        }).then((response) => {
          if (this.agents.get(id) !== task) return;
          const turn = response?.data?.[0];
          const message = turn?.error?.message ?? turn?.items
            ?.filter((entry: any) => entry.type === 'agentMessage' && typeof entry.text === 'string')
            .map((entry: any) => entry.text).join('\n');
          this.finishAgent(id, task, turn?.status === 'failed' ? 'errored' : turn?.status, message);
        }).catch((error) => {
          // Older servers can still supply terminal states through collab items.
          console.warn('[CodexTaskNotifications] Could not read sub-agent result:', error);
        }).finally(() => { task.reading = false; });
      }
    }
    return false;
  }

  private markBackground(turnId: string): void {
    for (const task of this.commands.values()) {
      if (task.turnId === turnId) task.background = true;
    }
  }

  private startAgent(id: string, launchId: string, turnId: string, label: string, notify: Notify): void {
    if (this.finished.has(`agent:${id}:${launchId}`) || this.agents.has(id)) return;
    this.agents.set(id, { turnId, launchId, label: label.slice(0, 400), notify, background: true });
  }

  private finishAgent(id: string, task: AgentTask, state: string, message: unknown): void {
    const status = state === 'completed' ? 'completed'
      : state === 'errored' || state === 'notFound' ? 'failed'
        : state === 'interrupted' || state === 'shutdown' ? 'stopped' : undefined;
    if (!status || this.agents.get(id) !== task) return;
    this.agents.delete(id);
    this.remember(`agent:${id}:${task.launchId}`);
    const summary = typeof message === 'string' && message.trim()
      ? `${task.label}\n\n${message.trim().slice(0, 1000)}` : `${task.label}\nSub-agent ${status}.`;
    this.emit(task, id, status, summary);
  }

  private emit(task: Task, taskId: string, status: TaskNotificationInfo['status'], summary: string): void {
    try {
      task.notify({ taskId, status, summary, outputFile: '' });
    } catch (error) {
      console.error('[CodexTaskNotifications] Task notification failed:', error);
    }
  }

  private remember(key: string): void {
    this.finished.add(key);
    // Deduplicate late events without retaining every task in a long session.
    if (this.finished.size > 1024) this.finished.delete(this.finished.values().next().value!);
  }
}

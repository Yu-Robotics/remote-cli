import type { BindingManager } from './BindingManager';
import type { ThreadSummary } from '../types';

/** A protocol catalog always contains the default thread and unique, bounded entries. */
export function isCompleteThreadCatalog(value: unknown): value is ThreadSummary[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return false;
  if (!value.every(thread => thread && typeof thread.id === 'string' && thread.id.length > 0 && thread.id.length <= 200
    && typeof thread.name === 'string' && thread.name.length > 0 && thread.name.length <= 100
    && ['idle', 'running', 'error'].includes(thread.status))) return false;
  return new Set(value.map(thread => thread.id)).size === value.length
    && value.filter(thread => thread.name === 'default').length === 1;
}

export interface SelectionFence {
  openId: string;
  deviceId: string;
  revision: number;
  epoch: number;
}

interface ThreadSelectionOptions {
  names(openId: string, deviceId: string, threadId: string): string | undefined;
  notify?(openId: string, text: string): Promise<unknown>;
}

/** Router-owned UI selection with per-user intent and per-device ownership fences. */
export class ThreadSelectionManager {
  private readonly revisions = new Map<string, number>();
  private readonly epochs = new Map<string, number>();
  private readonly names = new Map<string, { threadId: string; name: string }>();

  constructor(private readonly bindings: BindingManager, private readonly options: ThreadSelectionOptions) {}

  private key(openId: string, deviceId: string): string { return `${openId}\n${deviceId}`; }
  private revision(openId: string): number { return this.revisions.get(openId) ?? 0; }
  private epoch(openId: string, deviceId: string): number { return this.epochs.get(this.key(openId, deviceId)) ?? 0; }

  capture(openId: string, deviceId: string): SelectionFence {
    return { openId, deviceId, revision: this.revision(openId), epoch: this.epoch(openId, deviceId) };
  }

  beginIntent(openId: string, deviceId: string): SelectionFence {
    const revision = this.reserveIntent(openId);
    return this.intent(openId, deviceId, revision);
  }

  reserveIntent(openId: string): number {
    const revision = this.revision(openId) + 1;
    this.revisions.set(openId, revision);
    return revision;
  }

  intent(openId: string, deviceId: string, revision: number): SelectionFence {
    return { openId, deviceId, revision, epoch: this.epoch(openId, deviceId) };
  }

  isCurrent(fence: SelectionFence): boolean { return this.current(fence); }

  isOwnershipCurrent(openId: string, deviceId: string, epoch: number): boolean {
    return epoch === this.epoch(openId, deviceId);
  }

  invalidateDevice(openId: string, deviceId: string): void {
    const key = this.key(openId, deviceId);
    this.epochs.set(key, this.epoch(openId, deviceId) + 1);
    this.revisions.set(openId, this.revision(openId) + 1);
  }

  private current(fence: SelectionFence): boolean {
    return fence.revision === this.revision(fence.openId)
      && fence.epoch === this.epoch(fence.openId, fence.deviceId);
  }

  async resolve(openId: string, deviceId: string): Promise<{ threadId: string; threadName: string } | undefined> {
    const selection = this.bindings.getThreadSelection(openId, deviceId);
    if (selection.status === 'invalid') {
      throw new Error('Saved thread selection is invalid. Select a thread again to repair it.');
    }
    if (selection.status === 'none') return undefined;
    const cached = this.names.get(this.key(openId, deviceId));
    return { threadId: selection.threadId,
      threadName: (cached?.threadId === selection.threadId ? cached.name : undefined)
        ?? this.options.names(openId, deviceId, selection.threadId) ?? selection.threadId };
  }

  async select(openId: string, deviceId: string, threadId: string, threadName?: string,
    fence?: SelectionFence): Promise<'selected' | 'stale'> {
    const intent = fence ?? this.beginIntent(openId, deviceId);
    const result = await this.commit(intent, threadId);
    if (result === 'selected' && threadName) this.names.set(this.key(openId, deviceId), { threadId, name: threadName });
    return result;
  }

  async completeNew(fence: SelectionFence, threadId: string, current?: () => boolean): Promise<'selected' | 'stale'> {
    return this.commit(fence, threadId, current);
  }

  private async commit(fence: SelectionFence, threadId: string, current?: () => boolean): Promise<'selected' | 'stale'> {
    const allowed = () => this.current(fence) && (!current || current());
    if (!allowed()) return 'stale';
    if ((await this.bindings.getDeviceBinding(fence.deviceId))?.openId !== fence.openId || !allowed()) return 'stale';
    const committed = await this.bindings.selectThread(fence.openId, fence.deviceId, threadId, allowed);
    if (!committed || !allowed()) return 'stale';
    return 'selected';
  }

  async observeCatalog(openId: string, deviceId: string, fence: SelectionFence,
    threads: ThreadSummary[], current?: () => boolean): Promise<'none' | 'deleted' | 'stale' | 'failed'> {
    if (!isCompleteThreadCatalog(threads)) return 'none';
    const selection = this.bindings.getThreadSelection(openId, deviceId);
    if (selection.status !== 'valid') return 'none';
    const match = threads.find(thread => thread.id === selection.threadId);
    if (match) {
      this.names.set(this.key(openId, deviceId), { threadId: match.id, name: match.name });
      return 'none';
    }
    return this.clearDeleted(openId, deviceId, fence, selection.threadId, current);
  }

  async handleMissingThread(openId: string, deviceId: string, fence: SelectionFence,
    threadId: string, current?: () => boolean): Promise<'none' | 'deleted' | 'stale' | 'failed'> {
    const selection = this.bindings.getThreadSelection(openId, deviceId);
    if (selection.status !== 'valid' || selection.threadId !== threadId) return 'none';
    return this.clearDeleted(openId, deviceId, fence, threadId, current);
  }

  private async clearDeleted(openId: string, deviceId: string, fence: SelectionFence,
    threadId: string, current?: () => boolean): Promise<'deleted' | 'stale' | 'failed'> {
    const allowed = () => this.current(fence) && (!current || current());
    if (!allowed()) return 'stale';
    try {
      const cleared = await this.bindings.clearThreadSelection(openId, deviceId, threadId, allowed);
      if (!cleared || !allowed()) return 'stale';
      await this.options.notify?.(openId,
        'The selected thread was deleted. Future messages will use default. No message was replayed.');
      return 'deleted';
    } catch {
      if (!allowed()) return 'stale';
      await this.options.notify?.(openId,
        'The selected thread could not be reset safely. Select a thread explicitly before sending more work.');
      return 'failed';
    }
  }
}

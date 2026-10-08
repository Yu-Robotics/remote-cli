interface Writer {
  done: Promise<void>;
  release: () => void;
}

export class SettingsBusyError extends Error {}

/** Settings writes exclude admission, without serializing unrelated model turns. */
export class SettingsAdmission {
  private readonly readers = new Map<string, Map<symbol, string>>();
  private readonly writers = new Map<string, Writer>();

  hasCommand(threadId: string, exceptRequest?: string): boolean {
    return [...(this.readers.get(threadId)?.values() ?? [])].some(id => id !== exceptRequest);
  }

  isBlocked(threadId: string): boolean {
    return this.writers.has('*') || this.writers.has(threadId);
  }

  async command<T>(threadId: string, requestId: string, body: () => Promise<T>): Promise<T> {
    while (this.isBlocked(threadId)) {
      await (this.writers.get('*') ?? this.writers.get(threadId))!.done;
    }
    const token = Symbol(requestId);
    const readers = this.readers.get(threadId) ?? new Map<symbol, string>();
    readers.set(token, requestId);
    this.readers.set(threadId, readers);
    try { return await body(); }
    finally {
      readers.delete(token);
      if (!readers.size) this.readers.delete(threadId);
    }
  }

  async mutation<T>(target: string, body: () => Promise<T>): Promise<T> {
    const readers = target === '*'
      ? [...this.readers.values()].some(entries => entries.size > 0)
      : (this.readers.get(target)?.size ?? 0) > 0;
    const writer = this.writers.has('*') || this.writers.has(target)
      || (target === '*' && this.writers.size > 0);
    if (writer || readers) throw new SettingsBusyError('The affected thread is busy with a command or another settings operation. Retry when it is idle.');
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    this.writers.set(target, { done, release });
    try { return await body(); }
    finally { this.writers.delete(target); release(); }
  }
}

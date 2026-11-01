interface Writer {
  done: Promise<void>;
  release: () => void;
}

export class SettingsBusyError extends Error {}

/** Settings writes exclude admission, without serializing unrelated model turns. */
export class SettingsAdmission {
  private readonly readers = new Map<string, Map<symbol, { requestId: string; recoverable: boolean; cancel?: () => void }>>();
  private readonly epochs = new Map<string, symbol>();
  private readonly writers = new Map<string, Writer>();

  hasCommand(threadId: string, exceptRequest?: string): boolean {
    return [...(this.readers.get(threadId)?.values() ?? [])].some(entry => entry.requestId !== exceptRequest);
  }

  isBlocked(threadId: string): boolean {
    return this.writers.has('*') || this.writers.has(threadId);
  }

  async command<T>(threadId: string, requestId: string, body: (isCurrent: () => boolean) => Promise<T>, recoverable = false,
    cancel?: () => void): Promise<T> {
    const epoch = this.epochs.get(threadId);
    while (this.isBlocked(threadId)) {
      await (this.writers.get('*') ?? this.writers.get(threadId))!.done;
    }
    if (this.epochs.get(threadId) !== epoch) throw new SettingsBusyError('Command cancelled by conversation recovery; send it again.');
    const token = Symbol(requestId);
    const readers = this.readers.get(threadId) ?? new Map<symbol, { requestId: string; recoverable: boolean; cancel?: () => void }>();
    readers.set(token, { requestId, recoverable, cancel });
    this.readers.set(threadId, readers);
    try { return await body(() => this.epochs.get(threadId) === epoch); }
    finally {
      readers.delete(token);
      if (!readers.size && this.readers.get(threadId) === readers) this.readers.delete(threadId);
    }
  }

  cancelRecoverable(threadId: string): void {
    this.epochs.set(threadId, Symbol(threadId));
    const readers = this.readers.get(threadId);
    if (readers) for (const [token, entry] of readers) if (entry.recoverable) {
      readers.delete(token);
      entry.cancel?.();
    }
  }

  /** Revoke only cancellable model turns, while retaining exclusion for native settings writes. */
  async recovery<T>(threadId: string, body: () => Promise<T>): Promise<T> {
    if (this.isBlocked(threadId) || [...(this.readers.get(threadId)?.values() ?? [])].some(entry => !entry.recoverable)) {
      throw new SettingsBusyError('A native settings operation is still active. Retry recovery after it finishes.');
    }
    this.cancelRecoverable(threadId);
    this.readers.delete(threadId);
    return this.mutation(threadId, body);
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

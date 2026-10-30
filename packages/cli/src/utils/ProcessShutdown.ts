interface ShutdownHost {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code: number): unknown;
}

/** Wait for startup resources and their verified teardown before exiting on a signal. */
export class ProcessShutdown {
  private cleanup?: () => Promise<void>;
  private settleStartup!: () => void;
  private readonly startup = new Promise<void>(resolve => { this.settleStartup = resolve; });
  private requested = false;
  private stopping?: Promise<void>;
  private readonly listener = () => { void this.stop(); };

  constructor(private readonly host: ShutdownHost = process,
    private readonly report: (error: unknown) => void = error => console.error('Service shutdown failed; recovery state was preserved:', error)) {
    host.on('SIGTERM', this.listener);
    host.on('SIGINT', this.listener);
  }

  get isStopping(): boolean { return this.requested; }

  /** Register before mutable worker inventory initialization; false cancels startup. */
  attach(cleanup: () => Promise<void>): boolean {
    if (this.cleanup) throw new Error('Service shutdown resources were already registered');
    this.cleanup = cleanup;
    this.settleStartup();
    return !this.requested;
  }

  finishStartup(): void { this.settleStartup(); }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.requested = true;
    return this.stopping = (async () => {
      await this.startup;
      let code = 0;
      try { await this.cleanup?.(); }
      catch (error) { code = 1; this.report(error); }
      this.dispose();
      this.host.exit(code);
    })();
  }

  dispose(): void {
    this.host.removeListener('SIGTERM', this.listener);
    this.host.removeListener('SIGINT', this.listener);
  }
}

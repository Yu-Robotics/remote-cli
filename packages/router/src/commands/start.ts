import { ConfigManager } from '../config/ConfigManager';
import { JsonStore } from '../storage/JsonStore';
import { RouterServer } from '../server';
import { PidManager } from '../utils/PidManager';

const SHUTDOWN_TIMEOUT_MS = 5000;
const PID_CLEANUP_TIMEOUT_MS = 1000;

/** Start the Router with bounded shutdown and cleanup for this startup attempt. */
export async function startCommand(): Promise<void> {
  const pidManager = new PidManager();
  let server: RouterServer | undefined;
  let shuttingDown = false;
  let finalizing = false;
  let finished = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveStartup!: () => void;
  const startupSettled = new Promise<void>(resolve => { resolveStartup = resolve; });
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  const onSigterm = () => onSignal('SIGTERM');
  const onSigint = () => onSignal('SIGINT');

  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    clearTimeout(forceTimer);
    clearTimeout(cleanupTimer);
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    resolveExit();
    process.exit(code);
  };

  const finalize = (code: number): void => {
    if (finalizing || finished) return;
    finalizing = true;
    clearTimeout(forceTimer);
    cleanupTimer = setTimeout(() => {
      console.error('PID cleanup timed out, forcing exit');
      finish(1);
    }, PID_CLEANUP_TIMEOUT_MS);
    // A failed or hung cleanup must not cause an unhandled rejection or unbounded exit.
    void Promise.resolve().then(() => pidManager.removeOwnedPid()).then(() => finish(code), error => {
      if (finished) return;
      console.error('Error removing Router PID file:', error);
      finish(1);
    });
  };

  const shutdown = (code: number): void => {
    if (shuttingDown || finished) return;
    shuttingDown = true;
    forceTimer = setTimeout(() => {
      console.error('Shutdown timed out, forcing exit');
      finalize(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // Keep the deadline referenced so shutdown cannot exit naturally before cleanup.
    // Let the pending startup stage settle before stopping a partially started server.
    // Each subsequent startup stage checks shuttingDown before opening more resources.
    void startupSettled.then(async () => {
      if (finalizing || finished) return;
      try {
        await server?.stop();
      } catch (error) {
        if (finalizing || finished) return;
        console.error('Error during shutdown:', error);
        code = 1;
      }
      finalize(code);
    });
  };

  function onSignal(signal: NodeJS.Signals): void {
    if (shuttingDown) {
      console.log('\nForce exiting...');
      finalize(1);
      return;
    }
    console.log(`\n\nReceived ${signal}, shutting down gracefully...`);
    shutdown(0);
  }

  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  const startup = (async () => {
    try {
      console.log('\nStarting remote CLI router server...\n');
      const runningPid = await pidManager.getRunningPid();
      if (shuttingDown) return;
      // A new process cannot already be its own Router; persisted container PID 1 is stale.
      // Keep ordinary PID checks unchanged for stop/status and reject other live PIDs.
      if (runningPid && runningPid !== process.pid) {
        console.error(`Router server is already running (PID: ${runningPid})`);
        console.error('\nUse one of these commands:');
        console.error('  remote-cli-router stop    - Stop the server');
        console.error('  remote-cli-router status  - Check server status\n');
        shutdown(1);
        return;
      }

      const config = await ConfigManager.initialize();
      if (shuttingDown) return;
      if (!config.get('feishu', 'appId') || !config.get('feishu', 'appSecret')) {
        console.error('Missing required configuration!');
        console.error('\nPlease run configuration first:');
        console.error('  remote-cli-router config\n');
        shutdown(1);
        return;
      }

      await pidManager.writeOwnedPid(process.pid);
      if (shuttingDown) return;
      const store = new JsonStore();
      if (shuttingDown) return;
      await store.initialize();
      if (shuttingDown) return;
      server = new RouterServer(config, store);
      if (shuttingDown) return;
      await server.start();
    } catch (error: any) {
      if (!shuttingDown) {
        console.error('Failed to start router server:', error.message);
        shutdown(1);
      }
    } finally {
      resolveStartup();
    }
  })();

  // A hung startup must not prevent the signal deadline from completing this command.
  await Promise.race([startup, exited]);
  if (shuttingDown) await exited;
}

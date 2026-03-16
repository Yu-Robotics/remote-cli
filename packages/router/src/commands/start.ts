import { ConfigManager } from '../config/ConfigManager';
import { JsonStore } from '../storage/JsonStore';
import { RouterServer } from '../server';
import { PidManager } from '../utils/PidManager';

/**
 * Start the router server
 */
export async function startCommand(): Promise<void> {
  try {
    console.log('\n🚀 Starting remote CLI router server...\n');

    // Check if server is already running
    const pidManager = new PidManager();
    const runningPid = await pidManager.getRunningPid();
    if (runningPid) {
      console.error(`❌ Router server is already running (PID: ${runningPid})`);
      console.error('\nUse one of these commands:');
      console.error('  remote-cli-router stop    - Stop the server');
      console.error('  remote-cli-router status  - Check server status\n');
      process.exit(1);
    }

    // Load configuration
    const config = await ConfigManager.initialize();

    // Validate required configuration
    const appId = config.get('feishu', 'appId');
    const appSecret = config.get('feishu', 'appSecret');

    if (!appId || !appSecret) {
      console.error('❌ Missing required configuration!');
      console.error('\nPlease run configuration first:');
      console.error('  remote-cli-router config\n');
      process.exit(1);
    }

    // Write PID file
    await pidManager.writePid(process.pid);

    // Initialize storage
    const store = new JsonStore();
    await store.initialize();

    // Create and start server
    const server = new RouterServer(config, store);
    await server.start();

    // Handle graceful shutdown
    let isShuttingDown = false;
    const shutdown = async (signal: string) => {
      if (isShuttingDown) {
        // Second Ctrl+C: force exit immediately
        console.log('\nForce exiting...');
        process.exit(1);
      }
      isShuttingDown = true;
      console.log(`\n\nReceived ${signal}, shutting down gracefully...`);

      // Hard kill after 5 seconds in case stop() hangs
      const forceExit = setTimeout(() => {
        console.error('Shutdown timed out, forcing exit');
        process.exit(1);
      }, 5000);
      forceExit.unref();

      try {
        await server.stop();
        await pidManager.removePid();
        clearTimeout(forceExit);
        process.exit(0);
      } catch (error) {
        console.error('Error during shutdown:', error);
        await pidManager.removePid();
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error: any) {
    console.error('❌ Failed to start router server:', error.message);
    process.exit(1);
  }
}

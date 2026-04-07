#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init';
import { startCommand } from './commands/start';
import { stopCommand } from './commands/stop';
import { statusCommand } from './commands/status';
import { configCommand, ConfigAction } from './commands/config';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';

const program = new Command();

// Read package.json for version
const packageJsonPath = path.join(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

program
  .name('remote-cli')
  .description('Remote control Claude Code CLI via mobile')
  .version(packageJson.version);

/**
 * Init command
 */
program
  .command('init')
  .description('Initialize remote CLI and generate binding code')
  .requiredOption('-s, --server <url>', 'Router server URL')
  .option('-d, --dirs <dirs...>', 'Allowed directories (can specify multiple)')
  .option('-f, --force', 'Force re-initialization')
  .action(async (options) => {
    try {
      console.log(chalk.blue('🚀 Initializing remote CLI...\n'));

      const result = await initCommand({
        serverUrl: options.server,
        allowedDirs: options.dirs,
        force: options.force,
      });

      if (result.success) {
        console.log(chalk.green('✅ Initialization successful!\n'));
        console.log(chalk.yellow('📋 Binding Code:'), chalk.bold(result.bindingCode));
        console.log(chalk.gray('Device ID:'), result.deviceId);
        console.log();
        console.log(
          chalk.cyan('📱 Next steps:'),
          '\n  1. Open Feishu and send the binding code to the bot',
          '\n  2. Run',
          chalk.bold('remote-cli start'),
          'to start the service'
        );
      } else {
        console.error(chalk.red('❌ Initialization failed:'), result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
      process.exit(1);
    }
  });

/**
 * Start command
 */
program
  .command('start')
  .description('Start the remote CLI service')
  .option('-d, --daemon', 'Run as background daemon')
  .action(async (options) => {
    try {
      const result = await startCommand({
        daemon: options.daemon,
      });

      if (result.success) {
        console.log(chalk.green('✅ Service started successfully!'));
        if (result.daemonMode) {
          console.log(chalk.gray('Running in daemon mode'));
        } else {
          console.log(chalk.gray('Running in foreground mode (press Ctrl+C to stop)'));
          // Keep process alive in foreground mode
          process.on('SIGINT', () => {
            console.log(chalk.yellow('\n⏹  Shutting down...'));
            process.exit(0);
          });
          // Wait indefinitely
          await new Promise(() => {});
        }
      } else {
        console.error(chalk.red('❌ Failed to start service:'), result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
      process.exit(1);
    }
  });

/**
 * Stop command
 */
program
  .command('stop')
  .description('Stop the remote CLI service')
  .option('-g, --graceful', 'Graceful shutdown (wait for tasks to complete)')
  .option('-f, --force', 'Force stop immediately')
  .action(async (options) => {
    try {
      const result = await stopCommand({
        graceful: options.graceful,
        force: options.force,
      });

      if (result.success) {
        console.log(chalk.green('✅ Service stopped successfully'));
      } else {
        console.error(chalk.red('❌ Failed to stop service:'), result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
      process.exit(1);
    }
  });

/**
 * Status command
 */
program
  .command('status')
  .description('Show service status')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const result = await statusCommand({
        json: options.json,
      });

      if (result.success && result.status) {
        if (options.json) {
          console.log(JSON.stringify(result.status, null, 2));
        } else {
          console.log(chalk.blue('📊 Remote CLI Status\n'));

          if (!result.status.initialized) {
            console.log(chalk.yellow('⚠️  Device not initialized'));
            console.log(chalk.gray('Run'), chalk.bold('remote-cli init'), chalk.gray('first'));
            return;
          }

          console.log(chalk.gray('Device ID:'), result.status.deviceId);
          console.log(chalk.gray('Server URL:'), result.status.serverUrl);
          console.log(
            chalk.gray('Binding Status:'),
            result.status.bound
              ? chalk.green('✓ Bound') + chalk.gray(` (${result.status.openId})`)
              : chalk.yellow('✗ Not bound')
          );
          console.log(
            chalk.gray('Service Status:'),
            result.status.running ? chalk.green('✓ Running') : chalk.red('✗ Stopped')
          );
          console.log(
            chalk.gray('Connection:'),
            result.status.connected ? chalk.green('✓ Connected') : chalk.red('✗ Disconnected')
          );

          if (result.status.uptime) {
            const uptimeSeconds = Math.floor(result.status.uptime / 1000);
            const hours = Math.floor(uptimeSeconds / 3600);
            const minutes = Math.floor((uptimeSeconds % 3600) / 60);
            const seconds = uptimeSeconds % 60;
            console.log(
              chalk.gray('Uptime:'),
              `${hours}h ${minutes}m ${seconds}s`
            );
          }

          if (result.status.allowedDirectories && result.status.allowedDirectories.length > 0) {
            console.log(chalk.gray('\nAllowed Directories:'));
            result.status.allowedDirectories.forEach((dir) => {
              console.log(chalk.gray('  •'), dir);
            });
          }
        }
      } else {
        console.error(chalk.red('❌ Failed to get status:'), result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
      process.exit(1);
    }
  });

/**
 * Config command
 */
const configCmd = program
  .command('config')
  .description('Manage configuration');

configCmd
  .command('add-dir <directory>')
  .description('Add directory to allowed list')
  .action(async (directory) => {
    try {
      const result = await configCommand({
        action: 'add-dir',
        directory,
      });

      if (result.success) {
        console.log(chalk.green('✅ Directory added:'), directory);
      } else {
        console.error(chalk.red('❌ Failed:'), result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
      process.exit(1);
    }
  });

configCmd
  .command('remove-dir <directory>')
  .description('Remove directory from allowed list')
  .action(async (directory) => {
    try {
      const result = await configCommand({
        action: 'remove-dir',
        directory,
      });

      if (result.success) {
        console.log(chalk.green('✅ Directory removed:'), directory);
      } else {
        console.error(chalk.red('❌ Failed:'), result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
      process.exit(1);
    }
  });

configCmd
  .command('list-dirs')
  .description('List allowed directories')
  .action(async () => {
    try {
      const result = await configCommand({
        action: 'list-dirs',
      });

      if (result.success && result.directories) {
        console.log(chalk.blue('📁 Allowed Directories:\n'));
        if (result.directories.length === 0) {
          console.log(chalk.yellow('  No directories configured'));
        } else {
          result.directories.forEach((dir) => {
            console.log(chalk.gray('  •'), dir);
          });
        }
      } else {
        console.error(chalk.red('❌ Failed:'), result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
      process.exit(1);
    }
  });

configCmd
  .command('set <key> <value>')
  .description('Set configuration value')
  .action(async (key, value) => {
    try {
      const result = await configCommand({
        action: 'set',
        key,
        value,
      });

      if (result.success) {
        console.log(chalk.green('✅ Configuration updated:'), `${key} = ${value}`);
      } else {
        console.error(chalk.red('❌ Failed:'), result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
      process.exit(1);
    }
  });

configCmd
  .command('get <key>')
  .description('Get configuration value')
  .action(async (key) => {
    try {
      const result = await configCommand({
        action: 'get',
        key,
      });

      if (result.success) {
        console.log(result.value);
      } else {
        console.error(chalk.red('❌ Failed:'), result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
      process.exit(1);
    }
  });

configCmd
  .command('show')
  .description('Show all configuration')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const result = await configCommand({
        action: 'show',
        json: options.json,
      });

      if (result.success && result.config) {
        if (options.json) {
          console.log(JSON.stringify(result.config, null, 2));
        } else {
          console.log(chalk.blue('⚙️  Configuration:\n'));
          console.log(JSON.stringify(result.config, null, 2));
        }
      } else {
        console.error(chalk.red('❌ Failed:'), result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
      process.exit(1);
    }
  });

// Parse arguments
program.parse();

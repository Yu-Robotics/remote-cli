import { WebSocketClient } from './WebSocketClient';
import { DirectoryGuard } from '../security/DirectoryGuard';
import { IncomingMessage, OutgoingMessage, StructuredContent, ToolUseInfo, ToolResultInfo, Attachment } from '../types';
import { ThreadExecutorPool } from '../thread/ThreadExecutorPool';
import { ThreadManager } from '../thread/ThreadManager';
import { DEFAULT_THREAD_NAME } from '../thread/types';
import type { IExecutor } from '../executor/IExecutor';
import { createExecutor } from '../executor';
import { FeishuNotificationAdapter } from '../hooks';
import { ConfigManager } from '../config/ConfigManager';
import { processFileReadContent } from '../utils/FileReadDetector';
import { MachineCommands } from '../machines/MachineCommands';
import type { PendingReplace } from '../machines/types';
import { spawn, execFile } from 'child_process';
import type { ExecutorConfig } from '../types/config';

/**
 * Detected backend information
 */
interface BackendInfo {
  id: 'auto' | 'gemini';
  label: string;
  installed: boolean;
}

/**
 * Legacy message type for backward compatibility
 */
export interface Message {
  type: string;
  messageId?: string;
  content?: string;
  timestamp?: number;
}

/**
 * Thread-aware Message Handler.
 * Each thread has its own executor process managed by ThreadExecutorPool.
 * Commands without a threadId are routed to the default thread.
 */
export class MessageHandler {
  private wsClient: WebSocketClient;
  private threadPool: ThreadExecutorPool;
  private threadManager: ThreadManager;
  private directoryGuard: DirectoryGuard;
  private config: ConfigManager;
  private isDestroyed = false;
  private currentOpenId?: string;
  private notificationAdapter: FeishuNotificationAdapter;
  private machineCommands: MachineCommands;
  private pendingReplaces: Map<string, PendingReplace> = new Map();

  constructor(
    wsClient: WebSocketClient,
    threadPool: ThreadExecutorPool,
    threadManager: ThreadManager,
    directoryGuard: DirectoryGuard,
    config: ConfigManager
  ) {
    this.wsClient = wsClient;
    this.threadPool = threadPool;
    this.threadManager = threadManager;
    this.directoryGuard = directoryGuard;
    this.config = config;

    this.notificationAdapter = new FeishuNotificationAdapter(wsClient);
    this.notificationAdapter.setThreadNameResolver((threadId) => this.threadManager.getThread(threadId)?.name);
    this.notificationAdapter.register();

    // Initialize machine commands
    this.machineCommands = new MachineCommands(config);
  }

  /**
   * Handle message (supports new IncomingMessage format)
   */
  async handleMessage(message: Message | IncomingMessage): Promise<void> {
    if (this.isDestroyed) return;

    if (!message || !this.isValidMessage(message)) {
      this.sendResponse(message?.messageId || 'unknown', undefined, {
        success: false,
        error: 'Invalid message format',
      });
      return;
    }

    switch (message.type) {
      case 'status':
        await this.handleStatusQuery(message.messageId!);
        return;

      case 'command':
        await this.handleCommandMessage(message as IncomingMessage);
        return;

      case 'heartbeat':
        return;

      case 'binding_confirm':
        return;

      default:
        this.sendResponse(message.messageId!, undefined, {
          success: false,
          error: `Unknown message type: ${message.type}`,
        });
    }
  }

  /**
   * Handle command message — route to the correct thread executor.
   */
  private async handleCommandMessage(message: IncomingMessage): Promise<void> {
    const { messageId, content, attachments, workingDirectory, openId, isSlashCommand, threadId } = message;

    this.currentOpenId = openId;
    this.notificationAdapter.setCurrentOpenId(openId);

    // Resolve target thread — fall back to default if not specified
    const thread = threadId
      ? this.threadManager.getThread(threadId)
      : this.threadManager.getDefaultThread();

    if (!thread) {
      this.sendResponse(messageId, undefined, {
        success: false,
        error: `Thread not found: ${threadId}`,
      });
      return;
    }

    const resolvedThreadId = thread.id;
    const executor = this.threadPool.getExecutor(resolvedThreadId);

    // Handle /abort for this specific thread (bypasses busy check)
    if (content?.trim() === '/abort') {
      await this.handleAbortCommand(messageId, resolvedThreadId, executor);
      return;
    }

    // Check if executor is waiting for interactive input
    if ('isWaitingInput' in executor && typeof executor.isWaitingInput === 'function') {
      const ex = executor as { isWaitingInput(): boolean; sendInput(input: string): boolean };
      if (ex.isWaitingInput()) {
        const input = content?.trim();
        if (input) {
          const sent = ex.sendInput(input);
          this.sendResponse(messageId, resolvedThreadId, {
            success: sent,
            output: sent ? `✅ Sent: "${input}"` : undefined,
            error: sent ? undefined : '❌ Failed to send input - executor is no longer waiting',
          });
        } else {
          this.sendResponse(messageId, resolvedThreadId, {
            success: false,
            error: '❌ Please provide a non-empty input',
          });
        }
        return;
      }
    }

    // Per-thread busy check — set busy immediately to close the race window
    if (this.threadPool.isThreadBusy(resolvedThreadId)) {
      // Allow pending replace even when busy
      const pendingKey = openId || messageId;
      if (this.pendingReplaces.has(pendingKey) && content && !content.startsWith('/')) {
        await this.executePendingReplace(messageId, resolvedThreadId, pendingKey, content);
        return;
      }
      this.sendResponse(messageId, resolvedThreadId, {
        success: false,
        error: `Thread "${thread.name}" is busy. Send /abort to cancel the running task, or use another thread.`,
      });
      return;
    }
    this.threadPool.setThreadBusy(resolvedThreadId, true);

    try {
      // Validate and set working directory if provided
      if (workingDirectory) {
        if (!this.directoryGuard.isSafePath(workingDirectory)) {
          this.sendResponse(messageId, resolvedThreadId, {
            success: false,
            error: `Directory not in whitelist: ${workingDirectory}\n\nAllowed directories:\n${this.directoryGuard
              .getAllowedDirectories()
              .map((d) => `• ${d}`)
              .join('\n')}`,
          });
          return;
        }
        await executor.setWorkingDirectory(workingDirectory);
      }

      // Update thread activity timestamp
      await this.threadManager.updateThread(resolvedThreadId, { lastActiveAt: Date.now() });

      // Check for pending replace state (user sending file content)
      const pendingKey = openId || messageId;
      if (this.pendingReplaces.has(pendingKey) && content && !content.startsWith('/')) {
        await this.executePendingReplace(messageId, resolvedThreadId, pendingKey, content);
        return;
      }

      const builtInResult = await this.handleBuiltInCommand(
        messageId,
        resolvedThreadId,
        content!,
        executor
      );
      if (builtInResult) return;

      if (isSlashCommand) {
        console.log(`[MessageHandler] Executing passthrough slash command: ${content}`);
        await this.executeSlashCommand(messageId, resolvedThreadId, content!, executor);
        return;
      }

      const expandedContent = this.expandCommandShortcuts(content!);
      const processedContent = processFileReadContent(expandedContent);
      await this.executeCommand(messageId, resolvedThreadId, processedContent, executor, attachments);
    } catch (error) {
      this.threadPool.setThreadError(resolvedThreadId, true);
      this.sendResponse(messageId, resolvedThreadId, {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      this.threadPool.setThreadBusy(resolvedThreadId, false);
    }
  }

  /**
   * Handle /abort command for a specific thread executor
   */
  private async handleAbortCommand(
    messageId: string,
    threadId: string,
    executor: IExecutor
  ): Promise<void> {
    const wasExecuting = this.threadPool.isThreadBusy(threadId);
    const aborted = await executor.abort();

    if (aborted) {
      this.threadPool.setThreadBusy(threadId, false);
      this.sendResponse(messageId, threadId, {
        success: true,
        output: wasExecuting
          ? '✅ Current command has been aborted'
          : '⚠️ No command was executing, but executor has been reset',
      });
    } else {
      this.sendResponse(messageId, threadId, {
        success: true,
        output: 'ℹ️ No command is currently executing',
      });
    }
  }

  /**
   * Handle status query
   */
  private async handleStatusQuery(messageId: string): Promise<void> {
    const defaultThread = this.threadManager.getDefaultThread();
    const defaultExecutor = this.threadPool.getExecutor(defaultThread.id);

    this.wsClient.send({
      type: 'status',
      messageId,
      status: {
        connected: this.wsClient.isConnected(),
        allowedDirectories: this.directoryGuard.getAllowedDirectories(),
        currentWorkingDirectory: defaultExecutor.getCurrentWorkingDirectory(),
        threads: this.threadPool.getSummaries(),
      },
      timestamp: Date.now(),
    });
  }

  private isValidMessage(message: Message | IncomingMessage): boolean {
    if (!message || typeof message !== 'object') return false;
    if (message.type !== 'command') return true;
    const msg = message as IncomingMessage;
    return Boolean(msg.messageId && (msg.content || (msg.attachments && msg.attachments.length > 0)));
  }

  /**
   * Handle built-in commands (thread-scoped).
   * Returns true if handled.
   */
  private async handleBuiltInCommand(
    messageId: string,
    threadId: string,
    content: string,
    executor: IExecutor
  ): Promise<boolean> {
    const trimmed = content.trim();

    if (trimmed === '/status') {
      const cwd = executor.getCurrentWorkingDirectory();
      const allowedDirs = this.directoryGuard.getAllowedDirectories();
      const threads = this.threadPool.getSummaries();
      const threadList = threads
        .map(t => `  • ${t.name}${t.status === 'running' ? ' 🔄' : t.status === 'error' ? ' ❌' : ' ✅'} (${t.status})`)
        .join('\n');

      this.sendResponse(messageId, threadId, {
        success: true,
        output: `📊 Status:
- Working Directory: ${cwd}
- Allowed Directories: ${allowedDirs.join(', ')}
- Connection: Active
- Threads:\n${threadList}`,
      });
      return true;
    }

    if (trimmed === '/help') {
      this.sendResponse(messageId, threadId, {
        success: true,
        output: `📖 Available commands:
- /help - Show this help message
- /status - Show current status and threads
- /abort - Abort the currently executing command in this thread
- /clear - Clear conversation context for this thread
- /compact - Compress conversation history to reduce context size
- /cd <directory> - Change working directory for this thread
- /model <name> - Switch the AI model for this thread (persists across sessions)
- /backend - List available AI backends and switch between them
- /thread list - List all threads with their status
- /thread new [name] - Create a new thread
- /thread delete <name> - Delete a thread (only when idle)

Remote Machine commands:
- /proxy set <proxyHost> <proxyPort> <hostSuffix> [proxyAuth] - Configure global proxy
- /proxy show - Show proxy configuration
- /machines - List configured machines
- /machine add <id> <user> [password] [--port N] - Add a machine
- /machine remove <id> - Remove a machine
- /machine show <id> - Show machine details
- /containers <machineId> - List Docker containers
- /search <machineId> <path> <pattern> [--container <id>] [--host] - Search files
- /view <machineId> <filePath> [--container <id>] [--lines N] [--host] - View file
- /replace <machineId> <filePath> [--container <id>] [--host] - Replace file (with backup)
- /backups <machineId> [filePath] - List backups
- /restore <machineId> <backupPath> <targetPath> [--container <id>] [--host] - Restore from backup
- /cancel - Cancel pending replace operation

You can also use natural language commands to control Claude Code CLI.`,
      });
      return true;
    }

    if (trimmed === '/clear') {
      executor.resetContext();
      this.sendResponse(messageId, threadId, {
        success: true,
        output: '✅ Conversation context cleared',
      });
      return true;
    }

    if (trimmed === '/compact') {
      if (!('compactWhenFull' in executor && typeof executor.compactWhenFull === 'function')) {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: '/compact is not supported in this executor mode',
        });
        return true;
      }
      this.sendStreamChunk(messageId, threadId, '🗜️ Compressing conversation history...\n');
      const result = await executor.compactWhenFull!((chunk: string) => {
        this.sendStreamChunk(messageId, threadId, chunk);
      });
      this.sendResponse(messageId, threadId, result.success
        ? { success: true, output: '✅ Conversation history compressed' }
        : { success: false, error: result.error || 'Compaction failed' }
      );
      return true;
    }

    if (trimmed === '/backend' || trimmed.startsWith('/backend ')) {
      await this.handleBackendCommand(messageId, threadId, trimmed);
      return true;
    }

    if (trimmed.startsWith('/cd')) {
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) {
        this.sendResponse(messageId, threadId, { success: false, error: 'Usage: /cd <directory>' });
        return true;
      }
      const targetDir = parts.slice(1).join(' ');
      try {
        await executor.setWorkingDirectory(targetDir);
        const newCwd = executor.getCurrentWorkingDirectory();
        // Persist the thread's working directory (restored on next startup via ThreadExecutorPool)
        await this.threadManager.updateThread(threadId, { workingDirectory: newCwd });
        this.sendResponse(messageId, threadId, {
          success: true,
          output: `✅ Changed working directory to: ${newCwd}`,
        });
      } catch (error) {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to change directory',
        });
      }
      return true;
    }

    if (trimmed === '/thread' || trimmed.startsWith('/thread ')) {
      await this.handleThreadCommand(messageId, threadId, trimmed);
      return true;
    }

    if (trimmed === '/model' || trimmed.startsWith('/model ')) {
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) {
        this.sendResponse(messageId, threadId, { success: false, error: 'Usage: /model <name>' });
        return true;
      }
      const modelArg = parts.slice(1).join(' ');
      if (!('setModel' in executor && typeof executor.setModel === 'function')) {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: '/model is not supported in this executor mode',
        });
        return true;
      }
      const result = await executor.setModel!(modelArg, (chunk: string) => {
        this.sendStreamChunk(messageId, threadId, chunk);
      });
      if (result.success) {
        // Persist the thread's model selection (restored on next process start via ThreadExecutorPool)
        await this.threadManager.updateThread(threadId, { model: modelArg });
      }
      this.sendResponse(messageId, threadId, result.success
        ? { success: true, output: result.output || `✅ Model set to ${modelArg}` }
        : { success: false, error: result.error || 'Failed to set model' }
      );
      return true;
    }

    // Machine management commands
    const machineResult = await this.handleMachineCommand(messageId, threadId, trimmed);
    if (machineResult) {
      return true;
    }

    return false;
  }

  /**
   * Handle /thread subcommands
   */
  private async handleThreadCommand(
    messageId: string,
    callerThreadId: string,
    trimmed: string
  ): Promise<void> {
    const parts = trimmed.split(/\s+/);
    const sub = parts[1]; // list | new | delete

    if (!sub || sub === 'list') {
      const summaries = this.threadPool.getSummaries();
      const lines = summaries.map(t => {
        const icon = t.status === 'running' ? '🔄' : t.status === 'error' ? '❌' : '✅';
        const current = t.id === callerThreadId ? ' ← (this thread)' : '';
        return `${icon} ${t.name}${current}`;
      });
      this.sendResponse(messageId, callerThreadId, {
        success: true,
        output: `🧵 Threads:\n${lines.join('\n')}\n\nUse /thread new [name] to create a new thread.\nReply to a thread's card to send commands to it.`,
      });
      return;
    }

    if (sub === 'new') {
      const name = parts[2];
      const callerThread = this.threadManager.getThread(callerThreadId) || this.threadManager.getDefaultThread();
      const callerExecutor = this.threadPool.getExecutor(callerThread.id);
      const cwd = callerExecutor.getCurrentWorkingDirectory();
      try {
        const newThread = await this.threadManager.createThread(
          name || this.generateThreadName(),
          cwd
        );
        // Use newThread.id so the router maps this card to the new thread,
        // enabling the user to reply to this card to target the new thread.
        this.sendResponse(messageId, newThread.id, {
          success: true,
          output: `✅ Thread "${newThread.name}" created.\nReply to this card to send the first command to the new thread.`,
          threads: this.threadPool.getSummaries(),
        });
      } catch (error) {
        this.sendResponse(messageId, callerThreadId, {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create thread',
        });
      }
      return;
    }

    if (sub === 'delete') {
      const name = parts[2];
      if (!name) {
        this.sendResponse(messageId, callerThreadId, {
          success: false,
          error: 'Usage: /thread delete <name>',
        });
        return;
      }

      const target = this.threadManager.getThreadByName(name);
      if (!target) {
        this.sendResponse(messageId, callerThreadId, {
          success: false,
          error: `Thread "${name}" not found.`,
        });
        return;
      }

      if (this.threadPool.isThreadBusy(target.id)) {
        this.sendResponse(messageId, callerThreadId, {
          success: false,
          error: `Cannot delete thread "${name}" while it is running. Send /abort first.`,
        });
        return;
      }

      try {
        await this.threadPool.destroyThread(target.id);
        await this.threadManager.deleteThread(target.id);
        this.sendResponse(messageId, callerThreadId, {
          success: true,
          output: `✅ Thread "${name}" deleted.`,
          threads: this.threadPool.getSummaries(),
        });
      } catch (error) {
        this.sendResponse(messageId, callerThreadId, {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete thread',
        });
      }
      return;
    }

    this.sendResponse(messageId, callerThreadId, {
      success: false,
      error: `Unknown /thread subcommand: ${sub}\nUsage: /thread list | /thread new [name] | /thread delete <name>`,
    });
  }

  /**
   * Generate a unique auto-name for a new thread (e.g. "thread-2")
   */
  private generateThreadName(): string {
    const existing = new Set(this.threadManager.listThreads().map(t => t.name));
    for (let i = 2; i <= 99; i++) {
      const name = `thread-${i}`;
      if (!existing.has(name)) return name;
    }
    return `thread-${Date.now()}`;
  }

  /**
   * Handle machine management commands
   * @returns true if command was handled
   */
  private async handleMachineCommand(
    messageId: string,
    threadId: string,
    trimmed: string
  ): Promise<boolean> {
    // /proxy set|show - global proxy configuration
    if (trimmed.startsWith('/proxy ')) {
      const parts = trimmed.slice('/proxy '.length).trim().split(/\s+/);
      const subCmd = parts[0];

      if (subCmd === 'set') {
        if (parts.length < 4) {
          this.sendResponse(messageId, threadId, {
            success: false,
            error: 'Usage: /proxy set <proxyHost> <proxyPort> <hostSuffix> [proxyAuth]',
          });
          return true;
        }
        const result = await this.machineCommands.setProxy(
          parts[1], parseInt(parts[2], 10), parts[3], parts[4]
        );
        this.sendResponse(messageId, threadId, result);
        return true;
      }

      if (subCmd === 'show') {
        const result = this.machineCommands.showProxy();
        this.sendResponse(messageId, threadId, result);
        return true;
      }

      this.sendResponse(messageId, threadId, {
        success: false,
        error: 'Usage: /proxy set|show',
      });
      return true;
    }

    // /machines - list all machines
    if (trimmed === '/machines') {
      const result = await this.machineCommands.listMachines();
      this.sendResponse(messageId, threadId, result);
      return true;
    }

    // /machine add|remove|show
    if (trimmed.startsWith('/machine ')) {
      const parts = trimmed.slice('/machine '.length).trim().split(/\s+/);
      const subCmd = parts[0];

      if (subCmd === 'add') {
        const flags = this.parseFlags(parts.slice(1));
        const args = flags.positional;
        if (args.length < 2) {
          this.sendResponse(messageId, threadId, {
            success: false,
            error: 'Usage: /machine add <id> <user> [password] [--port N]',
          });
          return true;
        }
        const port = flags.named.port ? parseInt(flags.named.port, 10) : 22;
        const result = await this.machineCommands.addMachine(args[0], args[1], args[2], port);
        this.sendResponse(messageId, threadId, result);
        return true;
      }

      if (subCmd === 'remove' && parts[1]) {
        const result = await this.machineCommands.removeMachine(parts[1]);
        this.sendResponse(messageId, threadId, result);
        return true;
      }

      if (subCmd === 'show' && parts[1]) {
        const result = this.machineCommands.showMachine(parts[1]);
        this.sendResponse(messageId, threadId, result);
        return true;
      }

      this.sendResponse(messageId, threadId, {
        success: false,
        error: 'Usage: /machine add|remove|show <id> ...',
      });
      return true;
    }

    // /containers <machineId>
    if (trimmed.startsWith('/containers ')) {
      const machineId = trimmed.slice('/containers '.length).trim();
      const result = await this.machineCommands.listContainers(machineId);
      this.sendResponse(messageId, threadId, result);
      return true;
    }

    // /search <machineId> <path> <pattern> [--container <id>] [--host]
    if (trimmed.startsWith('/search ')) {
      const flags = this.parseFlags(trimmed.slice('/search '.length).trim().split(/\s+/));
      if (flags.positional.length < 3) {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: 'Usage: /search <machineId> <path> <pattern> [--container <id>] [--host]',
        });
        return true;
      }
      const containerId = flags.boolean.has('host') ? undefined : (flags.named.container || 'welding');
      const result = await this.machineCommands.searchFiles(
        flags.positional[0], flags.positional[1], flags.positional[2],
        containerId
      );
      this.sendResponse(messageId, threadId, result);
      return true;
    }

    // /view <machineId> <filePath> [--container <id>] [--lines N] [--host]
    if (trimmed.startsWith('/view ')) {
      const flags = this.parseFlags(trimmed.slice('/view '.length).trim().split(/\s+/));
      if (flags.positional.length < 2) {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: 'Usage: /view <machineId> <filePath> [--container <id>] [--lines N] [--host]',
        });
        return true;
      }
      const lines = flags.named.lines ? parseInt(flags.named.lines, 10) : undefined;
      const containerId = flags.boolean.has('host') ? undefined : (flags.named.container || 'welding');
      const result = await this.machineCommands.viewFile(
        flags.positional[0], flags.positional[1],
        containerId, lines
      );
      this.sendResponse(messageId, threadId, result);
      return true;
    }

    // /replace <machineId> <filePath> [--container <id>] [--host]
    if (trimmed.startsWith('/replace ')) {
      const flags = this.parseFlags(trimmed.slice('/replace '.length).trim().split(/\s+/));
      if (flags.positional.length < 2) {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: 'Usage: /replace <machineId> <filePath> [--container <id>] [--host]',
        });
        return true;
      }
      const containerId = flags.boolean.has('host') ? undefined : (flags.named.container || 'welding');
      const result = this.machineCommands.initiateReplace(
        flags.positional[0], flags.positional[1],
        containerId
      );
      if (result.success && result.pending) {
        const pendingKey = this.currentOpenId || messageId;
        const pending = { ...result.pending, messageId, openId: this.currentOpenId };
        this.pendingReplaces.set(pendingKey, pending);
      }
      this.sendResponse(messageId, threadId, { success: result.success, output: result.output, error: result.error });
      return true;
    }

    // /cancel - cancel pending replace
    if (trimmed === '/cancel') {
      const pendingKey = this.currentOpenId || messageId;
      if (this.pendingReplaces.has(pendingKey)) {
        this.pendingReplaces.delete(pendingKey);
        this.sendResponse(messageId, threadId, { success: true, output: 'Pending replace operation cancelled.' });
      } else {
        this.sendResponse(messageId, threadId, { success: true, output: 'No pending operation to cancel.' });
      }
      return true;
    }

    // /backups <machineId> [filePath]
    if (trimmed.startsWith('/backups')) {
      const args = trimmed.slice('/backups'.length).trim().split(/\s+/).filter(Boolean);
      if (args.length < 1) {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: 'Usage: /backups <machineId> [filePath]',
        });
        return true;
      }
      const result = await this.machineCommands.listBackups(args[0], args[1]);
      this.sendResponse(messageId, threadId, result);
      return true;
    }

    // /restore <machineId> <backupPath> <targetPath> [--container <id>] [--host]
    if (trimmed.startsWith('/restore ')) {
      const flags = this.parseFlags(trimmed.slice('/restore '.length).trim().split(/\s+/));
      if (flags.positional.length < 3) {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: 'Usage: /restore <machineId> <backupPath> <targetPath> [--container <id>] [--host]',
        });
        return true;
      }
      const containerId = flags.boolean.has('host') ? undefined : (flags.named.container || 'welding');
      const result = await this.machineCommands.restoreBackup(
        flags.positional[0], flags.positional[1], flags.positional[2],
        containerId
      );
      this.sendResponse(messageId, threadId, result);
      return true;
    }

    return false;
  }

  /**
   * Execute a pending replace operation
   */
  private async executePendingReplace(
    messageId: string,
    threadId: string,
    pendingKey: string,
    content: string
  ): Promise<void> {
    const pending = this.pendingReplaces.get(pendingKey);
    if (!pending) {
      this.sendResponse(messageId, threadId, { success: false, error: 'No pending replace operation found.' });
      return;
    }

    this.pendingReplaces.delete(pendingKey);
    const result = await this.machineCommands.executeReplace(pending, content);
    this.sendResponse(messageId, threadId, result);
  }

  /**
   * Parse flags from argument array
   */
  private parseFlags(args: string[]): { positional: string[]; named: Record<string, string>; boolean: Set<string> } {
    const positional: string[] = [];
    const named: Record<string, string> = {};
    const booleanFlags = new Set<string>();
    const knownBooleans = new Set(['host']);

    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('--')) {
        const key = args[i].slice(2);
        if (knownBooleans.has(key)) {
          booleanFlags.add(key);
        } else if (i + 1 < args.length) {
          named[key] = args[i + 1];
          i++;
        }
      } else {
        positional.push(args[i]);
      }
    }

    return { positional, named, boolean: booleanFlags };
  }

  /**
   * Expand command shortcuts
   */
  private expandCommandShortcuts(content: string): string {
    const trimmed = content.trim();
    if (trimmed === '/r' || trimmed === '/resume') return 'Please resume the previous conversation';
    if (trimmed === '/c' || trimmed === '/continue') return 'Please continue from where we left off';
    return content;
  }

  /**
   * Execute passthrough slash command using local Claude CLI
   */
  private async executeSlashCommand(
    messageId: string,
    threadId: string,
    command: string,
    executor: IExecutor
  ): Promise<void> {
    return new Promise((resolve) => {
      const chunks: string[] = [];
      const errorChunks: string[] = [];

      console.log(`[MessageHandler] Spawning Claude CLI for command: ${command}`);

      const child = spawn('claude', [command, '--print'], {
        cwd: executor.getCurrentWorkingDirectory(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDECODE: '' },
      });

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        chunks.push(chunk);
        this.sendStreamChunk(messageId, threadId, chunk);
      });

      child.stderr?.on('data', (data: Buffer) => {
        errorChunks.push(data.toString());
      });

      child.on('exit', (code) => {
        if (code === 0) {
          const output = chunks.join('');
          this.sendResponse(messageId, threadId, {
            success: true,
            output: output.trim() || '✅ Command executed successfully',
          });
        } else {
          const errorOutput = errorChunks.join('') || chunks.join('');
          this.sendResponse(messageId, threadId, {
            success: false,
            error: errorOutput.trim() || `Command failed with exit code ${code}`,
          });
        }
        resolve();
      });

      child.on('error', (error) => {
        console.error('[MessageHandler] Failed to spawn Claude:', error);
        this.sendResponse(messageId, threadId, {
          success: false,
          error: `Failed to execute command: ${error.message}`,
        });
        resolve();
      });
    });
  }

  /**
   * Execute AI command on a specific executor
   */
  private async executeCommand(
    messageId: string,
    threadId: string,
    content: string,
    executor: IExecutor,
    attachments?: Attachment[]
  ): Promise<void> {
    try {
      const result = await executor.execute(content, {
        onStream: (chunk: string) => this.sendStreamChunk(messageId, threadId, chunk),
        onToolUse: (toolUse: ToolUseInfo) => this.sendToolUse(messageId, threadId, toolUse),
        onToolResult: (toolResult: ToolResultInfo) => this.sendToolResult(messageId, threadId, toolResult),
        onRedactedThinking: () => this.sendRedactedThinking(messageId, threadId),
        onPlanMode: (planContent: string) => this.sendPlanMode(messageId, threadId, planContent),
        attachments,
      });

      if (!result.success && result.error && result.error.includes('Prompt too long')) {
        if ('compactWhenFull' in executor && typeof executor.compactWhenFull === 'function') {
          this.sendStreamChunk(messageId, threadId, '🔄 Context window full. Compacting conversation history, please wait...\n');
          const compactResult = await executor.compactWhenFull!((chunk: string) => {
            this.sendStreamChunk(messageId, threadId, chunk);
          });
          if (!compactResult.success) {
            this.sendResponse(messageId, threadId, {
              success: false,
              error: `❌ Auto-compact failed: ${compactResult.error}\n\nUse /compact to try again, or /clear to start fresh.`,
            });
            return;
          }
          this.sendStreamChunk(messageId, threadId, '✅ Compaction done. Retrying your request...\n');
          const retryResult = await executor.execute(content, {
            onStream: (chunk: string) => this.sendStreamChunk(messageId, threadId, chunk),
            onToolUse: (toolUse: ToolUseInfo) => this.sendToolUse(messageId, threadId, toolUse),
            onToolResult: (toolResult: ToolResultInfo) => this.sendToolResult(messageId, threadId, toolResult),
            onRedactedThinking: () => this.sendRedactedThinking(messageId, threadId),
            onPlanMode: (planContent: string) => this.sendPlanMode(messageId, threadId, planContent),
            attachments,
          });
          this.sendResponse(messageId, threadId, { success: retryResult.success, error: retryResult.error, threads: this.threadPool.getSummaries() });
          return;
        }
        this.sendResponse(messageId, threadId, {
          success: false,
          error: '❌ Conversation history too long.\n\nUse /compact to compress it, or /clear to start fresh.',
        });
        return;
      }

      this.sendResponse(messageId, threadId, { success: result.success, error: result.error, threads: this.threadPool.getSummaries() });
    } catch (error) {
      this.sendResponse(messageId, threadId, {
        success: false,
        error: error instanceof Error ? error.message : 'Execution error',
      });
    }
  }

  // ── Outgoing message helpers ──────────────────────────────────────────────

  private sendStreamChunk(messageId: string, threadId: string | undefined, chunk: string): void {
    try {
      this.wsClient.send({
        type: 'stream',
        messageId,
        chunk,
        streamType: 'text',
        openId: this.currentOpenId,
        threadId,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Failed to send stream chunk:', error);
    }
  }

  private sendToolUse(messageId: string, threadId: string | undefined, toolUse: ToolUseInfo): void {
    try {
      this.wsClient.send({
        type: 'stream',
        messageId,
        streamType: 'tool_use',
        toolUse,
        openId: this.currentOpenId,
        threadId,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Failed to send tool use:', error);
    }
  }

  private sendToolResult(messageId: string, threadId: string | undefined, toolResult: ToolResultInfo): void {
    try {
      this.wsClient.send({
        type: 'stream',
        messageId,
        streamType: 'tool_result',
        toolResult,
        openId: this.currentOpenId,
        threadId,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Failed to send tool result:', error);
    }
  }

  private sendRedactedThinking(messageId: string, threadId: string | undefined): void {
    try {
      this.wsClient.send({
        type: 'stream',
        messageId,
        streamType: 'redacted_thinking',
        openId: this.currentOpenId,
        threadId,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Failed to send redacted thinking:', error);
    }
  }

  private sendPlanMode(messageId: string, threadId: string | undefined, planContent: string): void {
    try {
      this.wsClient.send({
        type: 'stream',
        messageId,
        streamType: 'plan_mode',
        planContent,
        openId: this.currentOpenId,
        threadId,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Failed to send plan mode:', error);
    }
  }

  private sendStructuredContent(
    messageId: string,
    threadId: string | undefined,
    structuredContent: StructuredContent
  ): void {
    try {
      this.wsClient.send({
        type: 'structured',
        messageId,
        structuredContent,
        openId: this.currentOpenId,
        threadId,
        timestamp: Date.now(),
      } as OutgoingMessage);
    } catch (error) {
      console.error('Failed to send structured content:', error);
    }
  }

  private sendResponse(
    messageId: string,
    threadId: string | undefined,
    result: {
      success: boolean;
      output?: string;
      error?: string;
      sessionAbbr?: string;
      threads?: import('../thread/types').ThreadSummary[];
    }
  ): void {
    try {
      // Resolve CWD from thread executor if possible
      let cwd: string | undefined;
      try {
        if (threadId) {
          cwd = this.threadPool.getExecutor(threadId).getCurrentWorkingDirectory();
        }
      } catch {
        // Ignore — thread may have been deleted
      }

      this.wsClient.send({
        type: 'response',
        messageId,
        success: result.success,
        output: result.output,
        error: result.error,
        sessionAbbr: result.sessionAbbr,
        openId: this.currentOpenId,
        threadId,
        threads: result.threads,
        cwd,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Failed to send response:', error);
    }
  }

  // ── Backend switching ─────────────────────────────────────────────────────

  private checkCommand(cmd: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: 5000 }, (err) => resolve(!err));
    });
  }

  private async detectBackends(): Promise<BackendInfo[]> {
    const [claudeInstalled, geminiInstalled] = await Promise.all([
      this.checkCommand('claude', ['--version']),
      this.checkCommand('npx', ['--no', '@google/gemini-cli', '--version']),
    ]);
    return [
      { id: 'auto',   label: 'Claude Code', installed: claudeInstalled },
      { id: 'gemini', label: 'Gemini CLI',  installed: geminiInstalled },
    ];
  }

  private async handleBackendCommand(
    messageId: string,
    threadId: string,
    trimmed: string
  ): Promise<void> {
    const parts = trimmed.split(/\s+/);
    const arg = parts[1];

    const currentConfig = (this.config.get('executor') as ExecutorConfig | undefined) ?? { type: 'auto' };
    const currentType = currentConfig.type;
    const backends = await this.detectBackends();
    const installed = backends.filter((b) => b.installed);

    if (!arg) {
      if (installed.length === 0) {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: 'No supported AI backends found.\n\nMake sure Claude Code is installed: npm install -g @anthropic-ai/claude-code',
        });
        return;
      }
      const lines = installed.map((b, i) => {
        const isClaudeActive = b.id === 'auto' &&
          (currentType === 'auto' || currentType === 'claude-persistent' || currentType === 'claude-spawn');
        const active = b.id === currentType || isClaudeActive ? ' ★ (active)' : '';
        return `${i + 1}. ${b.label}${active}`;
      });
      this.sendResponse(messageId, threadId, {
        success: true,
        output: `🤖 Available AI backends:\n${lines.join('\n')}\n\nSwitch with: /backend <index> or /backend <name>`,
      });
      return;
    }

    const index = parseInt(arg, 10);
    let target: BackendInfo | undefined;
    if (!isNaN(index) && index >= 1 && index <= installed.length) {
      target = installed[index - 1];
    } else {
      target = installed.find(
        (b) => b.id === arg || b.label.toLowerCase().includes(arg.toLowerCase())
      );
    }

    if (!target) {
      this.sendResponse(messageId, threadId, {
        success: false,
        error: `Backend "${arg}" not found. Use /backend to see available options.`,
      });
      return;
    }

    const newConfig: ExecutorConfig = { ...currentConfig, type: target.id };
    await this.config.set('executor', newConfig);
    await this.threadPool.switchBackend(newConfig);

    this.sendResponse(messageId, threadId, {
      success: true,
      output: `✅ Backend switched to: ${target.label}\n\nAll threads will use the new backend for future commands.`,
    });
  }

  /**
   * Destroy handler and all executors
   */
  async destroy(): Promise<void> {
    this.isDestroyed = true;
    this.notificationAdapter.unregister();
    try {
      await this.threadPool.destroyAll();
    } catch (err) {
      console.error('Error destroying thread executors:', err);
    }
  }
}

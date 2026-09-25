import type { ApprovalRequestInfo, ApprovalRequestMessage, ApprovalResponseMessage, ApprovalResolvedMessage, ApprovalStatus } from '../types';
import { WebSocketClient } from './WebSocketClient';
import { DirectoryGuard } from '../security/DirectoryGuard';
import { IncomingMessage, OutgoingMessage, StructuredContent, ToolUseInfo, ToolResultInfo, Attachment, ImageBlock, QueueConfirmationInfo, TaskNotificationInfo } from '../types';
import { ThreadExecutorPool } from '../thread/ThreadExecutorPool';
import { ThreadManager } from '../thread/ThreadManager';
import { DEFAULT_THREAD_NAME } from '../thread/types';
import type { ExecuteResult, ExecutorContextUsage, IExecutor } from '../executor/IExecutor';
import { createExecutor } from '../executor';
import { FeishuNotificationAdapter } from '../hooks';
import { ConfigManager } from '../config/ConfigManager';
import { processFileReadContent } from '../utils/FileReadDetector';
import { readLocalImages } from '../utils/LocalImageDetector';
import { MachineCommands } from '../machines/MachineCommands';
import type { PendingReplace } from '../machines/types';
import { spawn, execFile } from 'child_process';
import { readdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { ExecutorConfig } from '../types/config';
import { backendKeyOf } from '../types/config';
import { v4 as uuidv4 } from 'uuid';
import { isZCodeAvailable } from '../executor/zcode/ZCodeCommand';

/**
 * Detected backend information
 */
interface BackendInfo {
  id: 'auto' | 'agy' | 'codex' | 'opencode' | 'kimi' | 'zcode' | 'pi';
  label: string;
  installed: boolean;
}

const EFFORT_BACKENDS = new Set(['codex', 'agy', 'opencode', 'kimi', 'zcode', 'pi']);
const NATIVE_MODEL_LIST_BACKENDS = new Set(['codex', 'opencode', 'kimi', 'zcode', 'pi']);
const SLASH_SESSION_BACKENDS = new Set(['opencode', 'kimi', 'zcode', 'pi']);
const NATIVE_SKILLS_BACKENDS = new Set(['claude', 'agy', 'opencode', 'kimi', 'zcode', 'pi']);

function backendDisplayName(key: string): string {
  switch (key) {
    case 'agy': return 'AGY CLI';
    case 'codex': return 'Codex CLI';
    case 'opencode': return 'OpenCode CLI';
    case 'kimi': return 'Kimi Code CLI';
    case 'zcode': return 'ZCode';
    case 'pi': return 'Pi';
    default: return 'Claude Code';
  }
}

function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatContextUsage(usage: ExecutorContextUsage | null): string {
  if (!usage) return '- Token usage: exact usage is not exposed by the active remote transport';

  const lines = ['- Token usage:'];
  if (typeof usage.contextTokens === 'number') {
    const window = typeof usage.contextWindow === 'number'
      ? ` / ${formatTokenCount(usage.contextWindow)}`
      : '';
    const percent = typeof usage.contextPercent === 'number'
      ? ` (${Number(usage.contextPercent.toFixed(1))}%)`
      : '';
    lines.push(`  - Current context: ${formatTokenCount(usage.contextTokens)}${window} tokens${percent}`);
  } else if (usage.contextTokens === null) {
    const window = typeof usage.contextWindow === 'number'
      ? ` of ${formatTokenCount(usage.contextWindow)} tokens`
      : '';
    lines.push(`  - Current context: recalculating after compaction${window}`);
  }

  if (typeof usage.inputTokens === 'number') lines.push(`  - Session input: ${formatTokenCount(usage.inputTokens)} tokens`);
  if (typeof usage.outputTokens === 'number') lines.push(`  - Session output: ${formatTokenCount(usage.outputTokens)} tokens`);
  if (typeof usage.cacheReadTokens === 'number' || typeof usage.cacheWriteTokens === 'number') {
    lines.push(`  - Session cache read/write: ${formatTokenCount(usage.cacheReadTokens ?? 0)} / ${formatTokenCount(usage.cacheWriteTokens ?? 0)} tokens`);
  }
  if (typeof usage.totalTokens === 'number') lines.push(`  - Session total: ${formatTokenCount(usage.totalTokens)} tokens`);

  return lines.length > 1
    ? lines.join('\n')
    : '- Token usage: exact usage is not exposed by the active remote transport';
}

interface QueuedCommand {
  messageId: string;
  threadId: string;
  content: string;
  attachments?: Attachment[];
  openId?: string;
  enqueuedAt: number;
}

interface PendingQueueConfirmation {
  info: QueueConfirmationInfo;
  command: QueuedCommand;
}

interface ActiveThreadOperation {
  token: symbol;
  done: Promise<void>;
  resolveDone: () => void;
}

const QUEUE_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const MAX_THREAD_QUEUE_LENGTH = 10;

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
  private readonly threadQueues = new Map<string, QueuedCommand[]>();
  private readonly pendingQueueConfirmations = new Map<string, PendingQueueConfirmation>();
  private readonly pausedQueues = new Set<string>();
  private readonly messageOpenIds = new Map<string, string | undefined>();
  private readonly activeThreadOperations = new Map<string, ActiveThreadOperation>();
  private readonly abortOperations = new Map<string, Promise<void>>();
  private automaticUpdateInProgress = false;
  private approvalCardsSupported = false;
  private readonly pendingApprovalCards = new Map<string, { request: ApprovalRequestMessage; executor: IExecutor }>();

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

      case 'binding_confirm': {
        const data = (message as any).data;
        if (data?.success !== true) return;
        this.approvalCardsSupported = data.capabilities?.approvalCards === true;
        for (const pending of this.pendingApprovalCards.values()) {
          if (this.approvalCardsSupported) this.sendApprovalMessage(pending.request);
          else this.showApprovalFallback(pending.request.messageId);
        }
        return;
      }
      case 'approval_response':
        this.handleApprovalResponse(message as ApprovalResponseMessage);
        return;
      case 'approval_unavailable':
        this.showApprovalFallback(message.messageId!);
        return;

      default:
        this.sendResponse(message.messageId!, undefined, {
          success: false,
          error: `Unknown message type: ${message.type}`,
        });
    }
  }

  tryBeginAutomaticUpdate(): boolean {
    this.removeExpiredQueueConfirmations();
    const hasQueuedCommands = Array.from(this.threadQueues.values()).some((queue) => queue.length > 0);
    const hasRunningThread = this.threadPool.getSummaries().some((thread) => thread.status === 'running');
    if (
      this.automaticUpdateInProgress
      || this.wsClient.hasPendingTaskResults()
      || hasRunningThread
      || hasQueuedCommands
      || this.pendingQueueConfirmations.size > 0
      || this.pendingReplaces.size > 0
      || this.activeThreadOperations.size > 0
      || this.abortOperations.size > 0
    ) {
      return false;
    }
    this.automaticUpdateInProgress = true;
    return true;
  }

  endAutomaticUpdate(): void {
    this.automaticUpdateInProgress = false;
  }

  /**
   * Handle command message — route to the correct thread executor.
   */
  private async handleCommandMessage(message: IncomingMessage): Promise<void> {
    const { messageId, content, attachments, workingDirectory, openId, isSlashCommand, threadId } = message;

    this.currentOpenId = openId;
    this.messageOpenIds.set(message.messageId, openId);
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

    if (this.automaticUpdateInProgress) {
      this.sendResponse(messageId, resolvedThreadId, {
        success: false,
        error: 'The client is installing an automatic update. Please retry after it reconnects.',
      });
      return;
    }

    const executor = this.threadPool.getExecutor(resolvedThreadId);

    // Handle /abort for this specific thread (bypasses busy check)
    if (content?.trim() === '/abort') {
      await this.handleAbortCommand(messageId, resolvedThreadId, executor);
      return;
    }

    const abortOperation = this.abortOperations.get(resolvedThreadId);
    if (abortOperation) {
      this.sendStreamChunk(messageId, resolvedThreadId, '⏳ Waiting for the current abort to finish...\n');
      await abortOperation;
      if (this.isDestroyed) {
        this.sendResponse(messageId, resolvedThreadId, {
          success: false,
          error: 'Message handler stopped while waiting for abort cleanup.',
        });
        return;
      }
    }

    if (content?.trim() === '/queue' || content?.trim().startsWith('/queue ')) {
      await this.handleQueueCommand(messageId, resolvedThreadId, content.trim());
      return;
    }

    // /thread (list) and /thread new never touch the caller thread's execution
    // context, so they bypass the busy check (like /abort and /queue). This also
    // covers the router's "+ New" card button, which always arrives without a
    // threadId and would otherwise be rejected whenever the default thread is busy.
    // /thread delete is intentionally NOT exempted: it keeps its own busy/queue guards.
    const trimmedForThreadCmd = content?.trim() ?? '';
    if (
      /^\/thread(?:\s+list)?$/.test(trimmedForThreadCmd)
      || /^\/thread\s+new(?:\s|$)/.test(trimmedForThreadCmd)
    ) {
      await this.handleThreadCommand(messageId, resolvedThreadId, trimmedForThreadCmd);
      return;
    }

    // Backend switching has its own lifecycle handling and must run before the
    // normal command busy flag is acquired.
    if (content?.trim() === '/backend' || content?.trim().startsWith('/backend ')) {
      if (this.threadPool.isThreadBusy(resolvedThreadId)) {
        this.sendResponse(messageId, resolvedThreadId, {
          success: false,
          error: `Thread "${thread.name}" is busy. Send /abort to cancel the running task before switching backend.`,
        });
        return;
      }
      await this.handleBackendCommand(messageId, resolvedThreadId, content.trim());
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
            error: sent ? undefined : ex.isWaitingInput()
              ? '❌ Input was not accepted. Check the pending request and reply again.'
              : '❌ Failed to send input - executor is no longer waiting',
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

    const threadBusy = this.threadPool.isThreadBusy(resolvedThreadId);
    const queuedCount = this.threadQueues.get(resolvedThreadId)?.length ?? 0;
    if (!threadBusy && !this.hasThreadQueueState(resolvedThreadId)) this.pausedQueues.delete(resolvedThreadId);
    const queuePaused = this.pausedQueues.has(resolvedThreadId);
    const ordinaryMessage = !isSlashCommand && !content?.trim().startsWith('/');
    // An idle executor can still have a paused queue. New work must not overtake it.
    if (threadBusy || (ordinaryMessage && (queuedCount > 0 || queuePaused))) {
      // Allow pending replace even when busy
      const pendingKey = openId || messageId;
      if (threadBusy && this.pendingReplaces.has(pendingKey) && content && !content.startsWith('/')) {
        await this.executePendingReplace(messageId, resolvedThreadId, pendingKey, content);
        return;
      }
      if (isSlashCommand || content?.trim().startsWith('/')) {
        this.sendResponse(messageId, resolvedThreadId, {
          success: false,
          error: `Thread "${thread.name}" is busy. Send /abort to cancel the running task, or use /queue to inspect queued messages.`,
        });
      } else {
        if ((this.threadQueues.get(resolvedThreadId)?.length ?? 0) >= MAX_THREAD_QUEUE_LENGTH) {
          this.sendResponse(messageId, resolvedThreadId, {
            success: false,
            error: `Thread queue is full (${MAX_THREAD_QUEUE_LENGTH} messages). Use /abort to clear it.`,
          });
          return;
        }
        const queueConfirmation = this.createQueueConfirmation(
          resolvedThreadId,
          thread.name,
          content!,
          attachments,
          openId,
          messageId,
          executor,
        );
        this.sendResponse(messageId, resolvedThreadId, {
          success: false,
          output: queuePaused
            ? `⏸️ Queue paused after a failed task. Confirm whether to add this message to the queue for "${thread.name}". Use /queue continue to resume, or /queue clear to discard pending messages.`
            : `⏳ Thread "${thread.name}" ${threadBusy ? 'is busy' : 'has pending queued messages'}. Confirm whether to add this message to its queue.`,
          queueConfirmation,
        });
        // Recover an idle, unpaused backlog without letting the new message skip it.
        void this.startNextQueuedCommand(resolvedThreadId);
      }
      return;
    }

    const queueSensitiveCommand = /^\/(?:clear|new|compact|cd|model|effort|sandbox)(?:\s|$)/.test(content?.trim() ?? '')
      || /^\/thread\s+delete(?:\s|$)/.test(content?.trim() ?? '');
    if (queueSensitiveCommand && this.hasThreadQueueState(resolvedThreadId)) {
      this.sendResponse(messageId, resolvedThreadId, {
        success: false,
        error: 'This thread has queued messages. Send /abort to clear the current task and queue before changing its execution context.',
      });
      return;
    }
    const operationToken = this.beginThreadOperation(resolvedThreadId);

    try {
      this.trackTask(messageId, resolvedThreadId, content || '');
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
      if (this.finishThreadOperation(resolvedThreadId, operationToken) && !this.pausedQueues.has(resolvedThreadId)) {
        void this.startNextQueuedCommand(resolvedThreadId);
      }
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
    const existingAbort = this.abortOperations.get(threadId);
    if (existingAbort) {
      await existingAbort;
      this.sendResponse(messageId, threadId, {
        success: true,
        output: 'ℹ️ The abort operation has already completed.',
      });
      return;
    }

    const wasExecuting = this.threadPool.isThreadBusy(threadId);
    const clearedCount = this.clearThreadQueue(threadId);
    const activeOperation = this.activeThreadOperations.get(threadId);
    let aborted = false;
    const operation = (async () => {
      aborted = await executor.abort();
      if (activeOperation) await activeOperation.done;
    })();
    const barrier = operation.then(() => undefined, () => undefined);
    this.abortOperations.set(threadId, barrier);

    try {
      await operation;
    } catch (error) {
      this.sendResponse(messageId, threadId, {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to abort command',
      });
      return;
    } finally {
      if (this.abortOperations.get(threadId) === barrier) this.abortOperations.delete(threadId);
    }

    if (aborted) {
      if (!activeOperation) this.threadPool.setThreadBusy(threadId, false);
      this.sendResponse(messageId, threadId, {
        success: true,
        output: `${wasExecuting ? '✅ Current command has been aborted' : '⚠️ No command was executing, but executor has been reset'}${clearedCount ? `\n🗑️ Cleared ${clearedCount} queued message${clearedCount === 1 ? '' : 's'}.` : ''}`,
      });
    } else {
      this.sendResponse(messageId, threadId, {
        success: true,
        output: clearedCount
          ? `ℹ️ No command is currently executing\n🗑️ Cleared ${clearedCount} queued message${clearedCount === 1 ? '' : 's'}.`
          : 'ℹ️ No command is currently executing',
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

    if (trimmed === '/sandbox' || trimmed.startsWith('/sandbox ')) {
      if (!('getSandboxStatus' in executor) || !('configureSandbox' in executor)) {
        this.sendResponse(messageId, threadId, { success: false, error: '/sandbox is currently supported by the Codex and Claude Code backends.' });
        return true;
      }
      const control = executor as IExecutor & {
        getSandboxStatus(): string;
        configureSandbox(command: string): Promise<ExecuteResult>;
      };
      const result = trimmed === '/sandbox'
        ? { success: true, output: control.getSandboxStatus() }
        : await control.configureSandbox(trimmed.slice('/sandbox'.length).trim());
      this.sendResponse(messageId, threadId, result);
      return true;
    }

    if (trimmed === '/status') {
      const cwd = executor.getCurrentWorkingDirectory();
      const allowedDirs = this.directoryGuard.getAllowedDirectories();
      const threads = this.threadPool.getSummaries();
      const thread = this.threadManager.getThread(threadId);
      const backend = this.threadPool.getBackendKey(threadId);
      const model = thread?.models?.[backend] ?? (backend === 'claude' ? thread?.model : undefined);
      const effort = thread?.efforts?.[backend] ?? 'auto';
      const threadList = threads
        .map(t => {
          const queued = this.threadQueues.get(t.id)?.length ?? 0;
          const queueSuffix = queued > 0 ? `, queue: ${queued}` : '';
          return `  • ${t.name}${t.status === 'running' ? ' 🔄' : t.status === 'error' ? ' ❌' : ' ✅'} (${t.status}, backend: ${t.backend ?? 'claude'}${queueSuffix})`;
        })
        .join('\n');

      this.sendResponse(messageId, threadId, {
        success: true,
        output: `📊 Status:
- Thread: ${thread?.name ?? threadId}
- Backend: ${backend}
- Model: ${model ?? 'backend default'}
- Reasoning effort: ${effort}
- Working Directory: ${cwd}
- Allowed Directories: ${allowedDirs.join(', ')}
- Connection: Active
- Threads:\n${threadList}`,
      });
      return true;
    }

    if (trimmed === '/context') {
      const thread = this.threadManager.getThread(threadId);
      const backend = this.threadPool.getBackendKey(threadId);
      const model = thread?.models?.[backend] ?? (backend === 'claude' ? thread?.model : undefined);
      const effort = thread?.efforts?.[backend] ?? 'auto';
      const sessionId = typeof executor.getSessionId === 'function' ? executor.getSessionId() : null;
      const contextUsage = typeof executor.getContextUsage === 'function'
        ? await executor.getContextUsage()
        : null;
      const queued = this.threadQueues.get(threadId)?.length ?? 0;
      const pending = Array.from(this.pendingQueueConfirmations.values())
        .filter((confirmation) => confirmation.info.threadId === threadId).length;
      const usageLines = formatContextUsage(contextUsage);
      this.sendResponse(messageId, threadId, {
        success: true,
        output: `🧠 Context:
- Thread: ${thread?.name ?? threadId}
- Backend: ${backend}
- Model: ${model ?? 'backend default'}
- Reasoning effort: ${effort}
- Working Directory: ${executor.getCurrentWorkingDirectory()}
- Session: ${sessionId ?? 'not started'}
- Queue: ${queued} confirmed, ${pending} awaiting confirmation
${usageLines}

Use /compact to reduce conversation context or /clear to start a fresh context.`,
      });
      return true;
    }

    if (trimmed === '/skills') {
      const backend = this.threadPool.getBackendKey(threadId);
      if (NATIVE_SKILLS_BACKENDS.has(backend)) {
        await this.executeSlashCommand(messageId, threadId, trimmed, executor);
      } else {
        const skills = await this.listLocalSkills(executor.getCurrentWorkingDirectory(), 'codex');
        this.sendResponse(messageId, threadId, {
          success: true,
          output: skills.length > 0
            ? `🧩 Available skills (local discovery):\n${skills.map((skill) => `- ${skill}`).join('\n')}`
            : '🧩 No local skills were discovered for the Codex backend.\n\nExpected locations include .agents/skills and ~/.codex/skills.',
        });
      }
      return true;
    }

    if (trimmed === '/help') {
      this.sendResponse(messageId, threadId, {
        success: true,
        output: `📖 Available commands:
- /help - Show this help message
- /status - Show backend, model, effort, queue, and thread status
- /context - Show current session context and queue diagnostics
- /skills - List available skills for the active backend
- /abort - Abort the currently executing command in this thread
- /queue [clear|continue|confirm <id>|cancel <id>] - Inspect or manage this thread's command queue
- /clear, /new - Start a fresh conversation in this thread
- /compact - Compress conversation history to reduce context size
- /cd <directory> - Change working directory for this thread
- /model [name] - Show models for the active backend, or set this thread's model
- /effort [auto|level] - Show or set effort for Codex/AGY/OpenCode/Kimi/ZCode/Pi (Claude Code is unsupported)
- /sandbox [on|off|read-only|default|allow <directory>|remove <directory>|network on|off] - Configure this thread's sandbox (Codex, Claude Code)
- /backend - List backends and show the current thread's effective backend
- /backend <index> - Switch all threads and clear per-thread backend overrides
- /backend <index> @ - Switch only the current thread
- /backend default @ - Clear the current thread override and follow the global backend
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

    if (trimmed === '/clear' || trimmed === '/new') {
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

    if (trimmed === '/effort' || trimmed.startsWith('/effort ')) {
      const executorConfig = (this.config.get('executor') as ExecutorConfig | undefined) ?? { type: 'auto' };
      const key = this.threadPool.getBackendKey(threadId);
      if (!EFFORT_BACKENDS.has(key)) {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: '/effort is not supported yet for Claude Code.',
        });
        return true;
      }

      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) {
        const thread = this.threadManager.getThread(threadId);
        if (key === 'agy') {
          this.sendResponse(messageId, threadId, {
            success: true,
            output: [
              `Current reasoning effort: ${thread?.efforts?.agy ?? 'auto'}`,
              'Supported levels: low, medium, high',
              'Set with: /effort <auto|level>',
            ].join('\n'),
          });
          return true;
        }
        const configuredModel = key === 'codex'
          ? thread?.models?.codex ?? executorConfig.codex?.model
          : key === 'opencode'
            ? thread?.models?.opencode ?? executorConfig.opencode?.model
            : key === 'kimi'
              ? thread?.models?.kimi ?? executorConfig.kimi?.model
              : key === 'pi'
                ? thread?.models?.pi ?? executorConfig.pi?.model
                : thread?.models?.zcode ?? executorConfig.zcode?.model;
        const lines = [`Current reasoning effort: ${thread?.efforts?.[key] ?? 'auto'}`];
        if ('listModels' in executor && typeof executor.listModels === 'function') {
          try {
            const models = await executor.listModels();
            const activeModel = models.find((entry) => entry.id === configuredModel)
              ?? models.find((entry) => entry.isDefault)
              ?? models[0];
            if (activeModel) {
              lines.push(`Model: ${activeModel.id}`);
              lines.push(`Model default: ${activeModel.defaultReasoningEffort ?? 'unavailable'}`);
              lines.push(`Supported levels: ${activeModel.supportedReasoningEfforts?.join(', ') || 'unavailable'}`);
            }
          } catch (error) {
            const label = backendDisplayName(key);
            lines.push(`Could not fetch ${label} effort metadata: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        lines.push('Set with: /effort <auto|level>');
        this.sendResponse(messageId, threadId, { success: true, output: lines.join('\n') });
        return true;
      }

      if (!('setEffort' in executor && typeof executor.setEffort === 'function')) {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: `/effort is not supported by this ${backendDisplayName(key)} executor version.`,
        });
        return true;
      }

      const effortArg = parts.slice(1).join(' ').toLowerCase();
      const result = await executor.setEffort(effortArg);
      if (result.success) {
        const current = this.threadManager.getThread(threadId);
        const efforts = { ...current?.efforts };
        if (effortArg === 'auto') delete efforts[key];
        else efforts[key] = effortArg;
        await this.threadManager.updateThread(threadId, {
          efforts: Object.keys(efforts).length > 0 ? efforts : undefined,
        });
      }
      this.sendResponse(messageId, threadId, result.success
        ? { success: true, output: result.output || `Reasoning effort set to ${effortArg}.` }
        : { success: false, error: result.error || 'Failed to set reasoning effort' }
      );
      return true;
    }

    if (trimmed === '/model' || trimmed.startsWith('/model ')) {
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) {
        await this.handleModelList(messageId, threadId);
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
        // Persist per-backend: model names are backend-specific (Claude's
        // "opus" is rejected by agy), so selections live under
        // thread.models[backendKey]. The legacy `model` field is kept in
        // sync for the Claude backend only.
        const executorConfig = (this.config.get('executor') as ExecutorConfig | undefined) ?? { type: 'auto' };
        const key = this.threadPool.getBackendKey(threadId);
        const current = this.threadManager.getThread(threadId);
        const models = { ...current?.models, [key]: modelArg };
        await this.threadManager.updateThread(
          threadId,
          key === 'claude' ? { models, model: modelArg } : { models }
        );
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

  private createQueueConfirmation(
    threadId: string,
    threadName: string,
    content: string,
    attachments: Attachment[] | undefined,
    openId: string | undefined,
    messageId: string,
    executor: IExecutor,
  ): QueueConfirmationInfo {
    this.removeExpiredQueueConfirmations();
    const id = uuidv4();
    const info: QueueConfirmationInfo = {
      id,
      threadId,
      threadName,
      backend: this.threadPool.getBackendKey(threadId),
      cwd: executor.getCurrentWorkingDirectory(),
      preview: content.replace(/\s+/g, ' ').trim().slice(0, 240),
      pendingCount: this.threadQueues.get(threadId)?.length ?? 0,
      expiresAt: Date.now() + QUEUE_CONFIRMATION_TTL_MS,
    };
    this.pendingQueueConfirmations.set(id, {
      info,
      command: { messageId, threadId, content, attachments, openId, enqueuedAt: Date.now() },
    });
    setTimeout(() => {
      const pending = this.pendingQueueConfirmations.get(id);
      if (pending && pending.info.expiresAt <= Date.now()) this.pendingQueueConfirmations.delete(id);
    }, QUEUE_CONFIRMATION_TTL_MS).unref?.();
    return info;
  }

  private removeExpiredQueueConfirmations(): void {
    const now = Date.now();
    for (const [id, pending] of this.pendingQueueConfirmations) {
      if (pending.info.expiresAt <= now) this.pendingQueueConfirmations.delete(id);
    }
  }

  private clearThreadQueue(threadId: string): number {
    let cleared = this.threadQueues.get(threadId)?.length ?? 0;
    this.threadQueues.delete(threadId);
    for (const [id, pending] of this.pendingQueueConfirmations) {
      if (pending.info.threadId === threadId) {
        this.pendingQueueConfirmations.delete(id);
        cleared += 1;
      }
    }
    this.pausedQueues.delete(threadId);
    return cleared;
  }

  private clearAllQueues(): number {
    const threadIds = new Set([
      ...this.threadQueues.keys(),
      ...this.pausedQueues,
      ...Array.from(this.pendingQueueConfirmations.values()).map((pending) => pending.info.threadId),
    ]);
    return Array.from(threadIds).reduce((total, threadId) => total + this.clearThreadQueue(threadId), 0);
  }

  private async handleQueueCommand(messageId: string, threadId: string, trimmed: string): Promise<void> {
    this.removeExpiredQueueConfirmations();
    const parts = trimmed.split(/\s+/);
    const action = parts[1]?.toLowerCase();
    const id = parts[2];

    if (action === 'confirm' && id) {
      const pending = this.pendingQueueConfirmations.get(id);
      const currentCwd = this.threadPool.getExecutor(threadId).getCurrentWorkingDirectory();
      if (!pending || pending.info.threadId !== threadId || pending.info.expiresAt <= Date.now()
        || pending.info.backend !== this.threadPool.getBackendKey(threadId) || pending.info.cwd !== currentCwd
        || (pending.command.openId && pending.command.openId !== this.getMessageOpenId(messageId))) {
        this.pendingQueueConfirmations.delete(id);
        this.sendResponse(messageId, threadId, { success: false, error: 'Queue confirmation is no longer valid. The message was not queued.' });
        return;
      }
      this.pendingQueueConfirmations.delete(id);
      const queue = this.threadQueues.get(threadId) ?? [];
      if (queue.length >= MAX_THREAD_QUEUE_LENGTH) {
        this.sendResponse(messageId, threadId, { success: false, error: `This thread queue is full (${MAX_THREAD_QUEUE_LENGTH} messages).` });
        return;
      }
      queue.push({ ...pending.command, messageId: parts[3] || pending.command.messageId });
      this.threadQueues.set(threadId, queue);
      console.log(`[MessageHandler] Queued message ${parts[3] || pending.command.messageId} in thread ${threadId}: position=${queue.length}, paused=${this.pausedQueues.has(threadId)}`);
      this.sendResponse(messageId, threadId, {
        success: true,
        output: `✅ Added to queue for ${pending.info.threadName}.\nQueue position: ${queue.length}\nPending messages for this thread: ${queue.length}${this.pausedQueues.has(threadId) ? '\n⏸️ Queue paused after a failed task. Use /queue continue to resume, or /queue clear to discard pending messages.' : ''}`,
      });
      void this.startNextQueuedCommand(threadId);
      return;
    }

    if (action === 'cancel' && id) {
      const pending = this.pendingQueueConfirmations.get(id);
      if (pending?.info.threadId === threadId) {
        this.pendingQueueConfirmations.delete(id);
        this.sendResponse(messageId, threadId, { success: true, output: '❌ Message was not queued.' });
      } else {
        this.sendResponse(messageId, threadId, { success: false, error: 'Queue confirmation is no longer valid.' });
      }
      return;
    }

    if (action === 'clear') {
      const cleared = this.clearThreadQueue(threadId);
      this.sendResponse(messageId, threadId, {
        success: true,
        output: cleared ? `🗑️ Cleared ${cleared} queued message${cleared === 1 ? '' : 's'}.` : 'ℹ️ This thread queue is empty.',
      });
      return;
    }

    if (action === 'continue') {
      this.pausedQueues.delete(threadId);
      this.sendResponse(messageId, threadId, { success: true, output: '▶️ Queue resumed.' });
      void this.startNextQueuedCommand(threadId);
      return;
    }

    const lines = ['📋 Thread queues:'];
    for (const summary of this.threadPool.getSummaries()) {
      const queued = this.threadQueues.get(summary.id) ?? [];
      const pending = Array.from(this.pendingQueueConfirmations.values()).filter((item) => item.info.threadId === summary.id);
      if (summary.status !== 'running' && queued.length === 0 && pending.length === 0 && !this.pausedQueues.has(summary.id)) continue;
      lines.push(`\n${summary.name} (${summary.backend ?? 'global'}) — ${summary.status}`);
      lines.push(`  Confirmed: ${queued.length}; awaiting confirmation: ${pending.length}`);
      queued.forEach((command, index) => lines.push(`  ${index + 1}. ${command.content.replace(/\s+/g, ' ').slice(0, 160)}`));
      if (this.pausedQueues.has(summary.id)) lines.push('  ⏸️ Paused after a failed task. Use /queue continue or /abort.');
    }
    if (lines.length === 1) lines.push('No active or pending thread queues.');
    this.sendResponse(messageId, threadId, { success: true, output: lines.join('\n') });
  }

  private async startNextQueuedCommand(threadId: string): Promise<void> {
    if (this.threadPool.isThreadBusy(threadId) || this.pausedQueues.has(threadId) || this.abortOperations.has(threadId)) return;
    const queue = this.threadQueues.get(threadId);
    const command = queue?.shift();
    if (!command) {
      this.threadQueues.delete(threadId);
      return;
    }
    if (queue?.length === 0) this.threadQueues.delete(threadId);

    const thread = this.threadManager.getThread(threadId);
    if (!thread) return;
    this.currentOpenId = command.openId;
    this.messageOpenIds.set(command.messageId, command.openId);
    this.notificationAdapter.setCurrentOpenId(command.openId);
    const operationToken = this.beginThreadOperation(threadId);
    console.log(`[MessageHandler] Starting queued message ${command.messageId} in thread ${threadId}: remaining=${this.threadQueues.get(threadId)?.length ?? 0}`);
    try {
      const executor = this.threadPool.getExecutor(threadId);
      this.trackTask(command.messageId, threadId, command.content);
      await this.threadManager.updateThread(threadId, { lastActiveAt: Date.now() });
      this.wsClient.send({
        type: 'queue_started',
        messageId: command.messageId,
        openId: command.openId,
        threadId,
        queueStarted: {
          threadName: thread.name,
          backend: this.threadPool.getBackendKey(threadId),
          cwd: executor.getCurrentWorkingDirectory(),
          preview: command.content.replace(/\s+/g, ' ').trim().slice(0, 240),
          remainingCount: queue?.length ?? 0,
        },
        threads: this.threadPool.getSummaries(),
        timestamp: Date.now(),
      } satisfies OutgoingMessage);
      const processedContent = processFileReadContent(this.expandCommandShortcuts(command.content));
      await this.executeCommand(command.messageId, threadId, processedContent, executor, command.attachments, true);
    } catch (error) {
      this.sendResponse(command.messageId, threadId, {
        success: false,
        error: this.pauseQueueAfterFailure(threadId, error instanceof Error ? error.message : 'Queued command failed'),
      });
    } finally {
      if (this.finishThreadOperation(threadId, operationToken) && !this.pausedQueues.has(threadId)) {
        void this.startNextQueuedCommand(threadId);
      }
    }
  }

  private pauseQueueAfterFailure(threadId: string, error: string): string {
    this.removeExpiredQueueConfirmations();
    if (this.abortOperations.has(threadId) || !this.hasThreadQueueState(threadId)) return error;
    this.pausedQueues.add(threadId);
    const count = this.threadQueues.get(threadId)?.length ?? 0;
    const pending = Array.from(this.pendingQueueConfirmations.values()).filter((item) => item.info.threadId === threadId).length;
    console.warn(`[MessageHandler] Queue paused in thread ${threadId}: confirmed=${count}, awaiting_confirmation=${pending}`);
    return `${error}\n\n⏸️ Queue paused after a failed task. Waiting: ${count} confirmed, ${pending} awaiting confirmation. Use /queue continue to resume, or /queue clear to discard pending messages.`;
  }

  private beginThreadOperation(threadId: string): symbol {
    const token = Symbol(threadId);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    this.activeThreadOperations.set(threadId, { token, done, resolveDone });
    this.threadPool.setThreadBusy(threadId, true);
    return token;
  }

  private finishThreadOperation(threadId: string, token: symbol): boolean {
    const active = this.activeThreadOperations.get(threadId);
    if (!active || active.token !== token) return false;
    this.activeThreadOperations.delete(threadId);
    this.threadPool.setThreadBusy(threadId, false);
    active.resolveDone();
    return true;
  }

  private hasThreadQueueState(threadId: string): boolean {
    if ((this.threadQueues.get(threadId)?.length ?? 0) > 0) return true;
    return Array.from(this.pendingQueueConfirmations.values()).some((pending) => pending.info.threadId === threadId);
  }

  /**
   * Bare /model: show the thread's current model on the active backend plus
   * the available models. Listing source per backend (all verified live):
   * - claude: `claude --print /model` prints current + available aliases
   * - agy: `agy models` prints "slug<TAB>Display Name" lines
   * - codex: app-server `model/list` returns the authenticated catalog
   * - opencode/kimi ACP: session config options expose enabled models
   * - zcode: official app-server session settings expose enabled models
   * - pi: RPC `get_available_models` returns the configured Pi catalog
   */
  private async handleModelList(messageId: string, threadId: string): Promise<void> {
    const executorConfig = (this.config.get('executor') as ExecutorConfig | undefined) ?? { type: 'auto' };
    const key = this.threadPool.getBackendKey(threadId);
    const thread = this.threadManager.getThread(threadId);
    const current = thread?.models?.[key] ?? (key === 'claude' ? thread?.model : undefined);

    const backendLabel = backendDisplayName(key);
    const lines: string[] = [
      `🎯 Backend: ${backendLabel}`,
      `Current model: ${current ?? 'backend default'}`,
    ];

    if (NATIVE_MODEL_LIST_BACKENDS.has(key)) {
      const executor = this.threadPool.getExecutor(threadId);
      if ('listModels' in executor && typeof executor.listModels === 'function') {
        try {
          const models = await executor.listModels();
          if (models.length > 0) {
            lines.push('', 'Available models:');
            for (const model of models) {
              const marker = model.id === current ? ' ★' : model.isDefault ? ' (default)' : '';
              lines.push(`- ${model.id}${marker}${model.displayName !== model.id ? ` — ${model.displayName}` : ''}`);
            }
          } else {
            lines.push('', `⚠️ ${backendLabel} returned an empty model list.`);
          }
        } catch (error) {
          lines.push('', `⚠️ Could not fetch the model list from ${backendLabel}: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        lines.push('', `Model listing is unavailable in this ${backendLabel} transport.`);
      }
    } else {
      const bin = key === 'agy' ? (executorConfig.agy?.command ?? 'agy') : 'claude';
      const args = key === 'agy' ? ['models'] : ['/model', '--print'];
      const listing = await this.runListingCommand(bin, args);
      if (listing) {
        lines.push('', 'Available models:', listing.trim());
      } else {
        lines.push('', '⚠️ Could not fetch the model list from the backend CLI.');
      }
    }

    lines.push('', 'Set with: /model <name>');
    this.sendResponse(messageId, threadId, { success: true, output: lines.join('\n') });
  }

  /**
   * Run a short-lived CLI listing command with a 10s timeout.
   * Returns null on failure/timeout — callers degrade gracefully.
   */
  private runListingCommand(bin: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };

      let child;
      try {
        child = spawn(bin, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, CLAUDECODE: '' },
        });
      } catch {
        finish(null);
        return;
      }

      timer = setTimeout(() => {
        child.kill();
        finish(null);
      }, 10000);

      const chunks: string[] = [];
      child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
      child.on('exit', (code) => finish(code === 0 ? chunks.join('') : null));
      child.on('error', () => finish(null));
    });
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
        const backend = t.backend ? ` [${t.backend}]` : '';
        return `${icon} ${t.name}${backend}${current}`;
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
          cwd,
          this.threadPool.getBackendKey(callerThread.id)
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
   * Slash commands that agy answers locally in non-interactive print mode
   * (verified live against agy 1.1.26: `agy -p "/<cmd>"`). All are read-only —
   * agy rejects arguments to them ("takes no arguments"), and its stream-json
   * protocol refuses them outright ("answered by the CLI itself ... run it as
   * its own --print invocation").
   */
  private static readonly AGY_PASSTHROUGH_COMMANDS = new Set([
    '/help', '/model', '/skills', '/usage', '/config', '/changelog',
    '/agents', '/permissions', '/hooks', '/credits',
  ]);

  private async listLocalSkills(cwd: string, backend: 'claude' | 'agy' | 'codex'): Promise<string[]> {
    const roots = backend === 'codex'
      ? [join(cwd, '.agents', 'skills'), join(homedir(), '.codex', 'skills'), join(homedir(), '.codex', 'skills', '.system')]
      : [join(cwd, '.claude', 'skills'), join(homedir(), '.claude', 'skills')];
    const skills: string[] = [];
    const seen = new Set<string>();

    for (const root of roots) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        const skillPath = join(root, entry.name, 'SKILL.md');
        try {
          const content = await readFile(skillPath, 'utf8');
          const description = content.match(/^description:\s*(.+)$/mi)?.[1]?.trim();
          skills.push(description ? `${entry.name} — ${description}` : entry.name);
          seen.add(entry.name);
        } catch {
          continue;
        }
      }
    }

    return skills.sort((left, right) => left.localeCompare(right));
  }

  /**
   * Which backend slash commands should be forwarded to for a thread.
   */
  private resolveSlashBackend(threadId: string): 'claude' | 'agy' | 'codex' | 'opencode' | 'kimi' | 'zcode' | 'pi' {
    return this.threadPool.getBackendKey(threadId);
  }

  /**
   * Execute passthrough slash command on the active backend's CLI.
   *
   * - Claude: `claude <cmd> --print` (full slash-command support).
   * - AGY: only the read-only informational commands agy answers locally in
   *   print mode (AGY_PASSTHROUGH_COMMANDS) are forwarded as `agy -p "<cmd>"`.
   *   /compact is explicitly refused: outside the TUI it reaches the model as
   *   plain text and the model only pretends to compact (verified live).
   * - Codex: no interactive-TUI slash passthrough. Remote CLI built-ins are
   *   implemented through app-server methods instead.
   * - OpenCode/Kimi/ZCode/Pi: send native commands through the persistent
   *   backend session; ZCode maps the shared /skills name to /skill.
   *   Pi lists skills via RPC `get_commands` when the command is /skills.
   */
  private async executeSlashCommand(
    messageId: string,
    threadId: string,
    command: string,
    executor: IExecutor
  ): Promise<void> {
    const backend = this.resolveSlashBackend(threadId);

    if (SLASH_SESSION_BACKENDS.has(backend)) {
      // ZCode names its native skill-list command /skill, while remote-cli
      // exposes the cross-backend command as /skills.
      const backendCommand = backend === 'zcode' && command.trim() === '/skills' ? '/skill' : command;
      const result = await executor.execute(backendCommand, {
        onStream: (chunk) => this.sendStreamChunk(messageId, threadId, chunk),
        onToolUse: (toolUse) => this.sendToolUse(messageId, threadId, toolUse),
        onToolResult: (toolResult) => this.sendToolResult(messageId, threadId, toolResult),
        onPlanMode: (plan) => this.sendPlanMode(messageId, threadId, plan),
        onImage: (image) => this.sendImage(messageId, threadId, image),
      });
      this.sendResponse(messageId, threadId, result.success
        ? { success: true, output: result.output || '✅ Command executed successfully' }
        : { success: false, error: result.error || `${backendDisplayName(backend)} command failed` });
      return;
    }

    if (backend === 'codex') {
      this.sendResponse(messageId, threadId, {
        success: false,
        error: `❌ "${command}" is not exposed as a Codex backend command.\n\nBuilt-in commands (/clear, /compact, /model, /effort, /cd, /thread, /backend, /abort, /status, /help) work on the supported backends.`,
      });
      return;
    }

    if (backend === 'agy') {
      const name = command.trim().split(/\s+/)[0].toLowerCase();
      if (name === '/compact') {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: '❌ /compact cannot be forwarded to AGY CLI — in non-interactive mode it is not intercepted and the model would only pretend to compact (history stays intact). Use the built-in /compact (summarize-then-reset) instead.',
        });
        return;
      }
      if (!MessageHandler.AGY_PASSTHROUGH_COMMANDS.has(name)) {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: `❌ "${command}" is not supported on the AGY backend in non-interactive mode.\n\nSupported passthrough commands: ${[...MessageHandler.AGY_PASSTHROUGH_COMMANDS].join(' ')} (read-only; /model lists models but cannot set one — use the built-in /model <name> for that).`,
        });
        return;
      }
      const executorConfig = (this.config.get('executor') as ExecutorConfig | undefined) ?? { type: 'auto' };
      const agyCommand = executorConfig.agy?.command ?? 'agy';
      return this.spawnPassthroughCommand(messageId, threadId, agyCommand, ['-p', command], executor, 'AGY CLI');
    }

    return this.spawnPassthroughCommand(messageId, threadId, 'claude', [command, '--print'], executor, 'Claude CLI', { CLAUDECODE: '' });
  }

  /**
   * Spawn a one-shot CLI process for a passthrough slash command and relay
   * its output back to the user.
   */
  private spawnPassthroughCommand(
    messageId: string,
    threadId: string,
    bin: string,
    args: string[],
    executor: IExecutor,
    label: string,
    extraEnv: Record<string, string> = {}
  ): Promise<void> {
    return new Promise((resolve) => {
      const chunks: string[] = [];
      const errorChunks: string[] = [];

      console.log(`[MessageHandler] Spawning ${label} for command: ${args.join(' ')}`);

      const child = spawn(bin, args, {
        cwd: executor.getCurrentWorkingDirectory(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...extraEnv },
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
        console.error(`[MessageHandler] Failed to spawn ${label}:`, error);
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
    attachments?: Attachment[],
    fromQueue = false,
  ): Promise<boolean> {
    const complete = (success: boolean, error?: string): boolean => {
      const responseError = fromQueue && !success
        ? this.pauseQueueAfterFailure(threadId, error || 'Queued command failed') : error;
      this.sendResponse(messageId, threadId, { success, error: responseError, threads: this.threadPool.getSummaries() });
      if (fromQueue) console.log(`[MessageHandler] Finished queued message ${messageId} in thread ${threadId}: success=${success}, remaining=${this.threadQueues.get(threadId)?.length ?? 0}, paused=${this.pausedQueues.has(threadId)}`);
      return success;
    };
    try {
      const openId = this.getMessageOpenId(messageId);
      const onTaskNotification = (notification: TaskNotificationInfo): void => {
        if (this.isDestroyed || !this.threadManager.getThread(threadId)) return;
        this.notificationAdapter.sendTaskNotification({ ...notification, threadId }, openId);
      };
      const emittedLocalImages = new Set<string>();
      const pendingLocalImageEmissions = new Set<Promise<void>>();
      let streamedOutput = '';
      const emitLocalImages = async (text: string): Promise<void> => {
        const thread = this.threadManager.getThread(threadId);
        if (!text || !thread?.workingDirectory) return;
        const images = await readLocalImages(text, thread.workingDirectory, (candidate, cwd) => (
          this.directoryGuard.isSafePath(candidate, cwd)
        ));
        for (const image of images) {
          if (emittedLocalImages.has(image.path)) continue;
          emittedLocalImages.add(image.path);
          this.sendImage(messageId, threadId, {
            type: 'image',
            data: image.data,
            mimeType: image.mimeType,
          });
        }
      };
      const queueLocalImages = (text: string): void => {
        const pending = emitLocalImages(text).finally(() => pendingLocalImageEmissions.delete(pending));
        pendingLocalImageEmissions.add(pending);
      };
      const executeOptions = {
        onApprovalRequest: (approval: ApprovalRequestInfo) => this.forwardApproval(approval, executor, messageId, threadId),
        onApprovalResolved: (requestId: string, status: ApprovalStatus) => this.resolveApprovalCard(requestId, status),
        onTaskNotification,
        onStream: (chunk: string) => {
          streamedOutput += chunk;
          this.sendStreamChunk(messageId, threadId, chunk);
        },
        onToolUse: (toolUse: ToolUseInfo) => this.sendToolUse(messageId, threadId, toolUse),
        onToolResult: (toolResult: ToolResultInfo) => {
          this.sendToolResult(messageId, threadId, toolResult);
          queueLocalImages(toolResult.content);
        },
        onRedactedThinking: () => this.sendRedactedThinking(messageId, threadId),
        onPlanMode: (planContent: string) => this.sendPlanMode(messageId, threadId, planContent),
        onImage: (image: ImageBlock) => this.sendImage(messageId, threadId, image),
        attachments,
      };
      let result = await executor.execute(content, executeOptions);
      await Promise.all(pendingLocalImageEmissions);
      await emitLocalImages(`${streamedOutput}\n${result.output ?? ''}`);

      if (await this.clearInvalidCodexModel(threadId, executor, result.error)) {
        this.sendStreamChunk(
          messageId,
          threadId,
          '⚠️ The saved Codex model is unavailable for this account. Cleared it and retrying with the backend default...\n'
        );
        result = await executor.execute(content, executeOptions);
      }

      if (!result.success && result.error && result.error.includes('Prompt too long')) {
        if ('compactWhenFull' in executor && typeof executor.compactWhenFull === 'function') {
          this.sendStreamChunk(messageId, threadId, '🔄 Context window full. Compacting conversation history, please wait...\n');
          const compactResult = await executor.compactWhenFull!((chunk: string) => {
            this.sendStreamChunk(messageId, threadId, chunk);
          });
          if (!compactResult.success) {
            return complete(false, `❌ Auto-compact failed: ${compactResult.error}\n\nUse /compact to try again, or /clear to start fresh.`);
          }
          this.sendStreamChunk(messageId, threadId, '✅ Compaction done. Retrying your request...\n');
          const retryResult = await executor.execute(content, {
            onTaskNotification,
            onStream: (chunk: string) => {
              streamedOutput += chunk;
              this.sendStreamChunk(messageId, threadId, chunk);
            },
            onToolUse: (toolUse: ToolUseInfo) => this.sendToolUse(messageId, threadId, toolUse),
            onToolResult: (toolResult: ToolResultInfo) => {
              this.sendToolResult(messageId, threadId, toolResult);
              queueLocalImages(toolResult.content);
            },
            onRedactedThinking: () => this.sendRedactedThinking(messageId, threadId),
            onPlanMode: (planContent: string) => this.sendPlanMode(messageId, threadId, planContent),
            onImage: (image: ImageBlock) => this.sendImage(messageId, threadId, image),
            attachments,
          });
          await Promise.all(pendingLocalImageEmissions);
          await emitLocalImages(`${streamedOutput}\n${retryResult.output ?? ''}`);
          return complete(retryResult.success, retryResult.error);
        }
        return complete(false, '❌ Conversation history too long.\n\nUse /compact to compress it, or /clear to start fresh.');
      }

      return complete(result.success, result.error);
    } catch (error) {
      return complete(false, error instanceof Error ? error.message : 'Execution error');
    }
  }

  private async clearInvalidCodexModel(
    threadId: string,
    executor: IExecutor,
    error?: string
  ): Promise<boolean> {
    if (!error || !this.isUnavailableCodexModelError(error)) return false;

    const executorConfig = (this.config.get('executor') as ExecutorConfig | undefined) ?? { type: 'auto' };
    if (this.threadPool.getBackendKey(threadId) !== 'codex') return false;

    const thread = this.threadManager.getThread(threadId);
    if (!thread?.models?.codex) return false;

    const models = { ...thread.models };
    delete models.codex;
    await this.threadManager.updateThread(threadId, { models });
    await executor.clearModel?.();
    return true;
  }

  private isUnavailableCodexModelError(error: string): boolean {
    return /model[^\n]*(?:not supported when using Codex with a ChatGPT account|not found|does not exist)/i.test(error)
      || /unknown Codex model/i.test(error);
  }

  // ── Outgoing message helpers ──────────────────────────────────────────────

  private getMessageOpenId(messageId: string): string | undefined {
    return this.messageOpenIds.get(messageId) ?? this.currentOpenId;
  }

  private trackTask(messageId: string, threadId: string, content: string): void {
    const openId = this.getMessageOpenId(messageId);
    const thread = this.threadManager.getThread(threadId);
    if (!openId || !thread) return;
    this.wsClient.trackTask({ messageId, threadId, openId, threadName: thread.name,
      backend: this.threadPool.getBackendKey(threadId),
      cwd: this.threadPool.getExecutor(threadId).getCurrentWorkingDirectory(), preview: content });
  }

  private forwardApproval(approval: ApprovalRequestInfo, executor: IExecutor, taskMessageId: string, threadId: string): boolean {
    const openId = this.getMessageOpenId(taskMessageId);
    if (!openId) return false;
    const request: ApprovalRequestMessage = { type: 'approval_request', messageId: approval.requestId,
      taskMessageId, openId, threadId, threadName: this.threadManager.getThread(threadId)?.name ?? threadId,
      cwd: executor.getCurrentWorkingDirectory(), approval, timestamp: Date.now() };
    this.pendingApprovalCards.set(approval.requestId, { request, executor });
    if (this.approvalCardsSupported) this.sendApprovalMessage(request);
    return this.approvalCardsSupported;
  }

  private sendApprovalMessage(message: ApprovalRequestMessage | ApprovalResolvedMessage): void {
    try { this.wsClient.send(message); } catch { /* Pending approvals are resent after registration. */ }
  }

  private showApprovalFallback(requestId: string): void {
    const pending = this.pendingApprovalCards.get(requestId);
    if (!pending) return;
    const { request } = pending;
    this.sendStreamChunk(request.taskMessageId, request.threadId,
      `\nApproval required: ${request.approval.description}\nReply yes, no${request.approval.canRemember ? ', or remember to save these directories' : ''}.\n`);
  }

  private resolveApprovalCard(requestId: string, status: ApprovalStatus): void {
    const pending = this.pendingApprovalCards.get(requestId);
    if (!pending) return;
    this.pendingApprovalCards.delete(requestId);
    if (this.approvalCardsSupported) this.sendApprovalMessage({ type: 'approval_resolved', messageId: requestId,
      openId: pending.request.openId, threadId: pending.request.threadId, status, timestamp: Date.now() });
  }

  private handleApprovalResponse(message: ApprovalResponseMessage): void {
    const pending = this.pendingApprovalCards.get(message.messageId);
    if (!pending || pending.request.threadId !== message.threadId || pending.request.openId !== message.openId
      || pending.request.taskMessageId !== message.taskMessageId) {
      this.sendApprovalMessage({ type: 'approval_resolved', messageId: message.messageId,
        openId: message.openId, threadId: message.threadId, status: 'expired', timestamp: Date.now() });
      return;
    }
    let accepted = false;
    try { accepted = pending.executor.respondToApproval?.(message.messageId, message.action) === true; } catch { /* Report failure without approving another request. */ }
    if (accepted) {
      this.resolveApprovalCard(message.messageId, message.action === 'remember' ? 'remembered' : message.action === 'deny' ? 'denied' : 'approved');
    } else if (this.pendingApprovalCards.has(message.messageId)) {
      this.sendApprovalMessage({ type: 'approval_resolved', messageId: message.messageId,
        openId: message.openId, threadId: message.threadId, status: 'pending',
        error: 'Approval could not be applied. Check the task output or choose another action.', timestamp: Date.now() });
    }
  }

  private sendStreamChunk(messageId: string, threadId: string | undefined, chunk: string): void {
    try {
      this.wsClient.send({
        type: 'stream',
        messageId,
        chunk,
        streamType: 'text',
        openId: this.getMessageOpenId(messageId),
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
        openId: this.getMessageOpenId(messageId),
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
        openId: this.getMessageOpenId(messageId),
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
        openId: this.getMessageOpenId(messageId),
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
        openId: this.getMessageOpenId(messageId),
        threadId,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Failed to send plan mode:', error);
    }
  }

  private sendImage(messageId: string, threadId: string | undefined, image: ImageBlock): void {
    try {
      this.wsClient.send({
        type: 'stream',
        messageId,
        streamType: 'image',
        image,
        openId: this.getMessageOpenId(messageId),
        threadId,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Failed to send generated image:', error);
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
        openId: this.getMessageOpenId(messageId),
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
      queueConfirmation?: QueueConfirmationInfo;
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
        openId: this.getMessageOpenId(messageId),
        threadId,
        threads: result.threads,
        queueConfirmation: result.queueConfirmation,
        cwd,
        timestamp: Date.now(),
      });
      this.messageOpenIds.delete(messageId);
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
    const executorConfig = (this.config.get('executor') as ExecutorConfig | undefined) ?? { type: 'auto' };
    const [claudeInstalled, codexInstalled, openCodeInstalled, kimiInstalled, piInstalled, agyInstalled] = await Promise.all([
      this.checkCommand('claude', ['--version']),
      this.checkCommand('codex', ['--version']),
      this.checkCommand('opencode', ['--version']),
      this.checkCommand('kimi', ['--version']),
      this.checkCommand(executorConfig.pi?.command ?? 'pi', ['--version']),
      this.checkCommand('agy', ['--version']),
    ]);
    return [
      { id: 'auto', label: 'Claude Code', installed: claudeInstalled },
      { id: 'codex', label: 'Codex CLI (OpenAI)', installed: codexInstalled },
      { id: 'opencode', label: 'OpenCode CLI', installed: openCodeInstalled },
      { id: 'kimi', label: 'Kimi Code CLI', installed: kimiInstalled },
      { id: 'zcode', label: 'ZCode', installed: isZCodeAvailable(executorConfig.zcode?.command) },
      { id: 'pi', label: 'Pi', installed: piInstalled },
      { id: 'agy',  label: 'AGY CLI (Antigravity)', installed: agyInstalled },
    ];
  }

  private async handleBackendCommand(
    messageId: string,
    threadId: string,
    trimmed: string
  ): Promise<void> {
    const parts = trimmed.split(/\s+/);
    const arg = parts[1];
    const isThreadOverride = parts[2] === '@';

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
        const isClaudeActive = b.id === 'auto' && backendKeyOf(currentType) === 'claude';
        const isAgyActive = b.id === 'agy' && currentType === 'agy';
        const active = b.id === currentType || isClaudeActive || isAgyActive ? ' ★ (active)' : '';
        return `${i + 1}. ${b.label}${active}`;
      });
      const currentBackend = this.threadPool.getBackendKey(threadId);
      lines.push(`\nCurrent thread backend: ${currentBackend}${this.threadManager.getThread(threadId)?.backend ? ' (override)' : ' (global)'}`);
      this.sendResponse(messageId, threadId, {
        success: true,
        output: `🤖 Available AI backends:\n${lines.join('\n')}\n\nSwitch all threads with: /backend <index>\nSwitch this thread with: /backend <index> @\nReset this thread: /backend default @`,
        threads: this.threadPool.getSummaries(),
      });
      return;
    }

    if (arg === 'default' && isThreadOverride) {
      if (this.threadPool.isThreadBusy(threadId)) {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: 'Cannot reset backend while this thread is running. Send /abort first.',
        });
        return;
      }
      await this.threadPool.destroyThread(threadId, { deleteData: false });
      await this.threadManager.updateThread(threadId, { backend: undefined });
      const clearedCount = this.clearThreadQueue(threadId);
      this.sendResponse(messageId, threadId, {
        success: true,
        output: `✅ Thread backend reset to the global backend (${backendKeyOf(currentType as string)}).${clearedCount ? `\n🗑️ Cleared ${clearedCount} queued message${clearedCount === 1 ? '' : 's'}.` : ''}`,
        threads: this.threadPool.getSummaries(),
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
    if (isThreadOverride) {
      try {
        await this.threadPool.switchThreadBackend(threadId, backendKeyOf(target.id));
        const clearedCount = this.clearThreadQueue(threadId);
        this.sendResponse(messageId, threadId, {
          success: true,
          output: `✅ This thread switched to: ${target.label}${clearedCount ? `\n🗑️ Cleared ${clearedCount} queued message${clearedCount === 1 ? '' : 's'}.` : ''}\n\nUse /backend ${installed.indexOf(target) + 1} to switch all threads, or /backend default @ to follow the global backend again.`,
          threads: this.threadPool.getSummaries(),
        });
      } catch (error) {
        this.sendResponse(messageId, threadId, {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to switch thread backend',
        });
      }
      return;
    }

    if (this.threadPool.getSummaries().some((thread) => thread.status === 'running')) {
      this.sendResponse(messageId, threadId, {
        success: false,
        error: 'Cannot switch all backends while a thread is running. Send /abort first.',
      });
      return;
    }

    await this.config.set('executor', newConfig);
    await this.threadPool.switchBackend(newConfig);
    await this.threadManager.clearBackendOverrides();
    const clearedCount = this.clearAllQueues();

    this.sendResponse(messageId, threadId, {
      success: true,
      output: `✅ Backend switched to: ${target.label}${clearedCount ? `\n🗑️ Cleared ${clearedCount} queued message${clearedCount === 1 ? '' : 's'}.` : ''}\n\nAll threads will use the new backend for future commands. Conversations on the previous backend are preserved — switch back to resume them.`,
      threads: this.threadPool.getSummaries(),
    });
  }

  /**
   * Destroy handler and all executors
   */
  async destroy(): Promise<void> {
    this.isDestroyed = true;
    this.notificationAdapter.unregister();
    try {
      await this.threadPool.destroyAll({ deleteData: false });
      this.pendingApprovalCards.clear();
    } catch (err) {
      console.error('Error destroying thread executors:', err);
    }
  }
}

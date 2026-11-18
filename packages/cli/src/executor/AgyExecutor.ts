import { AgyAcpRuntime } from './agy/AgyAcpRuntime';
import { agyHostScheduleHistory, assertAgySelectionResettable, detachAgySelection } from './agy/AgySessionSelection';
import { createHash, randomUUID } from 'crypto';
import { syncDirectory } from '../delegation/OwnershipRuntime';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectoryGuard } from '../security/DirectoryGuard';
import type { IExecutor, ExecuteOptions, ExecuteResult, ExecutorModelInfo, ExecutorEffortInfo } from './IExecutor';
import type { ApprovalAction } from '../types';
import { configuredExecutionMetadata } from './ExecutionMetadata';
import { COMPACT_HANDOFF_PROMPT, seedPromptWithHandoff } from './compactHandoff';
import { stripAnsi } from '../utils/stripAnsi';
import { delegationSessionServers, delegationEnvironment, sameConnection, type DelegationConnection } from '../delegation/contract';
import { parseAgyModels } from './agy/AgyModels';
import type { AgyDeletionTarget } from '../delegation/AgySessionDeletion';
import type { NativeDirectoryIdentity } from '../delegation/NativeSessionDeletion';

export interface AgyExecutorOptions {
  model?: string;
  effort?: string;
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  agyCommand?: string;
  threadId?: string;
  delegationWorker?: boolean;
  inactivityTimeoutMs?: number;
}
const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const ACCOUNT_USAGE_TIMEOUT_MS = 15_000;
const ACCOUNT_USAGE_MAX_BUFFER = 128 * 1024;
const SUPPORTED_EFFORTS = ['low', 'medium', 'high'] as const;
/**
 * Entries shared from the real ~/.gemini into each per-thread HOME via symlink.
 * agy resolves its data directory from $HOME/.gemini — without sharing these,
 * every thread would need its own agy login and would re-download program data.
 * These links are not a filesystem security boundary.
 */
const AGY_HOME_SHARED_FILES = [
  'oauth_creds.json',
  'google_accounts.json',
  'settings.json',
  'installation_id',
  'trustedFolders.json',
  'GEMINI.md',
];
const AGY_HOME_SHARED_DIRS = ['skills', 'config'];
/** Shared login, settings, and programs inside .gemini/antigravity-cli. */
const AGY_CLI_SHARED_FILES = ['antigravity-oauth-token', 'settings.json', 'installation_id'];
const AGY_CLI_SHARED_DIRS = ['bin', 'builtin', 'cache', 'updater'];

/**
 * Map an AGY tool call to a Claude-compatible { name, input } shape so the
 * router's ToolFormatter renders it with the same card style as Claude tools.
 * Unknown tools keep their raw name and parameters (generic rendering).
 *
 * AGY parameter keys are PascalCase (e.g. run_command takes `CommandLine`).
 */
function mapAgyTool(
  toolName: string,
  parameters: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  switch (toolName) {
    case 'run_command':
      return { name: 'Bash', input: { command: parameters.CommandLine ?? '' } };
    case 'view_file':
      return { name: 'Read', input: { file_path: parameters.AbsolutePath ?? parameters.Path ?? '' } };
    case 'write_to_file':
      return { name: 'Write', input: { file_path: parameters.AbsolutePath ?? parameters.Path ?? '' } };
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'sed_file':
      return { name: 'Edit', input: { file_path: parameters.AbsolutePath ?? parameters.Path ?? '' } };
    case 'grep_search':
      return { name: 'Grep', input: parameters };
    case 'find_by_name':
      return { name: 'Glob', input: parameters };
    case 'search_web':
      return { name: 'WebSearch', input: { query: parameters.Query ?? parameters.query ?? '' } };
    case 'read_url_content':
      return { name: 'WebFetch', input: { url: parameters.Url ?? '' } };
    default:
      return { name: toolName, input: parameters };
  }
}


export { parseAgyModels };

/** ACP is the sole conversation transport. Legacy metadata remains readable only
 * for explicit selection reset and exact history cleanup. */
export class AgyExecutor implements IExecutor {
  private currentWorkingDirectory: string;
  private model?: string;
  private effort?: string;
  private readonly autoApprove: boolean;
  private readonly agyCommand: string;
  private readonly threadId?: string;
  private readonly agyHome?: string;
  private readonly delegationWorker: boolean;
  private readonly inactivityTimeoutMs: number;
  private readonly sessionFilePath: string;
  private conversationId: string | null = null;
  private legacy = false;
  private acpLeaseUnconfirmed = false;
  private acp?: AgyAcpRuntime;
  private isDestroyed = false;
  private isProcessing = false;
  private transitioning = false;
  private shutdownUncertain = false;
  private pendingContextSeed: string | null = null;
  private delegationConnection?: DelegationConnection;
  private nativeObserver?: (target: AgyDeletionTarget) => Promise<void>;
  private nativeCaptureFailure?: () => Promise<void>;
  private nativeCaptureUnconfirmed = false;
  private workerProof?: { sessionId: string; policy: string; settled: boolean; closed: boolean };
  private scheduleOwner?: { sessionId: string; hostId: string; retired: boolean };
  private resumeCurrent = false;
  private allocationUnconfirmed = false;
  private hostGeneration?: string;
  private unpromptedReconnect?: { sessionId: string; generation: string; history: string };

  constructor(private readonly directoryGuard: DirectoryGuard, options: AgyExecutorOptions = {}) {
    this.model = options.model; this.effort = options.effort;
    this.autoApprove = options.autoApprove ?? true; this.agyCommand = options.agyCommand ?? 'agy';
    this.threadId = options.threadId; this.delegationWorker = options.delegationWorker ?? false;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.currentWorkingDirectory = options.initialWorkingDirectory ? directoryGuard.resolveWorkingDirectory(options.initialWorkingDirectory) : process.cwd();
    if (this.threadId) {
      const sessions = path.join(os.homedir(), '.remote-cli', 'agy-sessions');
      fs.mkdirSync(sessions, { recursive: true });
      this.sessionFilePath = path.join(sessions, `${this.threadId}.json`);
      this.agyHome = path.join(os.homedir(), '.remote-cli', 'agy-homes', this.threadId);
    } else this.sessionFilePath = path.join(this.currentWorkingDirectory, '.agy-session');
    this.allocationUnconfirmed = fs.existsSync(this.sessionFilePath + '.allocation-unconfirmed');
    if (fs.existsSync(this.sessionFilePath)) {
      const pointer = JSON.parse(fs.readFileSync(this.sessionFilePath, 'utf8'));
      if (typeof pointer.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(pointer.id)) throw new Error('Saved AGY identity is invalid; retained state was not changed.');
      this.conversationId = pointer.id; this.legacy = pointer.transport !== 'acp'; this.acpLeaseUnconfirmed = !this.legacy;
    }
    if (fs.existsSync(this.sessionFilePath + '.native-schedules')) {
      const owner = JSON.parse(fs.readFileSync(this.sessionFilePath + '.native-schedules', 'utf8'));
      if (!this.conversationId || typeof owner.sessionId !== 'string' || typeof owner.hostId !== 'string' || typeof owner.retired !== 'boolean') throw new Error('AGY schedule ownership journal is unreadable; admission is blocked.');
      this.scheduleOwner = owner;
    }
    if (this.delegationWorker && fs.existsSync(this.sessionFilePath + '.worker-policy')) {
      this.workerProof = JSON.parse(fs.readFileSync(this.sessionFilePath + '.worker-policy', 'utf8'));
    }
  }
  private writeNativeState(file: string, data: unknown): void {
    const temporary = file + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
  }
  private hostSelection(id: string) {
    assertAgySelectionResettable(this.sessionFilePath);
    const stat = fs.lstatSync(this.sessionFilePath);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error('Unsafe AGY selection.');
    const pointer = JSON.parse(fs.readFileSync(this.sessionFilePath, 'utf8'));
    if (pointer.id !== id || pointer.transport !== 'acp') throw new Error('The original AGY conversation changed.');
    return pointer;
  }
  private checkpointConfiguration(): string {
    return createHash('sha256').update(JSON.stringify([this.threadId, this.agyHome, this.currentWorkingDirectory,
      this.agyCommand, this.model, this.effort, this.autoApprove])).digest('hex');
  }
  private cleanHostSelection(id: string) {
    const pointer = this.hostSelection(id);
    const checkpoint = pointer.hostScheduleCheckpoint;
    if (!this.agyHome || !checkpoint || checkpoint.policy !== 'host-timed-chat-v1'
      || typeof pointer.hostGeneration !== 'string' || checkpoint.generation !== pointer.hostGeneration
      || checkpoint.configuration !== this.checkpointConfiguration()
      || checkpoint.history !== agyHostScheduleHistory(this.agyHome, id)) {
      throw new Error('Saved AGY ACP chat cannot safely resume: the clean host-timed checkpoint is missing or changed.');
    }
    return pointer;
  }
  checkHostScheduleSession(id: string): void {
    if (!id || id !== this.conversationId || this.isDestroyed || this.shutdownUncertain || this.transitioning
      || this.delegationWorker || this.legacy || this.allocationUnconfirmed || this.scheduleOwner) {
      throw new Error('The original AGY scheduled conversation is unavailable.');
    }
    if (!this.acp) { this.cleanHostSelection(id); return; }
    if (!this.acp.hostScheduleAvailable || this.acp.sessionId !== id || !this.hostGeneration
      || this.hostSelection(id).hostGeneration !== this.hostGeneration) {
      throw new Error('AGY host timing requires a verified foreground conversation with no uncertain native work.');
    }
  }
  private saveWorkerProof(): void {
    if (this.workerProof) this.writeNativeState(this.sessionFilePath + '.worker-policy', this.workerProof);
  }
  private assertNoRetainedSchedules(): void {
    if (this.acp?.hasJobs || this.scheduleOwner) throw new Error('AGY native notifications remain owned and unconfirmed. Settings and transport changes are unavailable; inspect /schedule list.');
  }
  private assertScheduleResettable(allowOwnedRetirement = false, detachSelection = false): void {
    if (this.allocationUnconfirmed || fs.existsSync(this.sessionFilePath + '.allocation-unconfirmed')) throw new Error('AGY allocation ownership is unconfirmed; retain its evidence.');
    if (fs.existsSync(this.sessionFilePath + '.checkpoint.lock')) throw new Error('AGY checkpoint transition is unconfirmed; retained state cannot be discarded.');
    if (this.acpLeaseUnconfirmed && !this.acp && !detachSelection) throw new Error('Saved AGY ACP host retirement is unconfirmed; keep the original history.');
    if (this.scheduleOwner && this.scheduleOwner.sessionId !== this.conversationId) throw new Error('AGY schedule owner does not match the original conversation.');
    if (this.scheduleOwner && !this.scheduleOwner.retired && !(allowOwnedRetirement && this.acp?.canRetireForContextReset)) throw new Error('AGY native notifications have unresolved ownership; use a new thread.');
  }
  private async runtime(legacyNativeScheduling = false): Promise<AgyAcpRuntime> {
    if (this.acp) return this.acp;
    if (this.allocationUnconfirmed) throw new Error('AGY allocation reply was lost. Native ownership is unconfirmed; do not retry this worker or conversation automatically.');
    if (this.isDestroyed || this.shutdownUncertain) throw new Error('AGY executor is closed or its process exit is unconfirmed.');
    if (!this.threadId || !this.agyHome) throw new Error('AGY ACP requires a thread-scoped HOME. Select a thread before chatting.');
    if (this.legacy) throw new Error(this.delegationWorker
      ? 'Legacy AGY worker history cannot execute over ACP. Use this worker card Clear action or parent /clear after task/artifact closeout; original history is retained.'
      : 'Legacy AGY conversation cannot execute over ACP. Use explicit /clear to start fresh; original native history is retained.');
    let cleanGeneration: string | undefined;
    if (this.conversationId) {
      if (this.scheduleOwner) throw new Error('AGY saved chat cannot safely resume: native notifications remain unconfirmed. Use a new thread.');
      const proof = this.workerProof;
      if (!this.delegationWorker && this.hostSelection(this.conversationId).hostScheduleCheckpoint) {
        cleanGeneration = this.cleanHostSelection(this.conversationId).hostGeneration;
      }
      if (!cleanGeneration && !this.resumeCurrent && !(this.delegationWorker && proof?.sessionId === this.conversationId
        && proof.policy === 'hook-denial-v2' && proof.settled && proof.closed)) {
        throw new Error('Saved AGY ACP chat cannot safely resume: pending work is unconfirmed. Use explicit /clear when no schedule owner remains, or a new thread; original history is retained.');
      }
    }
    const env = this.buildEnv(); env.HOME = this.agyHome; env.USERPROFILE = this.agyHome;
    let scope: NativeDirectoryIdentity | undefined;
    let preexisting = new Set<string>();
    if (this.nativeObserver && !this.conversationId) {
      const root = path.join(this.agyHome, '.gemini', 'antigravity-cli');
      if (fs.realpathSync(root) !== root) throw new Error('AGY creation root is redirected.');
      const stat = fs.lstatSync(root, { bigint: true }); scope = { path: root, dev: String(stat.dev), ino: String(stat.ino) };
      const store = path.join(root, 'conversations');
      if (fs.existsSync(store) && fs.realpathSync(store) !== store) throw new Error('AGY history is redirected.');
      const names = fs.existsSync(store) ? fs.readdirSync(store) : [];
      if (names.length > 4096) throw new Error('AGY history inventory is too large.');
      preexisting = new Set(names.map(name => name.replace(/\.db(?:-wal|-shm|-journal)?$/, '')));
    }
    const original = this.conversationId;
    const firstSetup = this.resumeCurrent && original && this.unpromptedReconnect?.sessionId === original
      ? this.unpromptedReconnect : undefined;
    const hostScheduleChat = !this.delegationWorker && (!!cleanGeneration || !!firstSetup || !original
      && (!legacyNativeScheduling || this.delegationConnection?.groups?.includes('scheduling') === true));
    let priorHostHistories: Set<string> | undefined;
    // A controlled reconnect is single-use; a failed load cannot authorize retries.
    this.resumeCurrent = false;
    this.unpromptedReconnect = undefined;
    if (this.workerProof) { this.workerProof.closed = false; this.saveWorkerProof(); }
    this.acp = new AgyAcpRuntime({ command: this.agyCommand, home: this.agyHome, cwd: this.currentWorkingDirectory,
      threadId: this.threadId, env, model: this.model, effort: this.effort, autoApprove: this.autoApprove,
      sessionId: original ?? undefined, worker: this.delegationWorker,
      hostScheduleChat,
      beforeSessionLoad: original && (cleanGeneration || firstSetup) ? () => {
        const pointer = firstSetup ? this.hostSelection(original) : this.cleanHostSelection(original);
        if (pointer.hostGeneration !== (firstSetup?.generation ?? cleanGeneration)
          || firstSetup && firstSetup.history !== agyHostScheduleHistory(this.agyHome!, original, true)) {
          throw new Error('AGY host-timed checkpoint was replaced.');
        }
        delete pointer.hostScheduleCheckpoint;
        this.hostGeneration = randomUUID();
        this.writeNativeState(this.sessionFilePath, { ...pointer, hostGeneration: this.hostGeneration });
      } : undefined,
      mcpServers: delegationSessionServers(this.delegationConnection), mapTool: mapAgyTool,
      beforeAllocation: () => {
        if (hostScheduleChat) {
          // Ordinary chat can still start when fresh-history provenance is unavailable.
          const root = path.join(fs.realpathSync(this.agyHome!), '.gemini', 'antigravity-cli');
          try {
            if (fs.realpathSync(root) === root) {
              const histories = new Set<string>();
              for (const directory of ['conversations', 'brain']) {
                const store = path.join(root, directory);
                if (!fs.lstatSync(store, { throwIfNoEntry: false })) continue;
                if (fs.realpathSync(store) !== store) throw new Error('AGY history is redirected.');
                const names = fs.readdirSync(store);
                if (names.length > 4096) throw new Error('AGY history inventory is too large.');
                for (const name of names) histories.add(name.split('.')[0].toLowerCase());
              }
              priorHostHistories = histories;
            }
          } catch { /* Incomplete history inventory cannot establish fresh ownership. */ }
        }
        this.writeNativeState(this.sessionFilePath + '.allocation-unconfirmed', { kind: 'agy-acp-allocation' });
      },
      saveSession: async id => {
        if (original) { if (id !== original) throw new Error('AGY loaded identity changed.'); return; }
        this.conversationId = id; this.acpLeaseUnconfirmed = true;
        this.hostGeneration = priorHostHistories && !priorHostHistories.has(id.toLowerCase()) ? randomUUID() : undefined;
        this.writeNativeState(this.sessionFilePath, { id, transport: 'acp', retired: false, savedAt: new Date().toISOString(),
          hostGeneration: this.hostGeneration });
        fs.rmSync(this.sessionFilePath + '.allocation-unconfirmed', { force: true });
        if (this.delegationWorker) { this.workerProof = { sessionId: id, policy: 'hook-denial-v2', settled: true, closed: false }; this.saveWorkerProof(); }
        if (this.nativeObserver) {
          try {
            if (!scope || preexisting.has(id)) throw new Error('AGY allocation is not a fresh owned identity.');
            const { captureAgyDeletionTarget } = await import('../delegation/AgySessionDeletion');
            const target = await captureAgyDeletionTarget({ sessionId: id, executorThreadId: this.threadId!, home: os.homedir(), cwd: this.currentWorkingDirectory, command: this.agyCommand });
            if (target.scope.dev !== scope.dev || target.scope.ino !== scope.ino) throw new Error('AGY creation root changed.');
            await this.nativeObserver(target);
          } catch {
            this.nativeCaptureUnconfirmed = true;
            if (this.workerProof) { this.workerProof.settled = false; this.saveWorkerProof(); }
            await this.nativeCaptureFailure?.();
            throw new Error('AGY creation receipt could not be persisted. No prompt was sent.');
          }
        }
      },
      beforePrompt: () => { if (this.workerProof) { this.workerProof.settled = false; this.saveWorkerProof(); } },
      settledPrompt: reusable => { if (this.workerProof) { this.workerProof.settled = reusable; this.saveWorkerProof(); } },
      ownedSessionClosed: (id, cleanHistory, unpromptedHistory) => {
        if (id === this.conversationId) this.acpLeaseUnconfirmed = false;
        if (this.workerProof?.sessionId === id) { this.workerProof.closed = true; this.saveWorkerProof(); }
        if ((cleanHistory || unpromptedHistory) && this.hostGeneration && id === this.conversationId) {
          const pointer = this.hostSelection(id);
          if (pointer.hostGeneration !== this.hostGeneration) throw new Error('AGY host-timed selection changed before retirement.');
          if (cleanHistory) {
            this.writeNativeState(this.sessionFilePath, { ...pointer, hostScheduleCheckpoint: {
              policy: 'host-timed-chat-v1', generation: this.hostGeneration, configuration: this.checkpointConfiguration(),
              history: cleanHistory,
            } });
          } else if (unpromptedHistory && this.transitioning) {
            // Only a controlled reconnect can carry settings-only provenance across group retirement.
            this.unpromptedReconnect = { sessionId: id, generation: this.hostGeneration, history: unpromptedHistory };
          }
        }
      },
      retainScheduleOwner: (sessionId, hostId, retired) => {
        this.scheduleOwner = { sessionId, hostId, retired };
        this.writeNativeState(this.sessionFilePath + '.native-schedules', this.scheduleOwner);
      },
    });
    return this.acp;
  }
  private buildEnv(): NodeJS.ProcessEnv {
    const delegationEnv = this.delegationConnection ? delegationEnvironment(this.delegationConnection)
      : this.delegationWorker ? { REMOTE_CLI_DELEGATION_URL: undefined, REMOTE_CLI_DELEGATION_TOKEN: undefined } : {};
    if (!this.agyHome) return { ...process.env, ...delegationEnv };
    this.ensureThreadHome();
    return { ...process.env, HOME: this.agyHome, ...(this.delegationWorker && process.platform === 'win32' ? { USERPROFILE: this.agyHome } : {}), ...delegationEnv };
  }

  /**
   * Create the thread's HOME layout: auth/config files and program directories
   * symlinked from the real ~/.gemini, data directories left for agy to create
   * per-thread. Runs before every spawn and leaves any files that agy replaced
   * locally untouched rather than overwriting shared credentials.
   */
  private ensureThreadHome(): void {
    const realGemini = path.join(os.homedir(), '.gemini');
    const threadGemini = path.join(this.agyHome!, '.gemini');
    fs.mkdirSync(threadGemini, { recursive: true });
    for (const name of AGY_HOME_SHARED_FILES) this.linkShared(realGemini, threadGemini, name, 'file');
    for (const name of AGY_HOME_SHARED_DIRS) {
      if (name === 'config') {
        // An interrupted overlay transaction may temporarily have no config
        // directory. Only its kernel-gated restoration may replace that entry.
        try { fs.lstatSync(path.join(this.agyHome!, '.remote-cli-agy-hooks.owner.json')); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      this.linkShared(realGemini, threadGemini, name, 'dir');
    }

    const realCli = path.join(realGemini, 'antigravity-cli');
    const threadCli = path.join(threadGemini, 'antigravity-cli');
    fs.mkdirSync(threadCli, { recursive: true });
    for (const name of AGY_CLI_SHARED_FILES) this.linkShared(realCli, threadCli, name, 'file');
    for (const name of AGY_CLI_SHARED_DIRS) {
      if (this.delegationWorker && name === 'cache') {
        // Never replace a legacy shared link. Such lanes cannot receive deletion receipts.
        if (!fs.existsSync(path.join(threadCli, name))) fs.mkdirSync(path.join(threadCli, name));
      } else this.linkShared(realCli, threadCli, name, 'dir');
    }
  }

  /**
   * Symlink one entry of the master store into the thread home. A regular
   * thread-local replacement may be stale or newer than the master. Never
   * overwrite either copy without a reliable cross-process freshness rule.
   */
  private linkShared(masterDir: string, threadDir: string, name: string, type: 'file' | 'dir'): void {
    const master = path.join(masterDir, name);
    if (!fs.existsSync(master)) return;
    const link = path.join(threadDir, name);
    if (fs.existsSync(link)) {
      let isLink = false;
      try {
        isLink = fs.lstatSync(link).isSymbolicLink();
      } catch {
        return; // lstat failed — leave the entry untouched
      }
      if (isLink) return;
      if (name === 'oauth_creds.json' || name === 'google_accounts.json' || name === 'antigravity-oauth-token') {
        console.warn(`[AgyExecutor] Thread-local ${name} replaced its shared link; leaving both copies untouched.`);
      }
      return;
    }
    fs.symlinkSync(master, link, type);
  }

  getCurrentWorkingDirectory(): string { return this.currentWorkingDirectory; }
  getSessionId(): string | null { return this.conversationId; }
  getExecutionMetadata() { return configuredExecutionMetadata(this.model, this.effort); }
  isProcessRunning(): boolean { return !!this.acp?.running; }
  isBusy(): boolean { return this.isProcessing || this.transitioning || this.shutdownUncertain || !!this.acp?.busy; }
  hasUncertainShutdown(): boolean { return this.shutdownUncertain; }
  isWaitingInput(): boolean { return this.acp?.isWaitingInput() ?? false; }
  sendInput(input: string): boolean { return this.acp?.sendInput(input) ?? false; }
  respondToApproval(id: string, action: ApprovalAction): boolean { return this.acp?.respondToApproval(id, action) ?? false; }
  preservesProcessOnAbort(): boolean { return true; }
  hasPendingCancellation(): boolean { return !!this.acp?.hasJobs && !!this.acp.blocked; }
  hasPendingScheduleMutation(): boolean { return this.acp?.cleanupMutationPending ?? false; }
  // Shared destructive-settings recovery is not an AGY capability. Busy
  // transitions are already enforced by isBusy/resetContext and must not bypass
  // the caller's schedule-idle guard.
  hasPendingSettingsChange(): boolean { return false; }
  async execute(prompt: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    if (this.isBusy() || this.isDestroyed) throw new Error('AGY executor is busy or destroyed.');
    const pinned = options.hostScheduleSessionId;
    if (pinned !== undefined) this.checkHostScheduleSession(pinned);
    this.isProcessing = true;
    try {
      const runtime = await this.runtime();
      try { await runtime.start(); }
      catch (error) {
        if (runtime.allocationUnconfirmed) {
          this.allocationUnconfirmed = true;
          this.nativeCaptureUnconfirmed = true;
          await this.nativeCaptureFailure?.();
        }
        if (!runtime.running) this.acp = undefined;
        throw error;
      }
      if (this.pendingContextSeed) {
        const seed = this.pendingContextSeed; this.pendingContextSeed = null;
        const resolve = options.resolvePrompt;
        options = { ...options, resolvePrompt: id => seedPromptWithHandoff(seed, resolve?.(id) ?? prompt) };
      }
      if (pinned !== undefined) {
        const resolve = options.resolvePrompt;
        options = { ...options, resolvePrompt: id => {
          this.checkHostScheduleSession(pinned);
          return resolve?.(id) ?? prompt;
        } };
      }
      return await runtime.execute(prompt, { ...options, inactivityTimeout: options.inactivityTimeout ?? this.inactivityTimeoutMs });
    } finally { this.isProcessing = false; }
  }
  async configureManagedTools(connection?: DelegationConnection): Promise<void> { await this.configureDelegation(connection); }
  async configureDelegation(connection?: DelegationConnection): Promise<void> {
    if (this.delegationWorker && connection) throw new Error('Managed child workers cannot register control tools.');
    if (sameConnection(this.delegationConnection, connection)) return;
    if (this.isBusy()) throw new Error('AGY work or native notifications are busy.');
    this.assertNoRetainedSchedules(); this.transitioning = true;
    try {
      if (this.acp) {
        if (!this.acp.reusable) throw new Error('AGY chat outcome is unconfirmed; reconnect was refused.');
        await this.acp.close(); this.acp = undefined; this.resumeCurrent = true;
      }
      this.delegationConnection = connection;
    } finally { this.transitioning = false; }
  }
  async setWorkingDirectory(target: string): Promise<void> {
    const resolved = this.directoryGuard.resolveWorkingDirectory(target, this.currentWorkingDirectory);
    if (resolved === this.currentWorkingDirectory) return;
    await this.resetContext(); this.currentWorkingDirectory = resolved;
  }
  async resetContext(): Promise<void> {
    if (this.allocationUnconfirmed) throw new Error('AGY allocation ownership is unconfirmed; use a new thread and retain this evidence.');
    if (this.isBusy()) throw new Error('Cannot clear AGY while work, native notifications or process retirement is pending.');
    const detach = !this.acp && !!this.conversationId && !this.scheduleOwner;
    this.assertScheduleResettable(true, detach); this.transitioning = true;
    try {
      if (this.acp) { await this.acp.close(); this.assertScheduleResettable(); this.acp = undefined; }
      if (this.acpLeaseUnconfirmed && !this.legacy) {
        if (!detachAgySelection(this.sessionFilePath)) throw new Error('AGY selection changed; clear was refused.');
      } else fs.rmSync(this.sessionFilePath, { force: true });
      this.conversationId = null; this.legacy = false; this.acpLeaseUnconfirmed = false; this.resumeCurrent = false;
      this.hostGeneration = undefined;
      this.unpromptedReconnect = undefined;
      this.pendingContextSeed = null; this.workerProof = undefined;
      fs.rmSync(this.sessionFilePath + '.worker-policy', { force: true });
      if (this.scheduleOwner?.retired) { fs.rmSync(this.sessionFilePath + '.native-schedules', { force: true }); this.scheduleOwner = undefined; }
    } finally { this.transitioning = false; }
  }
  async stopForContextReset(): Promise<void> { if (this.acp) await this.acp.close(); }
  async abort(): Promise<boolean> { return await this.acp?.abort() ?? false; }
  abortStatusMessage(): string {
    return this.acp?.hasJobs ? 'AGY foreground interrupted; native timers may still queue reminders and dispatch is blocked. Inspect /schedule list. No work is replayed.'
      : 'AGY foreground cancelled. Completed tool side effects remain; unconfirmed outcomes stay blocked.';
  }
  async destroy(): Promise<void> {
    this.isDestroyed = true;
    try { await this.acp?.close(); this.shutdownUncertain = false; }
    catch (error) { this.shutdownUncertain = true; throw error; }
  }
  async waitForExit(): Promise<void> { if (this.isDestroyed) await this.destroy(); }
  async waitForManagedProcessGroupExit(): Promise<void> {
    if (!this.delegationWorker || this.nativeCaptureUnconfirmed) throw new Error('AGY worker creation or ownership remains unconfirmed.');
    await this.acp?.waitForManagedProcessGroupExit();
  }
  observeNativeSessionCreation(observer: (target: AgyDeletionTarget) => Promise<void>, onFailure?: () => Promise<void>): void {
    if (!this.delegationWorker || !this.threadId?.startsWith('delegate-lane-') || this.acp) throw new Error('AGY native observation requires an unstarted managed worker.');
    this.nativeObserver = observer; this.nativeCaptureFailure = onFailure;
  }
  private async settings(change: { model?: string; effort?: string; mode?: string; resetModel?: boolean; resetEffort?: boolean }): Promise<void> {
    this.assertNoRetainedSchedules();
    if (this.isBusy() || this.isDestroyed) throw new Error('AGY is busy or destroyed.'); this.transitioning = true;
    let runtime: AgyAcpRuntime | undefined;
    try { runtime = await this.runtime(); await runtime.changeSettings(change); }
    catch (error) {
      if (runtime?.allocationUnconfirmed) {
        this.allocationUnconfirmed = true; this.nativeCaptureUnconfirmed = true;
        await this.nativeCaptureFailure?.();
      }
      if (runtime && !runtime.running) this.acp = undefined;
      throw error;
    }
    finally { this.transitioning = false; }
  }
  async setModel(model: string): Promise<ExecuteResult> {
    await this.settings({ model }); this.model = model;
    return { success: true, output: `AGY model confirmed: ${model}.` };
  }
  /** AGY-specific control; no shared backend mode semantics are changed. */
  async setMode(mode: string): Promise<ExecuteResult> {
    await this.settings({ mode });
    return { success: true, output: `AGY mode confirmed: ${mode}.` };
  }
  async clearModel(): Promise<void> { await this.settings({ resetModel: true }); this.model = undefined; }
  async setEffort(effort: string): Promise<ExecuteResult> {
    const value = effort.trim().toLowerCase();
    if (value !== 'auto' && !SUPPORTED_EFFORTS.includes(value as typeof SUPPORTED_EFFORTS[number])) return { success: false, error: 'Supported AGY efforts: auto, low, medium, high.' };
    await this.settings(value === 'auto' ? { resetEffort: true } : { effort: value });
    this.effort = value === 'auto' ? undefined : value;
    return { success: true, output: `AGY effort confirmed: ${value}.` };
  }
  async withNativeScheduleOperation<T>(id: string, current: () => boolean, run: () => Promise<T>, inTurn: boolean): Promise<T> {
    if (this.transitioning || this.shutdownUncertain) throw new Error('AGY context transition is pending.');
    return (await this.runtime(true)).withOperation(id, current, run, inTurn);
  }
  nativeScheduleAction(id: string) { return this.acp?.action(id); }
  async getAccountUsage(): Promise<string | null> {
    let env: NodeJS.ProcessEnv;
    try {
      env = this.buildEnv();
    } catch (error) {
      console.warn('[AgyExecutor] Account usage environment is unavailable:', error);
      return null;
    }

    const [usage, credits] = await Promise.all([
      this.runInformationalCommand('/usage', env),
      this.runInformationalCommand('/credits', env),
    ]);
    const sections = [
      usage ? `Model quota:\n${usage}` : null,
      credits ? `Credits:\n${credits}` : null,
    ].filter((section): section is string => section !== null);
    return sections.length > 0 ? sections.join('\n\n') : null;
  }

  private runInformationalCommand(
    command: '/usage' | '/credits',
    env: NodeJS.ProcessEnv,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(this.agyCommand, ['-p', command], {
        cwd: this.currentWorkingDirectory,
        env,
        encoding: 'utf8',
        timeout: ACCOUNT_USAGE_TIMEOUT_MS,
        maxBuffer: ACCOUNT_USAGE_MAX_BUFFER,
      }, (error, stdout) => {
        if (error) {
          console.warn(`[AgyExecutor] ${command} is unavailable: ${error.message}`);
          resolve(null);
          return;
        }
        resolve(stripAnsi(stdout).trim() || null);
      });
    });
  }

  async listModels(): Promise<ExecutorModelInfo[]> {
    return new Promise((resolve, reject) => {
      execFile(
        this.agyCommand,
        ['models'],
        { timeout: 10_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(new Error(`Failed to list AGY models: ${error.message}`));
            return;
          }
          try {
            const models = parseAgyModels(stdout, this.model);
            if (!models.length) {
              throw new Error('AGY returned no usable model entries. Refresh and check the installed AGY version.');
            }
            resolve(models);
          } catch (parseError) {
            reject(parseError);
          }
        }
      );
    });
  }

  async listEfforts(): Promise<ExecutorEffortInfo> {
    return {
      choices: SUPPORTED_EFFORTS.map((effort) => ({
        value: effort,
        displayName: effort,
      })),
      current: this.effort,
      default: undefined,
      supportsReset: true,
    };
  }

  async compactWhenFull(onStream?: (chunk: string) => void): Promise<ExecuteResult> {
    this.assertNoRetainedSchedules();
    if (this.acpLeaseUnconfirmed && !this.acp) throw new Error('Saved AGY ACP chat cannot safely resume or compact. Use explicit /clear to select a fresh conversation when no schedule owner remains; original history is retained.');
    if (!this.acp && !this.conversationId) {
      return { success: true, output: 'No active conversation to compact.' };
    }

    onStream?.('Summarizing the conversation before resetting...\n');
    let summary: string | null = null;
    try {
      const r = await this.execute(COMPACT_HANDOFF_PROMPT, onStream ? { onStream } : {});
      if (r.success && r.output?.trim()) summary = r.output.trim();
    } catch (error) {
      console.warn('[AgyExecutor] Handoff summary failed, falling back to plain reset:', error);
    }

    await this.resetContext();
    if (summary) {
      this.pendingContextSeed = summary;
      return {
        success: true,
        output: '✅ Context compacted: the conversation was summarized and carried over to a fresh session.',
      };
    }
    return {
      success: true,
      output: '⚠️ Handoff summary failed — the conversation was reset without carryover. Context starts fresh.',
    };
  }

  async deleteThreadData(_threadId: string): Promise<void> {
    if (fs.existsSync(this.sessionFilePath + '.detached-acp')) throw new Error('Detached AGY history has unconfirmed predecessor ownership; data erasure is refused.');
    this.assertScheduleResettable(true); await this.destroy(); this.assertScheduleResettable();
    if (this.delegationWorker) return;
    fs.rmSync(this.sessionFilePath, { force: true }); this.conversationId = null;
    if (this.scheduleOwner?.retired) { fs.rmSync(this.sessionFilePath + '.native-schedules', { force: true }); this.scheduleOwner = undefined; }
    if (this.agyHome) fs.rmSync(this.agyHome, { recursive: true, force: true });
  }
}

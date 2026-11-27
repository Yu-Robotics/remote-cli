import { AgyManualResumeScheduleSkip } from '../scheduling/types';
import { AgyAcpRuntime } from './agy/AgyAcpRuntime';
import { agyHostScheduleHistory, agyOwnershipReview, agySavedSelectionDeletion, assertAgySelectionResettable, detachAgySelection } from './agy/AgySessionSelection';
import { createHash, randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import type { AgyCommandCheckpoint } from './agy/AgyCommandTasks';
import { isAgyVerifiedHistory, type AgyVerifiedHistory } from './agy/AgyRecoveredHistory';
import { kernelGate, syncDirectory } from '../delegation/OwnershipRuntime';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectoryGuard } from '../security/DirectoryGuard';
import type { AgyHumanConfirmation, IExecutor, ExecuteOptions, ExecuteResult, ExecutorModelInfo, ExecutorEffortInfo } from './IExecutor';
import { FEISHU_MESSAGE_CLOCK_SKEW_MS, FEISHU_MESSAGE_MAX_AGE_MS, type ApprovalAction } from '../types';
import { configuredExecutionMetadata } from './ExecutionMetadata';
import { COMPACT_HANDOFF_PROMPT, seedPromptWithHandoff } from './compactHandoff';
import { stripAnsi } from '../utils/stripAnsi';
import { delegationSessionServers, delegationEnvironment, sameConnection, type DelegationConnection } from '../delegation/contract';
import { parseAgyModels } from './agy/AgyModels';
import { isWorkerLaneExecutorId } from '../delegation/DelegatedWorkerSessionStore';
import type { AgyDeletionTarget } from '../delegation/AgySessionDeletion';
import type { NativeDirectoryIdentity } from '../delegation/NativeSessionDeletion';

export interface AgyExecutorOptions {
  model?: string;
  effort?: string;
  autoApprove?: boolean;
  forceFileTokenStorage?: boolean;
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
const AGY_FILE_TOKEN = 'antigravity-oauth-token';
const AGY_CLI_SHARED_FILES = ['settings.json', 'installation_id'];
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

/** Verified recovered history supersedes older policies, which cannot revalidate its prefix. */
function hostCheckpointPolicy(idleHistory?: string, digest?: string, verified?: AgyVerifiedHistory): string {
  return verified !== undefined ? 'host-timed-chat-v4' : idleHistory !== undefined ? 'host-timed-chat-v3'
    : digest !== undefined ? 'host-timed-chat-v2' : 'host-timed-chat-v1';
}

export function agyTokenStorageEnv(forceFileTokenStorage?: boolean): Record<string, string> {
  return forceFileTokenStorage === true ? { AGY_CLI_FORCE_FILE_TOKEN_STORAGE: 'true' } : {};
}

/** ACP is the sole conversation transport. Legacy metadata remains readable only
 * for explicit selection reset and exact history cleanup. */
export class AgyExecutor implements IExecutor {
  private currentWorkingDirectory: string;
  private model?: string;
  private effort?: string;
  private readonly autoApprove: boolean;
  private readonly tokenStorageEnv: Record<string, string>;
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
  private pendingDelegationConnection?: { connection?: DelegationConnection };
  private nativeObserver?: (target: AgyDeletionTarget) => Promise<void>;
  private nativeCaptureFailure?: () => Promise<void>;
  private nativeCaptureUnconfirmed = false;
  private workerProof?: { sessionId: string; policy: string; settled: boolean; closed: boolean };
  private scheduleOwner?: { sessionId: string; hostId: string; retired: boolean };
  private resumeCurrent = false;
  private allocationUnconfirmed = false;
  private hostGeneration?: string;
  private ownedPointer?: fs.BigIntStats;
  private awaitingManualRecovery = false;
  private retiringSelection = false;
  private unpromptedReconnect?: { sessionId: string; generation: string; history: string };

  constructor(private readonly directoryGuard: DirectoryGuard, options: AgyExecutorOptions = {}) {
    this.model = options.model; this.effort = options.effort;
    this.autoApprove = options.autoApprove ?? true; this.agyCommand = options.agyCommand ?? 'agy';
    this.tokenStorageEnv = agyTokenStorageEnv(options.forceFileTokenStorage);
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
    if (file === this.sessionFilePath) this.ownedPointer = fs.lstatSync(file, { bigint: true });
  }
  private hostSelection(id: string) {
    assertAgySelectionResettable(this.sessionFilePath);
    const stat = fs.lstatSync(this.sessionFilePath);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error('Unsafe AGY selection.');
    const pointer = JSON.parse(fs.readFileSync(this.sessionFilePath, 'utf8'));
    if (pointer.id !== id || pointer.transport !== 'acp') throw new Error('The original AGY conversation changed.');
    return pointer;
  }
  private checkpointConfiguration(errors?: { id: string; generation: string; history: string; commands?: AgyCommandCheckpoint; digest?: string; verified?: AgyVerifiedHistory }): string {
    return createHash('sha256').update(JSON.stringify([this.threadId, this.agyHome, this.currentWorkingDirectory,
      this.agyCommand, this.model, this.effort, this.autoApprove, ...(errors ? [errors] : [])])).digest('hex');
  }
  private cleanHostSelection(id: string) {
    const pointer = this.hostSelection(id);
    const checkpoint = pointer.hostScheduleCheckpoint;
    const digest = checkpoint?.toolErrorDigest;
    const idleHistory = checkpoint?.commands?.idleDenialHistory;
    const verified = checkpoint?.verifiedHistory;
    const bound = digest !== undefined || idleHistory !== undefined || verified !== undefined;
    const policy = hostCheckpointPolicy(idleHistory, digest, verified);
    if (!this.agyHome || !checkpoint || checkpoint.policy !== policy
      || [digest, idleHistory].some(hash => hash !== undefined && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))
      || verified !== undefined && !isAgyVerifiedHistory(verified)
      || typeof pointer.hostGeneration !== 'string' || checkpoint.generation !== pointer.hostGeneration
      || checkpoint.configuration !== this.checkpointConfiguration(bound ? { id, generation: checkpoint.generation,
        history: checkpoint.history, commands: checkpoint.commands, digest, verified } : undefined)
      || checkpoint.history !== agyHostScheduleHistory(this.agyHome, id)) {
      throw new Error('Saved AGY ACP chat cannot safely resume: the clean host-timed checkpoint is missing or changed.');
    }
    return pointer;
  }
  checkHostScheduleSession(id: string): void {
    this.assertHostScheduleOwner(id);
    const pointer = this.hostSelection(id);
    const mainGeneration = this.threadId && this.agyHome && pointer.retired === false
      && typeof pointer.hostGeneration === 'string' && (!this.hostGeneration || this.hostGeneration === pointer.hostGeneration)
      && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(pointer.hostGeneration);
    if (Object.hasOwn(pointer, 'manualResumeConsumedGeneration')) {
      if (mainGeneration && this.ownedPointerCurrent() && pointer.manualResumeConsumedGeneration === pointer.hostGeneration
        && !Object.hasOwn(pointer, 'hostScheduleCheckpoint')
        && (!this.acp || this.acp.sessionId === id)) {
        if (this.acp?.canScheduleAfterManualResume && pointer.hostGeneration === this.hostGeneration) return;
        throw new AgyManualResumeScheduleSkip('consumed');
      }
      throw new Error('AGY recovery selection changed.');
    }
    if ((!this.acp || this.acp.exitedBetweenTurns) && mainGeneration && (this.acpLeaseUnconfirmed || this.awaitingManualRecovery)
      && this.ownedPointerCurrent() && !Object.hasOwn(pointer, 'hostScheduleCheckpoint')) {
      throw new AgyManualResumeScheduleSkip('required');
    }
    if (!this.acp) {
      if (this.cleanHostSelection(id).hostScheduleCheckpoint.commands?.idleDenialHistory) {
        throw new Error('AGY idle denial checkpoint permits ordinary chat only.');
      }
      return;
    }
    if (!this.acp.hostScheduleAvailable || this.acp.sessionId !== id || !this.hostGeneration
      || pointer.hostGeneration !== this.hostGeneration) {
      throw new Error('AGY host timing requires a verified foreground conversation with no uncertain native work.');
    }
  }
  private ownedPointerCurrent(): boolean {
    if (!this.ownedPointer) return true;
    const stat = fs.lstatSync(this.sessionFilePath, { bigint: true });
    return stat.isFile() && stat.nlink === 1n && stat.size <= 65536n
      && stat.dev === this.ownedPointer.dev && stat.ino === this.ownedPointer.ino
      && stat.ctimeNs === this.ownedPointer.ctimeNs;
  }
  private applyPendingDelegationConnection(): void {
    if (!this.pendingDelegationConnection) return;
    this.delegationConnection = this.pendingDelegationConnection.connection;
    this.pendingDelegationConnection = undefined;
  }
  private assertHostScheduleOwner(id: string, allowTransitioning = false): void {
    if (!id || id !== this.conversationId || this.isDestroyed || this.shutdownUncertain || (!allowTransitioning && this.transitioning)
      || this.delegationWorker || this.legacy || this.allocationUnconfirmed || this.scheduleOwner) {
      throw new Error('The original AGY scheduled conversation is unavailable.');
    }
  }
  isHostScheduleWaitingForCommand(sessionId: string, cwd: string): boolean {
    try {
      this.assertHostScheduleOwner(sessionId);
      return this.currentWorkingDirectory === cwd && this.acp?.waitingForCommand === true
        && this.acp.sessionId === sessionId && !!this.hostGeneration
        && this.hostSelection(sessionId).hostGeneration === this.hostGeneration;
    } catch { return false; }
  }
  private saveWorkerProof(): void {
    if (this.workerProof) this.writeNativeState(this.sessionFilePath + '.worker-policy', this.workerProof);
  }
  private assertNoRetainedSchedules(): void {
    if (this.acp?.hasJobs || this.scheduleOwner) throw new Error('AGY native notifications remain owned and unconfirmed. Settings and transport changes are unavailable; inspect /schedule list.');
  }
  private assertScheduleResettable(allowOwnedRetirement = false, detachSelection = false): void {
    if (this.allocationUnconfirmed || fs.existsSync(this.sessionFilePath + '.allocation-unconfirmed')) throw new Error(`AGY allocation ownership is unconfirmed. ${agyOwnershipReview}`);
    if (fs.existsSync(this.sessionFilePath + '.checkpoint.lock')) throw new Error('AGY checkpoint transition is unconfirmed. Retry after it finishes. If it stays blocked, ask the device operator to inspect the checkpoint.');
    if (this.acpLeaseUnconfirmed && !this.acp && !detachSelection) {
      if (this.scheduleOwner || fs.existsSync(this.sessionFilePath + '.native-schedules')) throw new Error(`Saved AGY host retirement is unconfirmed and schedule ownership remains. ${agyOwnershipReview}`);
      throw new Error(agySavedSelectionDeletion);
    }
    if (this.scheduleOwner && this.scheduleOwner.sessionId !== this.conversationId) throw new Error(`AGY schedule owner does not match the original conversation. ${agyOwnershipReview}`);
    if (this.scheduleOwner && !this.scheduleOwner.retired && !(allowOwnedRetirement && this.acp?.canRetireForContextReset)) throw new Error(`AGY native notifications have unresolved ownership. ${agyOwnershipReview}`);
  }
  private manualSelection(id: string) {
    const pointer = this.hostSelection(id);
    if (!this.threadId || path.basename(this.threadId) !== this.threadId || isWorkerLaneExecutorId(this.threadId) || this.delegationWorker || this.legacy
      || pointer.retired !== false || Object.hasOwn(pointer, 'hostScheduleCheckpoint')
      || typeof pointer.hostGeneration !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(pointer.hostGeneration)
      || Object.hasOwn(pointer, 'manualResumeConsumedGeneration') && pointer.manualResumeConsumedGeneration !== pointer.hostGeneration
      || fs.lstatSync(this.sessionFilePath + '.worker-policy', { throwIfNoEntry: false })) {
      throw new Error('AGY recovery requires the original checkpoint-less main chat.');
    }
    const configRoot = path.join(fs.realpathSync(os.homedir()), '.remote-cli');
    if (fs.realpathSync(this.sessionFilePath) !== path.join(configRoot, 'agy-sessions', this.threadId + '.json')
      || fs.realpathSync(this.agyHome!) !== path.join(configRoot, 'agy-homes', this.threadId)) {
      throw new Error('The original AGY selection is redirected.');
    }
    const stat = fs.lstatSync(this.sessionFilePath, { bigint: true });
    return { pointer, ino: stat.ino, dev: stat.dev, ctime: stat.ctimeNs };
  }

  private verifyLiveMainSelection(id: string): void {
    const selected = this.manualSelection(id);
    if (selected.pointer.hostGeneration !== this.hostGeneration || selected.dev !== this.ownedPointer?.dev
      || selected.ino !== this.ownedPointer?.ino || selected.ctime !== this.ownedPointer?.ctimeNs) {
      throw new Error('The selected AGY conversation changed before dispatch.');
    }
  }

  private checkConfirmation(source: AgyHumanConfirmation, now = Date.now()): void {
    if (!source || typeof source.current !== 'function' || !source.current() || typeof source.originalMessageId !== 'string'
      || !/^[a-zA-Z0-9_-]{1,200}$/.test(source.originalMessageId) || !Number.isSafeInteger(source.createdAt)
      || source.createdAt <= now - FEISHU_MESSAGE_MAX_AGE_MS || source.createdAt > now + FEISHU_MESSAGE_CLOCK_SKEW_MS) throw new Error('The original Feishu message expired or its route changed.');
  }

  private readRecoveryReceipts(file: string, now: number) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    const receipts: Record<string, number> = {};
    let updatedAt = now;
    if (stat) {
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024) throw new Error('Unsafe AGY message receipt storage.');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || !Number.isSafeInteger(data.updatedAt) || data.updatedAt > now + FEISHU_MESSAGE_CLOCK_SKEW_MS || !data.receipts
        || typeof data.receipts !== 'object' || Array.isArray(data.receipts)) throw new Error('Invalid AGY message receipt storage.');
      updatedAt = Math.max(now, data.updatedAt);
      for (const [key, time] of Object.entries(data.receipts)) {
        if (!/^[a-f0-9]{64}$/.test(key) || typeof time !== 'number' || !Number.isSafeInteger(time)
          || time > data.updatedAt + FEISHU_MESSAGE_CLOCK_SKEW_MS) throw new Error('Invalid AGY confirmation receipt.');
        if (time > updatedAt - FEISHU_MESSAGE_MAX_AGE_MS) receipts[key] = time;
      }
    }
    return { updatedAt, receipts };
  }

  needsAgyHumanRecovery(originalMessageId: string): boolean {
    const file = path.join(fs.realpathSync(os.homedir()), '.remote-cli', 'agy-confirmations.json');
    const key = createHash('sha256').update(originalMessageId).digest('hex');
    if (Object.hasOwn(this.readRecoveryReceipts(file, Date.now()).receipts, key)) throw new Error('This Feishu message already resumed AGY.');
    if (this.acp?.needsHumanContinuation) return true;
    if ((this.acp && !this.acp.exitedBetweenTurns) || this.resumeCurrent || !this.conversationId || this.legacy || this.delegationWorker) return false;
    const pointer = this.hostSelection(this.conversationId);
    return !Object.hasOwn(pointer, 'hostScheduleCheckpoint');
  }

  /** Runs under the thread HOME lease. The device-wide gate also serializes different threads and resets. */
  private consumeConfirmation(source: AgyHumanConfirmation): void {
    const root = path.join(fs.realpathSync(os.homedir()), '.remote-cli');
    if (fs.realpathSync(root) !== root) throw new Error('The AGY confirmation directory is redirected.');
    const file = path.join(root, 'agy-confirmations.json');
    const gate = kernelGate(file + '.gate');
    if (!gate) throw new Error('AGY message receipt storage is busy. Send a new Feishu message.');
    try {
      const now = Date.now();
      this.checkConfirmation(source, now);
      const { updatedAt, receipts } = this.readRecoveryReceipts(file, now);
      if (source.createdAt <= updatedAt - FEISHU_MESSAGE_MAX_AGE_MS) throw new Error('The original Feishu message expired.');
      const key = createHash('sha256').update(source.originalMessageId).digest('hex');
      if (Object.hasOwn(receipts, key)) throw new Error('This Feishu message was already consumed for AGY recovery.');
      if (Object.keys(receipts).length >= 4096) throw new Error('AGY message receipt storage is full. Send a new Feishu message later.');
      receipts[key] = source.createdAt;
      gate.verify();
      this.writeNativeState(file, { updatedAt, receipts });
    } finally { gate.close(); }
  }

  private async runtime(legacyNativeScheduling = false, manual?: { selection: ReturnType<AgyExecutor['manualSelection']>; history: string; source: AgyHumanConfirmation }): Promise<AgyAcpRuntime> {
    if (this.acp) return this.acp;
    this.applyPendingDelegationConnection();
    if (this.allocationUnconfirmed) throw new Error('AGY allocation reply was lost. Native ownership is unconfirmed; do not retry this worker or conversation automatically.');
    if (this.isDestroyed || this.shutdownUncertain) throw new Error('AGY executor is closed or its process exit is unconfirmed.');
    if (!this.threadId || !this.agyHome) throw new Error('AGY ACP requires a thread-scoped HOME. Select a thread before chatting.');
    if (this.legacy) throw new Error(this.delegationWorker
      ? 'Legacy AGY worker history cannot execute over ACP. Use this worker card Clear action or parent /clear after task/artifact closeout; original history is retained.'
      : 'Legacy AGY conversation cannot execute over ACP. Use explicit /clear to start fresh; original native history is retained.');
    let cleanGeneration: string | undefined;
    let savedCheckpoint: { commands?: AgyCommandCheckpoint; toolErrorDigest?: string; verifiedHistory?: AgyVerifiedHistory } | undefined;
    if (this.conversationId) {
      if (this.scheduleOwner) throw new Error('AGY saved chat cannot safely resume: native notifications remain unconfirmed. Use a new thread.');
      const proof = this.workerProof;
      if (!manual && !this.delegationWorker && this.hostSelection(this.conversationId).hostScheduleCheckpoint) {
        const pointer = this.cleanHostSelection(this.conversationId);
        cleanGeneration = pointer.hostGeneration;
        savedCheckpoint = pointer.hostScheduleCheckpoint;
      }
      if (!manual && !cleanGeneration && !this.resumeCurrent && !(this.delegationWorker && proof?.sessionId === this.conversationId
        && proof.policy === 'hook-denial-v2' && proof.settled && proof.closed)) {
        const guidance = this.delegationWorker ? 'Use the worker card Clear action or explicit /clear after task closeout.'
          : 'Send a fresh Feishu message to the original thread from an authenticated device. Use explicit /clear only to start fresh.';
        throw new Error(`Saved AGY ACP chat cannot safely resume: pending work is unconfirmed. ${guidance} Original history is retained.`);
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
    const hostScheduleChat = !this.delegationWorker && (!!manual || !!cleanGeneration || !!firstSetup || !original
      && (!legacyNativeScheduling || this.delegationConnection?.groups?.includes('scheduling') === true));
    let priorHostHistories: Set<string> | undefined;
    // A controlled reconnect is single-use; a failed load cannot authorize retries.
    this.resumeCurrent = false;
    this.unpromptedReconnect = undefined;
    if (this.workerProof) { this.workerProof.closed = false; this.saveWorkerProof(); }
    let firstManualPrompt = !!manual;
    this.acp = new AgyAcpRuntime({ command: this.agyCommand, home: this.agyHome, cwd: this.currentWorkingDirectory,
      threadId: this.threadId, env, model: this.model, effort: this.effort, autoApprove: this.autoApprove,
      sessionId: original ?? undefined, worker: this.delegationWorker,
      managedCoordinator: !!this.delegationConnection && this.delegationConnection.groups?.includes('delegation') !== false,
      hostScheduleChat, commandCheckpoint: savedCheckpoint?.commands, toolErrorDigest: savedCheckpoint?.toolErrorDigest,
      verifiedHistory: savedCheckpoint?.verifiedHistory,
      validatedChatLoad: !!cleanGeneration,
      consumeManualConfirmation: manual ? () => this.consumeConfirmation(manual.source) : undefined,
      beforeManualLoad: manual && original ? () => {
        this.checkConfirmation(manual.source);
        const selection = this.manualSelection(original);
        if (!isDeepStrictEqual(selection, manual.selection) || agyHostScheduleHistory(this.agyHome!, original) !== manual.history) {
          throw new Error('The selected AGY conversation changed before manual load.');
        }
        // Claim this generation under the hook lease. Another waiting confirmation cannot reuse it.
        this.hostGeneration = randomUUID();
        this.writeNativeState(this.sessionFilePath, { ...selection.pointer, hostGeneration: this.hostGeneration,
          manualResumeConsumedGeneration: this.hostGeneration });
        this.acpLeaseUnconfirmed = true;
        this.awaitingManualRecovery = false;
      } : undefined,
      beforeSessionLoad: original && (cleanGeneration || firstSetup) ? () => {
        const pointer = firstSetup ? this.hostSelection(original) : this.cleanHostSelection(original);
        if (pointer.hostGeneration !== (firstSetup?.generation ?? cleanGeneration)
          || cleanGeneration && !isDeepStrictEqual(pointer.hostScheduleCheckpoint, savedCheckpoint)
          || firstSetup && firstSetup.history !== agyHostScheduleHistory(this.agyHome!, original, true)) {
          throw new Error('AGY host-timed checkpoint was replaced.');
        }
        delete pointer.hostScheduleCheckpoint;
        this.hostGeneration = randomUUID();
        this.writeNativeState(this.sessionFilePath, { ...pointer, hostGeneration: this.hostGeneration });
        this.acpLeaseUnconfirmed = true;
        this.awaitingManualRecovery = false;
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
        this.conversationId = id; this.acpLeaseUnconfirmed = true; this.awaitingManualRecovery = false;
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
      beforePrompt: () => {
        if (manual && original) {
          if (firstManualPrompt) {
            this.checkConfirmation(manual.source);
            firstManualPrompt = false;
            manual.source.current = () => false;
          }
          this.verifyLiveMainSelection(original);
        }
        if (this.workerProof) { this.workerProof.settled = false; this.saveWorkerProof(); }
      },
      settledPrompt: reusable => { if (this.workerProof) { this.workerProof.settled = reusable; this.saveWorkerProof(); } },
      ownedSessionClosed: (id, cleanHistory, unpromptedHistory, commands, toolErrorDigest, verifiedHistory) => {
        if (id === this.conversationId) this.acpLeaseUnconfirmed = false;
        // The deletion path rechecks the installed pointer after exit. Writing
        // a checkpoint here could replace an intervening selection.
        if (this.retiringSelection) return;
        if (this.workerProof?.sessionId === id) { this.workerProof.closed = true; this.saveWorkerProof(); }
        if ((cleanHistory || unpromptedHistory) && this.hostGeneration && id === this.conversationId) {
          const pointer = this.hostSelection(id);
          if (pointer.hostGeneration !== this.hostGeneration) throw new Error('AGY host-timed selection changed before retirement.');
          if (cleanHistory) {
            delete pointer.manualResumeConsumedGeneration;
            this.writeNativeState(this.sessionFilePath, { ...pointer, hostScheduleCheckpoint: {
              policy: hostCheckpointPolicy(commands?.idleDenialHistory, toolErrorDigest, verifiedHistory), generation: this.hostGeneration,
              configuration: this.checkpointConfiguration(toolErrorDigest || commands?.idleDenialHistory || verifiedHistory ? { id, generation: this.hostGeneration,
                history: cleanHistory, commands, digest: toolErrorDigest, verified: verifiedHistory } : undefined),
              history: cleanHistory, commands, toolErrorDigest, verifiedHistory,
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
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.tokenStorageEnv, ...delegationEnv };
    if (this.agyHome) {
      this.ensureThreadHome();
      env.HOME = this.agyHome;
      if (this.delegationWorker && process.platform === 'win32') env.USERPROFILE = this.agyHome;
    }
    return env;
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
    this.linkFileToken(this.agyHome!);
    for (const name of AGY_CLI_SHARED_FILES) this.linkShared(realCli, threadCli, name, 'file');
    for (const name of AGY_CLI_SHARED_DIRS) {
      if (this.delegationWorker && name === 'cache') {
        // Never replace a legacy shared link. Such lanes cannot receive deletion receipts.
        if (!fs.existsSync(path.join(threadCli, name))) fs.mkdirSync(path.join(threadCli, name));
      } else this.linkShared(realCli, threadCli, name, 'dir');
    }
  }

  /** Catalog previews repair only the selected thread's native file-login link. */
  private linkFileToken(home: string): void {
    const masterCli = path.join(os.homedir(), '.gemini', 'antigravity-cli');
    if (!fs.statSync(path.join(masterCli, AGY_FILE_TOKEN), { throwIfNoEntry: false })?.isFile()) return;
    const threadCli = path.join(home, '.gemini', 'antigravity-cli');
    const homes = path.join(fs.realpathSync.native(os.homedir()), '.remote-cli', 'agy-homes');
    const expected = path.join(homes, path.basename(home), '.gemini', 'antigravity-cli');
    if (path.relative(expected, fs.realpathSync.native(threadCli)) !== '') {
      throw new Error('Cannot share AGY authentication through a redirected thread HOME.');
    }
    const link = path.join(threadCli, AGY_FILE_TOKEN);
    if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()
      && !fs.statSync(link, { throwIfNoEntry: false })) {
      this.repairRelocatedFileToken(link, path.join(masterCli, AGY_FILE_TOKEN), home, expected);
    }
    this.linkShared(masterCli, threadCli, AGY_FILE_TOKEN, 'file');
  }

  private repairRelocatedFileToken(link: string, master: string, home: string, expectedDirectory: string): void {
    // Serialize repairs by catalog helpers and ACP startup, including other processes.
    const gate = kernelGate(path.join(home, '.remote-cli-agy-file-login.gate'));
    if (!gate) throw new Error('AGY file login is being restored. Retry the model query.');
    try {
      const entry = fs.lstatSync(link, { bigint: true, throwIfNoEntry: false });
      if (!entry?.isSymbolicLink() || fs.statSync(link, { throwIfNoEntry: false })) return;
      const target = fs.readlinkSync(link);
      const store = path.join('.gemini', 'antigravity-cli', AGY_FILE_TOKEN);
      const oldHome = path.dirname(path.dirname(path.dirname(target)));
      if (!path.isAbsolute(target) || target !== path.join(oldHome, store)
        || path.relative(path.join(fs.realpathSync.native(os.homedir()), store), fs.realpathSync.native(master)) !== '') {
        throw new Error('The broken AGY login link does not identify the original file store.');
      }
      const replacement = path.join(path.dirname(link), '.remote-cli-login-' + randomUUID());
      fs.symlinkSync(master, replacement, 'file');
      try {
        gate.verify();
        if (path.relative(expectedDirectory, fs.realpathSync.native(path.dirname(link))) !== '') {
          throw new Error('Cannot share AGY authentication through a redirected thread HOME.');
        }
        const current = fs.lstatSync(link, { bigint: true, throwIfNoEntry: false });
        if (!current?.isSymbolicLink() || current.ino !== entry.ino || current.dev !== entry.dev
          || fs.readlinkSync(link) !== target || fs.statSync(link, { throwIfNoEntry: false })) return;
        fs.renameSync(replacement, link);
      } finally {
        if (fs.lstatSync(replacement, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(replacement);
      }
    } finally { gate.close(); }
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
      if (name === 'oauth_creds.json' || name === 'google_accounts.json' || name === AGY_FILE_TOKEN) {
        console.warn(`[AgyExecutor] Thread-local ${name} replaced its shared link; leaving both copies untouched.`);
      }
      return;
    }
    try { fs.symlinkSync(master, link, type); }
    catch (error) {
      // Another catalog query or ACP startup can establish the same link first.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !fs.existsSync(link)) throw error;
    }
  }

  getCurrentWorkingDirectory(): string { return this.currentWorkingDirectory; }
  getSessionId(): string | null { return this.conversationId; }
  getExecutionMetadata() { return configuredExecutionMetadata(this.model, this.effort); }
  isProcessRunning(): boolean { return !!this.acp?.running; }
  isBusy(): boolean { return this.isProcessing || this.transitioning || this.shutdownUncertain || !!this.acp?.busy; }
  hasUncertainShutdown(): boolean { return this.shutdownUncertain; }
  isWaitingInput(): boolean { return this.acp?.isWaitingInput() ?? false; }
  requiresAuthenticatedInput(): boolean { return this.acp?.requiresAuthenticatedInput ?? false; }
  cancelRecoveredInput(): void { this.acp?.cancelRecoveredInput(); }
  hasDeferredManagedTools(): boolean { return this.pendingDelegationConnection !== undefined; }
  sendInput(input: string, confirmation?: AgyHumanConfirmation): boolean { return this.acp?.sendInput(input, confirmation) ?? false; }
  respondToApproval(id: string, action: ApprovalAction): boolean { return this.acp?.respondToApproval(id, action) ?? false; }
  preservesProcessOnAbort(): boolean { return true; }
  hasPendingCancellation(): boolean { return !!this.acp?.hasJobs && !!this.acp.blocked; }
  hasPendingScheduleMutation(): boolean { return this.acp?.cleanupMutationPending ?? false; }
  // Shared destructive-settings recovery is not an AGY capability. Busy
  // transitions are already enforced by isBusy/resetContext and must not bypass
  // the caller's schedule-idle guard.
  hasPendingSettingsChange(): boolean { return false; }
  async resumeAgyChat(message: string, options: ExecuteOptions, confirmation: AgyHumanConfirmation): Promise<ExecuteResult> {
    // Copy options before awaiting startup so the confirmation cannot be redirected.
    const turn = { ...options, inactivityTimeout: options.inactivityTimeout ?? this.inactivityTimeoutMs };
    if (!message.trim() || turn.hostScheduleSessionId !== undefined || turn.resolvePrompt || turn.attachments?.length
      || this.pendingContextSeed || this.isBusy() || !this.conversationId || this.resumeCurrent) {
      throw new Error('AGY recovery requires one fresh human text message on the original idle chat.');
    }
    const id = this.conversationId;
    this.assertHostScheduleOwner(id);
    const source = { ...confirmation };
    this.checkConfirmation(source);
    const currentRoute = source.current;
    const questionRouteCurrent = source.routeCurrent ?? currentRoute;
    const questionRouteKey = source.routeKey;
    const onAdmitted = turn.onAgyHumanPromptAdmitted;
    if (onAdmitted) {
      turn.onAgyHumanPromptAdmitted = current => onAdmitted(() => current() && questionRouteCurrent());
    }
    let questionRuntime: AgyAcpRuntime | undefined;
    const checkAnswer = (answer: AgyHumanConfirmation) => {
      if (!questionRouteCurrent() || !questionRouteKey || answer.routeKey !== questionRouteKey) {
        throw new Error('The AGY recovery question route changed.');
      }
      this.assertHostScheduleOwner(id, true);
      if (questionRuntime !== this.acp) throw new Error('The AGY host changed before receiving the answer.');
      this.verifyLiveMainSelection(id);
      this.checkConfirmation(answer);
    };
    const questionAuth = {
      routeCurrent: () => questionRouteCurrent() && !this.isDestroyed && !this.shutdownUncertain
        && this.conversationId === id && questionRuntime === this.acp,
      check: checkAnswer,
      consume: (answer: AgyHumanConfirmation) => {
        checkAnswer(answer);
        this.consumeConfirmation(answer);
      },
    };
    if (this.acp && !this.acp.exitedBetweenTurns) {
      const runtime = this.acp;
      questionRuntime = runtime;
      if (!runtime.needsHumanContinuation || runtime.sessionId !== id) throw new Error('The AGY host has no settled human continuation.');
      this.isProcessing = true;
      try {
        return await runtime.execute(message, turn, () => {
          this.assertHostScheduleOwner(id);
          if (runtime !== this.acp) throw new Error('The live AGY host changed before dispatch.');
          this.verifyLiveMainSelection(id);
          this.consumeConfirmation(source);
        }, questionAuth);
      } finally { this.isProcessing = false; }
    }
    const selection = this.manualSelection(id);
    this.transitioning = true;
    try {
      const history = agyHostScheduleHistory(this.agyHome!, id);
      if (this.acp) {
        if (this.acp.sessionId !== id || selection.pointer.hostGeneration !== this.hostGeneration
          || selection.dev !== this.ownedPointer?.dev || selection.ino !== this.ownedPointer?.ino
          || selection.ctime !== this.ownedPointer?.ctimeNs) throw new Error('The exited AGY host no longer owns this selection.');
        // Keep this runtime attached until both the exact group join and hook restoration succeed.
        await this.acp.close();
        if (!isDeepStrictEqual(this.manualSelection(id), selection)) throw new Error('The selected AGY conversation changed during retirement.');
        this.acp = undefined;
        this.awaitingManualRecovery = true;
        this.applyPendingDelegationConnection();
        this.checkConfirmation(source);
      }
      const runtime = await this.runtime(false, { selection, history, source });
      questionRuntime = runtime;
      let completed = false;
      try {
        const result = await runtime.execute(message, { ...turn, attachments: undefined }, undefined, questionAuth);
        completed = result.success;
        return result;
      } finally {
        if (!completed) {
          await this.stopForContextReset();
          this.acp = undefined;
        }
      }
    } finally { this.transitioning = false; }
  }
  async execute(prompt: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    if (this.isBusy() || this.isDestroyed) throw new Error('AGY executor is busy or destroyed.');
    const pinned = options.hostScheduleSessionId;
    if (pinned !== undefined) this.checkHostScheduleSession(pinned);
    if (this.acp?.exitedBetweenTurns) throw new Error('AGY exited between turns. Send a fresh Feishu message to resume the original conversation.');
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
    if (sameConnection(this.delegationConnection, connection)) {
      this.pendingDelegationConnection = undefined;
      return;
    }
    if (this.isBusy()) throw new Error('AGY work or native notifications are busy.');
    this.assertNoRetainedSchedules();
    if (this.acp && !this.acp.reusable) {
      if (this.acp.exitedBetweenTurns || this.acp.needsHumanContinuation) {
        this.pendingDelegationConnection = { connection };
        return;
      }
      throw new Error('AGY chat outcome is unconfirmed; reconnect was refused.');
    }
    this.transitioning = true;
    try {
      if (this.acp) {
        await this.acp.close();
        this.acp = undefined;
        this.resumeCurrent = true;
        this.awaitingManualRecovery = true;
      }
      this.delegationConnection = connection;
      this.pendingDelegationConnection = undefined;
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
      this.applyPendingDelegationConnection();
      if (this.acpLeaseUnconfirmed && !this.legacy) {
        if (!detachAgySelection(this.sessionFilePath)) throw new Error('AGY selection changed; clear was refused.');
      } else fs.rmSync(this.sessionFilePath, { force: true });
      this.conversationId = null; this.legacy = false; this.acpLeaseUnconfirmed = false; this.awaitingManualRecovery = false; this.resumeCurrent = false;
      this.hostGeneration = undefined;
      this.ownedPointer = undefined;
      this.unpromptedReconnect = undefined;
      this.pendingContextSeed = null; this.workerProof = undefined;
      fs.rmSync(this.sessionFilePath + '.worker-policy', { force: true });
      if (this.scheduleOwner?.retired) { fs.rmSync(this.sessionFilePath + '.native-schedules', { force: true }); this.scheduleOwner = undefined; }
    } finally { this.transitioning = false; }
  }
  async stopForContextReset(): Promise<void> {
    if (!this.acp) return;
    // Keep admission fenced until close joins the original runtime's process group.
    this.shutdownUncertain = true;
    try { await this.acp.close(); }
    catch (cause) {
      if (this.delegationWorker) throw cause;
      throw new Error('AGY host retirement is unconfirmed. To reset this conversation, retry /clear in the original thread once the host can exit. Its native history is retained.', { cause });
    }
    this.shutdownUncertain = false;
  }
  async abort(): Promise<boolean> { return await this.acp?.abort() ?? false; }
  abortStatusMessage(): string {
    return this.acp?.hasJobs ? 'AGY foreground interrupted; native timers may still queue reminders and dispatch is blocked. Inspect /schedule list. No work is replayed.'
      : 'AGY foreground cancelled. Completed tool side effects remain; unconfirmed outcomes stay blocked.';
  }
  async destroy(): Promise<void> {
    this.isDestroyed = true;
    await this.stopForContextReset();
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

  async listModels(context?: { threadId: string }): Promise<ExecutorModelInfo[]> {
    // An existing thread may have its own provider settings. Before its first
    // launch (including metadata previews), query the shared account directly.
    if (context && !/^[a-zA-Z0-9_-]{1,128}$/.test(context.threadId)) throw new Error('Invalid AGY catalog thread ID.');
    const home = context ? path.join(os.homedir(), '.remote-cli', 'agy-homes', context.threadId) : this.agyHome;
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.tokenStorageEnv };
    if (home && fs.existsSync(path.join(home, '.gemini', 'antigravity-cli'))) {
      this.linkFileToken(home);
      env.HOME = home;
      env.USERPROFILE = home;
    }
    return new Promise((resolve, reject) => {
      execFile(
        this.agyCommand,
        ['models'],
        { cwd: this.currentWorkingDirectory, env, timeout: 10_000, maxBuffer: 1024 * 1024 },
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

  canRetireAgySelection(threadId: string): boolean {
    if (this.delegationWorker || threadId !== this.threadId) throw new Error('AGY deletion requires the original main thread.');
    this.assertScheduleResettable(true);
    if (this.isBusy() || this.acp && !this.acp.canRetireForContextReset) throw new Error('AGY native work is still active.');
    if (!this.acp || !this.conversationId || this.legacy) return false;
    if (this.acp.sessionId !== this.conversationId) throw new Error('AGY session ownership changed before deletion.');
    const stat = fs.lstatSync(this.sessionFilePath, { bigint: true });
    if (!this.ownedPointer || stat.dev !== this.ownedPointer.dev || stat.ino !== this.ownedPointer.ino
      || stat.ctimeNs !== this.ownedPointer.ctimeNs || !stat.isFile() || stat.nlink !== 1n || stat.size > 65536n) {
      throw new Error('The selected AGY conversation changed before deletion.');
    }
    const pointer = JSON.parse(fs.readFileSync(this.sessionFilePath, 'utf8'));
    if (pointer.transport !== 'acp' || pointer.id !== this.conversationId || pointer.hostGeneration !== this.hostGeneration) {
      throw new Error('The selected AGY conversation changed before deletion.');
    }
    return true;
  }

  async retireAgySelection(threadId: string): Promise<void> {
    const owned = this.canRetireAgySelection(threadId);
    this.retiringSelection = true;
    try { await this.destroy(); } finally { this.retiringSelection = false; }
    this.assertScheduleResettable();
    if (owned) {
      if (this.acpLeaseUnconfirmed || !this.canRetireAgySelection(threadId)) throw new Error('AGY session retirement is unconfirmed.');
      fs.unlinkSync(this.sessionFilePath);
      syncDirectory(path.dirname(this.sessionFilePath));
      this.conversationId = null;
    }
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

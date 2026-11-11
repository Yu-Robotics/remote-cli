import { parseAttachmentHints } from './output/Protocol';
import { InlineFileCards, type HintStatus, type InlineIdentity, type InlineOwner } from './output/InlineFileCards';
import { OutputTransfers } from './output/OutputTransfers';
import { deliveryEvent, safeCardError, taskCorrelation } from './utils/DeliveryDiagnostics';
import { IngressAdmission, IngressLimitError, INGRESS_LIMITS, PendingFrameBudget } from './security/IngressAdmission';
import { ApprovalCards } from './feishu/ApprovalCards';
import { WorkerContextCards } from './feishu/WorkerContextCards';
import { SettingsCards } from './feishu/SettingsCards';
import { MaintenanceCards } from './maintenance/MaintenanceCards';
import { NoticeReceipts } from './maintenance/NoticeReceipts';
import { TipService } from './tips/TipService';
import { TIPS } from './tips/TipCatalog';
import { TipImages } from './tips/TipImages';
import { DeviceAuth } from './files/DeviceAuth';
import { AutomaticFileEnrollment, type EnrollmentAuthority } from './files/AutomaticFileEnrollment';
import { FileTransfers } from './files/FileTransfers';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { ImageLifecycle, IMAGE_LIMITS, type ImageReply } from './utils/ImageLifecycle';
import type { ApprovalAction } from './types';
import type { ExecutionMetadata, ActivityProgressInfo } from './types';
import { parseActivityProgress } from './utils/ActivityProgress';
import { parseExecutionMetadata } from './utils/ExecutionMetadata';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import Router from '@koa/router';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { ConfigManager } from './config/ConfigManager';
import { JsonStore } from './storage/JsonStore';
import { CARD_THREAD_TTL_MS, type CardThreadAssociation } from './storage/CardThreadState';
import { FeishuLongConnHandler } from './feishu/FeishuLongConnHandler';
import { ConnectionHub } from './websocket/ConnectionHub';
import { BindingManager } from './binding/BindingManager';
import { ThreadSelectionManager, isCompleteThreadCatalog, type SelectionFence } from './binding/ThreadSelectionManager';
import { MessageType, ToolUseInfo, ToolResultInfo, DelegationProgressInfo, PROTOCOL_VERSION, MIN_SUPPORTED_CLI_VERSION, ROUTER_VERSION, ThreadSummary, QueueConfirmationInfo, QueueStartedInfo, TaskResumeInfo, ImageBlock } from './types';
import { DELEGATION_PROGRESS_ELEMENT_COUNT, DELEGATION_RESULT_SUMMARY_LIMIT, DelegationProgressCardState, FeishuCardElement, type ToolCallCardState, createToolCallSummary, createToolCallElement, createDelegationProgressElements, createDividerElement, createToolUseElement, createToolResultElement, createMarkdownElement, createRedactedThinkingElement, createPlanModeElement, createImageElement } from './utils/ToolFormatter';

interface ToolCallProgressState extends ToolCallCardState {
  /** A single fixed slot keeps later text and worker section indices stable. */
  elementIndex: number;
}

interface DelegationProgressState extends DelegationProgressCardState {
  /** First slot of the fixed-size worker section; later sections never shift. */
  elementIndex: number;
  activeToolIds: Set<string>;
  toolNames: Map<string, string>;
  toolStartedAt: Map<string, number>;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
  terminal: boolean;
}

const DELEGATION_PROGRESS_PHASES = new Set<DelegationProgressInfo['phase']>([
  'started', 'text', 'tool_use', 'tool_result', 'waiting_input', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted',
]);
const DELEGATION_PROGRESS_TERMINAL_PHASES = new Set<DelegationProgressInfo['phase']>([
  'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted',
]);
const DELEGATION_PROGRESS_EVENT_LIMIT = 5;

interface StreamingMessageState {
  inlineRecoveryHeld?: boolean;
  openId: string;
  feishuMessageId: string | null;
  /** Includes continuation routes until this execution completes. */
  deliveredCardIds?: Set<string>;
  elements: FeishuCardElement[];
  currentTextContent: string;
  /** Mutable shell state, never transcript content or a completion signal. */
  activity?: ActivityProgressInfo;
  hasUpdated: boolean;
  createdAt: number;
  deviceId: string;
  threadId?: string;
  threadName?: string;
  cwd?: string;
  threads?: ThreadSummary[];
  pendingNewThread?: boolean;
  selectionFence?: SelectionFence;
  newThreadIntent?: SelectionFence;
  queueCardId?: string;
  queueStarted?: QueueStartedInfo;
  recoveryId?: string;
  recoveryCardPending?: boolean;
  recoveryPlainText?: boolean;
  recoveryCwd?: string;
  updateInFlight?: Promise<void>;
  /** Latest authenticated socket for final-dispatch revocation checks. */
  currentConnection?: () => boolean;
  updatePending: boolean;
  finalizing: boolean;
  /** Set once a terminal response arrived; accepted image work still drains. */
  imageIntakeClosed?: boolean;
  imageFailureHinted?: boolean;
  /** Reply budgets survive replacement of the socket while this card survives. */
  imageAttempts?: number;
  imageHashes?: Set<string>;
  imageDrainDeadline?: number;
  lastRenderedTextLength: number;
  delegationProgress: Map<string, DelegationProgressState>;
  toolCalls: Map<string, ToolCallProgressState>;
}

/**
 * Router Server
 * Handles Feishu WebSocket long connection, local WebSocket connections, and message routing
 */
export class RouterServer {
  private app: Koa;
  private readonly ingress = new IngressAdmission();
  private readonly pendingSockets = new Map<WebSocket, () => void>();
  private stopping = false;
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private config: ConfigManager;
  private store: JsonStore;
  private feishuLongConnHandler: FeishuLongConnHandler;
  private connectionHub: ConnectionHub;
  private bindingManager: BindingManager;
  private approvalCards: ApprovalCards;
  private readonly workerContextCards: WorkerContextCards;
  private readonly workerContextConnections = new Map<string, () => boolean>();
  private readonly settingsCards: SettingsCards;
  private readonly settingsConnections = new Map<string, (kind?: import('./types/Settings').SettingsKind | 'speed') => boolean>();
  private readonly maintenanceCards: MaintenanceCards;
  private readonly tips: TipService;
  private readonly maintenanceConnections = new Map<string, { updateNotice: boolean; current: () => boolean }>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  // Track streaming messages and coalesced Feishu card update state.
  private streamingMessages = new Map<string, StreamingMessageState>();
  private completedTasks = new Map<string, { deviceId: string; completedAt: number }>();
  private queueMessageOperations = new Map<string, Promise<void>>();
  private startedQueueMessages = new Map<string, number>();
  private readonly images = new ImageLifecycle();
  private readonly imageReplies = new Map<string, {
    reply: ImageReply; openId: string; deviceId: string; threadId?: string;
    current: () => boolean; stream?: StreamingMessageState; createdAt: number;
  }>();
  private readonly STREAMING_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes timeout
  private readonly DELEGATION_PROGRESS_HEARTBEAT_MS = 30 * 1000;
  private readonly CARD_THREAD_MAP_TTL_MS = CARD_THREAD_TTL_MS;
  private readonly selections: ThreadSelectionManager;
  private readonly threadInventoryRequests = new Map<string, {
    openId: string; deviceId: string; fence: SelectionFence; timer: NodeJS.Timeout; processing?: boolean;
    selection?: {
      cardId: string; threadId: string; commitAdmitted?: boolean; acknowledgedPending?: boolean;
      resolve(result: string | { notice: string }): void; reject(error: Error): void;
    };
  }>();
  private readonly deviceAuth: DeviceAuth;
  private readonly automaticFileEnrollment: AutomaticFileEnrollment;
  private readonly fileTransfers: FileTransfers;
  private readonly outputTransfers: OutputTransfers;
  private readonly inlineFileCards: InlineFileCards;
  private readonly outputApprovalTransitions = new Map<string, { openId: string; epoch: string; next: string }>();
  private readonly readyOutputSessions = new Map<string, string>();
  private readonly pendingOutputDevices = new Set<string>();
  private readonly approvalOutputParents = new Map<string, InlineOwner>();
  private readonly preparedOutputParents = new Map<string, InlineOwner>();
  private readonly attachmentHintStatus = new Map<string, HintStatus>();
  private outputsAvailable = false;
  private outputSessions = new Map<string, { id: string; openId: string }>();
  private readonly deviceEnrollments = new Set<string>();

  constructor(config: ConfigManager, store: JsonStore) {
    this.config = config;
    this.store = store;
    this.app = new Koa();
    this.connectionHub = new ConnectionHub();
    this.bindingManager = new BindingManager(store);
    this.selections = new ThreadSelectionManager(this.bindingManager, {
      names: () => undefined,
      notify: async (openId, text) => { await this.feishuLongConnHandler.sendMessage(openId, text); },
    });
    this.deviceAuth = new DeviceAuth(path.join(path.dirname(config.getConfigPath() || path.join(os.homedir(), '.remote-cli-router', 'config.json')), 'device-auth.json'));

    // Initialize FeishuLongConnHandler (WebSocket mode)
    this.feishuLongConnHandler = new FeishuLongConnHandler({
      appId: config.get('feishu', 'appId'),
      appSecret: config.get('feishu', 'appSecret'),
      store: this.store
    });

    // Share ConnectionHub with Feishu handler
    this.feishuLongConnHandler.setConnectionHub(this.connectionHub);
    const tipImages = new TipImages((data, mimeType) => this.feishuLongConnHandler.uploadImage(data, mimeType));
    const tipsConfig = config.get('tips');
    this.tips = new TipService({
      directory: path.join(path.dirname(config.getConfigPath() || path.join(os.homedir(), '.remote-cli-router', 'config.json')), 'tips'),
      catalog: TIPS,
      timezone: tipsConfig?.timezone,
      users: () => this.bindingManager.listBoundUserIds(),
      isBound: async openId => (await this.bindingManager.getUserDevices(openId)).length > 0,
      canDeliver: async openId => {
        if (tipsConfig?.enabled === false) return false;
        // This observes Router tasks, not every backend-local queue or operation.
        if ([...this.streamingMessages.values()].some(stream => stream.openId === openId)) return false;
        const devices = await this.bindingManager.getUserDevices(openId);
        return devices.some(device => this.connectionHub.isDeviceOnline(device.deviceId));
      },
      image: tip => tipImages.get(tip),
      create: (openId, elements, header, deliveryKey) => this.feishuLongConnHandler.sendTipCard(openId, elements, header, deliveryKey),
      update: (cardId, elements, header) => this.feishuLongConnHandler.updateTipCard(cardId, elements, header),
    });
    this.feishuLongConnHandler.onTipsCommand = (openId, content) => this.tips.command(openId, content);
    this.feishuLongConnHandler.onTipsAction = (openId, cardId, payload) => this.tips.action(openId, cardId, payload);
    this.feishuLongConnHandler.onUserActivity = openId => this.tips.activity(openId);
    const fileConfig = config.get('files');
    this.fileTransfers = new FileTransfers(
      path.join(path.dirname(config.getConfigPath() || path.join(os.homedir(), '.remote-cli-router', 'config.json')), 'attachments'),
      fileConfig?.enabled, fileConfig?.maxBytes, {
        session: deviceId => this.connectionHub.getFileSession(deviceId),
        owns: async (openId, deviceId) => (await this.bindingManager.getDeviceBinding(deviceId))?.openId === openId,
        send: (deviceId, message) => this.connectionHub.sendToDevice(deviceId, message),
        download: (messageId, fileKey, signal) => this.feishuLongConnHandler.downloadFileResource(messageId, fileKey, signal),
        notify: async record => {
          const failed = record.state === 'failed';
          const ready = ['saved', 'parsed', 'partial', 'unsupported'].includes(record.state);
          const header = { title: { tag: 'plain_text', content: `📎 File · ${record.state}` }, template: failed ? 'red' : ready ? 'green' : 'blue' };
          const details = [record.name, record.size === undefined ? 'Limit: 20 MiB' : `${(record.size / 1024 / 1024).toFixed(2)} MiB`,
            `Device: ${record.deviceId}`,
            record.threadId ? `Thread: ${record.threadId}` : 'Waiting for thread admission', record.detail,
            ready ? 'Send your instructions in this thread, or reply to this card. Saving a file does not start a model task.' : undefined].filter(Boolean).join('\n');
          const elements = [{ tag: 'div', text: { tag: 'plain_text', content: details } }];
          if (record.cardId) {
            await this.feishuLongConnHandler.updateApprovalCard(record.cardId, elements, header); return record.cardId;
          }
          return await this.feishuLongConnHandler.sendTaskNotificationCard(record.openId, elements, header) ?? undefined;
        },
      });
    this.outputTransfers = new OutputTransfers(path.join(path.dirname(config.getConfigPath()
      || path.join(os.homedir(), '.remote-cli-router', 'config.json')), 'output-files'), {
      session: deviceId => this.outputSessions.get(deviceId),
      owns: async (openId, deviceId, epoch) => this.selections.isOwnershipCurrent(openId, deviceId, epoch)
        && (await this.bindingManager.getDeviceBinding(deviceId))?.openId === openId,
      send: (deviceId, message) => this.connectionHub.sendToDevice(deviceId, message),
      create: (openId, content, uuid) => this.feishuLongConnHandler.createOutputCard(openId, content, uuid),
      patch: (cardId, content) => this.feishuLongConnHandler.patchOutputCard(cardId, content),
      inline: messageId => this.inlineFileCards.refresh(messageId),
      parentAllowed: (identity, cardId) => this.inlineFileCards.allows(identity, cardId),
      upload: (filename, name) => this.feishuLongConnHandler.uploadOutputFile(filename, name),
      sendFile: (openId, content, uuid) => this.feishuLongConnHandler.sendOutputFile(openId, content, uuid),
    });
    this.inlineFileCards = new InlineFileCards(path.join(path.dirname(config.getConfigPath()
      || path.join(os.homedir(), '.remote-cli-router', 'config.json')), 'inline-file-cards'), {
      owns: async owner => this.selections.isOwnershipCurrent(owner.openId, owner.deviceId, owner.epoch)
        && (await this.bindingManager.getDeviceBinding(owner.deviceId))?.openId === owner.openId,
      rows: identity => this.outputTransfers.inlineRows(identity),
      status: owner => !this.fileTransfers.enabled ? 'disabled' : this.outputSessions.has(owner.deviceId) ? 'ready' : this.attachmentHintStatus.get(owner.deviceId),
      approvalAvailable: owner => this.outputsAvailable && this.pendingOutputDevices.has(owner.deviceId)
        && this.automaticFileEnrollment.canRecover(owner.deviceId, owner.openId, owner.epoch),
      requestApproval: async owner => {
        for (const [id] of this.approvalOutputParents) if (!this.inlineFileCards.ownerFor(id)) this.approvalOutputParents.delete(id);
        for (const [id] of this.preparedOutputParents) if (!this.inlineFileCards.ownerFor(id)) this.preparedOutputParents.delete(id);
        if (this.approvalOutputParents.size >= 100 && !this.approvalOutputParents.has(owner.messageId)) return 'File approval capacity is unavailable.';
        this.approvalOutputParents.set(owner.messageId, owner);
        return this.automaticFileEnrollment.requestExplicit(owner.deviceId, owner.openId, owner.epoch);
      },
      patch: (cardId, content) => this.feishuLongConnHandler.patchInlineOutputCard(cardId, content),
    });
    this.feishuLongConnHandler.inlineFiles = this.inlineFileCards;
    this.feishuLongConnHandler.onInlineFilePage = (openId, cardId, action) => this.inlineFileCards.page(openId, cardId, action);
    this.feishuLongConnHandler.onOutputFileAction = (openId, cardId, payload) => this.outputsAvailable
      ? this.outputTransfers.click(openId, cardId, payload) : Promise.resolve('File retrieval is disabled.');
    this.feishuLongConnHandler.onFileMessage = input => this.fileTransfers.receive(input);
    this.feishuLongConnHandler.onResolveFile = (openId, sourceId) => this.fileTransfers.resolve(openId, sourceId);
    this.feishuLongConnHandler.onDeviceEnrollmentBoundary = (deviceId, phase) => {
      if (phase === 'end') { this.deviceEnrollments.delete(deviceId); return; }
      // Exclude credentialless registrations before the pending marker reaches disk.
      this.deviceEnrollments.add(deviceId);
      this.connectionHub.disconnectDevice(deviceId);
    };
    this.feishuLongConnHandler.onApproveDeviceKey = async (openId, deviceId, publicKey) => {
      if ((await this.bindingManager.getDeviceBinding(deviceId))?.openId !== openId) throw new Error('Device ownership changed.');
      await this.selections.invalidateDevice(openId, deviceId);
      await this.deviceAuth.enroll(deviceId, openId, publicKey);
      this.cancelThreadInventories(deviceId);
      this.connectionHub.disconnectDevice(deviceId);
      this.fileTransfers.disconnect(deviceId);
      this.outputTransfers.disconnect(deviceId); this.outputSessions.delete(deviceId);
      this.pendingOutputDevices.delete(deviceId); this.readyOutputSessions.delete(deviceId);
    };
    this.automaticFileEnrollment = new AutomaticFileEnrollment(path.join(path.dirname(config.getConfigPath()
      || path.join(os.homedir(), '.remote-cli-router', 'config.json')), 'automatic-file-enrollment', 'requests.json'), {
      bindings: this.bindingManager, auth: this.deviceAuth,
      create: (openId, content, uuid) => this.feishuLongConnHandler.createOutputCard(openId, content, uuid),
      approve: async (openId, deviceId, key) => {
        const epoch = this.bindingManager.getCardThreadEpoch(openId, deviceId);
        await this.feishuLongConnHandler.onApproveDeviceKey!(openId, deviceId, key);
        this.outputApprovalTransitions.set(deviceId, { openId, epoch, next: this.bindingManager.getCardThreadEpoch(openId, deviceId) });
      },
    });
    this.feishuLongConnHandler.onAutomaticFileEnrollment = async (openId, cardId, payload) => {
      if (!this.fileTransfers.enabled) return 'File access is disabled by the Router administrator.';
      const result = await this.automaticFileEnrollment.click(openId, cardId, payload);
      // Enrollment's serial queue has been released before acquiring an inline parent lock.
      for (const [deviceId, transition] of this.outputApprovalTransitions) {
        if (transition.openId !== openId) continue;
        this.outputApprovalTransitions.delete(deviceId);
        const parents = [...this.approvalOutputParents.values()].filter(p => p.openId === openId && p.deviceId === deviceId && p.epoch === transition.epoch);
        for (const parent of parents) {
          this.approvalOutputParents.delete(parent.messageId);
          if (this.preparedOutputParents.size < 100 && await this.outputTransfers.migrateApprovalSource(parent, transition.next)
            && await this.inlineFileCards.migrateApproval(parent, transition.next)) {
            this.preparedOutputParents.set(parent.messageId, { ...parent, epoch: transition.next });
          }
        }
        await this.drainPendingOutputs(deviceId);
      }
      return result;
    };
    this.feishuLongConnHandler.onRevokeDevice = async deviceId => {
      const owner = await this.bindingManager.getDeviceBinding(deviceId);
      if (owner?.openId) await this.selections.invalidateDevice(owner.openId, deviceId);
      await this.deviceAuth.revoke(deviceId);
      this.cancelThreadInventories(deviceId);
      this.connectionHub.disconnectDevice(deviceId);
      this.fileTransfers.disconnect(deviceId);
      this.outputTransfers.disconnect(deviceId); this.outputSessions.delete(deviceId);
      this.pendingOutputDevices.delete(deviceId); this.readyOutputSessions.delete(deviceId);
    };
    this.approvalCards = new ApprovalCards({
      ownsDevice: async (openId, deviceId) => (await this.bindingManager.getDeviceBinding(deviceId))?.openId === openId,
      sendToDevice: (deviceId, message) => this.connectionHub.sendToDevice(deviceId, message),
      create: (openId, elements, header) => this.feishuLongConnHandler.sendTaskNotificationCard(openId, elements, header),
      update: (cardId, elements, header) => this.feishuLongConnHandler.updateApprovalCard(cardId, elements, header),
      registerReplyRoute: async (cardId, threadId, deviceId, openId, current) => {
        await this.registerCardThread(cardId, { threadId, deviceId, openId, epoch: this.selections.capture(openId, deviceId).epoch, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS }, current);
      },
      captureReplyRoute: (openId, deviceId) => {
        const fence = this.selections.capture(openId, deviceId);
        return () => this.selections.isOwnershipCurrent(openId, deviceId, fence.epoch);
      },
    });
    this.feishuLongConnHandler.onApprovalAction = (openId, requestId, cardId, decision) =>
      this.approvalCards.click(openId, requestId, cardId, decision as ApprovalAction);
    this.workerContextCards = new WorkerContextCards({
      ownsDevice: async (openId, deviceId) => (await this.bindingManager.getDeviceBinding(deviceId))?.openId === openId,
      available: deviceId => this.workerContextConnections.get(deviceId)?.() === true,
      send: (deviceId, message) => this.connectionHub.sendToDevice(deviceId, message),
      refresh: (cardId, rootId) => this.feishuLongConnHandler.refreshWorkerContextCard(cardId, rootId),
    });
    this.feishuLongConnHandler.workerContexts = this.workerContextCards;
    this.settingsCards = new SettingsCards({
      ownsDevice: async (openId, deviceId) => (await this.bindingManager.getDeviceBinding(deviceId))?.openId === openId,
      available: (deviceId, kind) => this.settingsConnections.get(deviceId)?.(kind) === true,
      speedAvailable: deviceId => this.settingsConnections.get(deviceId)?.('speed') === true,
      send: (deviceId, message) => this.connectionHub.sendToDevice(deviceId, message),
      update: (cardId, elements, header) => this.feishuLongConnHandler.updateApprovalCard(cardId, elements, header),
    });
    this.feishuLongConnHandler.settingsCards = this.settingsCards;
    this.maintenanceCards = new MaintenanceCards(new NoticeReceipts(path.join(
      path.dirname(config.getConfigPath() || path.join(os.homedir(), '.remote-cli-router', 'config.json')), 'notice-receipts.json')), {
      owner: async deviceId => (await this.bindingManager.getDeviceBinding(deviceId))?.openId,
      send: (deviceId, message) => this.connectionHub.sendToDevice(deviceId, message),
      create: (openId, elements, header) => this.feishuLongConnHandler.sendTaskNotificationCard(openId, elements, header),
      update: (cardId, elements, header) => this.feishuLongConnHandler.updateApprovalCard(cardId, elements, header),
    });
    this.feishuLongConnHandler.onMaintenanceAction = (openId, id, cardId, action, offset) => action === 'view'
      ? this.maintenanceCards.view(openId, id, cardId, offset!, deviceId => {
        const connection = this.maintenanceConnections.get(deviceId);
        return connection?.updateNotice ? connection.current : undefined;
      })
      : this.maintenanceCards.reply(openId, id, cardId, action);

    // Register callback for streaming message start
    this.feishuLongConnHandler.setOnCaptureSelection((openId, deviceId) => this.selections.capture(openId, deviceId));
    this.feishuLongConnHandler.setOnValidateSelection(fence => this.selections.isCurrent(fence));
    this.feishuLongConnHandler.setOnStartStreaming(async (messageId: string, openId: string, feishuMessageId: string | null, deviceId: string, threadId?: string, pendingNewThread?: boolean, queueCardId?: string, threadName?: string, selectionIntent?: SelectionFence) => {
      if (feishuMessageId) this.feishuLongConnHandler.bindDiagnosticTask?.(feishuMessageId, messageId);
      console.log(`[RouterServer] Registering streaming session: msgId=${messageId}, feishuMsgId=${feishuMessageId}, deviceId=${deviceId}, threadId=${threadId}, pendingNewThread=${pendingNewThread}`);
      this.cancelImageReply(messageId);
      const previous = this.streamingMessages.get(messageId);
      if (previous) this.clearDelegationProgressTimers(previous);
      this.streamingMessages.set(messageId, {
        openId,
        feishuMessageId,
        elements: [],
        currentTextContent: '',
        hasUpdated: false,
        createdAt: Date.now(),
        deviceId,
        threadId,
        threadName,
        pendingNewThread,
        selectionFence: selectionIntent ?? this.selections.capture(openId, deviceId),
        newThreadIntent: pendingNewThread ? selectionIntent : undefined,
        queueCardId,
        updatePending: false,
        finalizing: false,
        lastRenderedTextLength: 0,
        delegationProgress: new Map(),
        toolCalls: new Map(),
      });
      if (this.outputSessions.has(deviceId)) {
        await this.outputTransfers.admitSource({ messageId, openId, deviceId, threadId,
          epoch: selectionIntent?.epoch ?? this.selections.capture(openId, deviceId).epoch }).catch(() => {});
      }
      if (this.outputSessions.has(deviceId) || this.attachmentHintStatus.has(deviceId)) await this.admitInlineParent(messageId).catch(() => {});
      // Populate card associations for parent_id-based routing
      if (feishuMessageId && threadId) {
        await this.registerCardThread(feishuMessageId, { threadId, deviceId, openId, epoch: selectionIntent?.epoch ?? this.selections.capture(openId, deviceId).epoch, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS },
          () => this.streamingMessages.get(messageId)?.feishuMessageId === feishuMessageId);
      }
      console.log(`[RouterServer] Total streaming sessions: ${this.streamingMessages.size}`);
    });

    // Register callback for thread resolution from Feishu parent_id
    this.feishuLongConnHandler.setOnResolveThread(async (feishuMessageId: string, openId: string) => {
      return this.resolveCardThread(feishuMessageId, openId);
    });

    // Register callback for resolving user's active thread (new top-level messages)
    this.feishuLongConnHandler.setOnResolveActiveThread(async (openId: string, deviceId: string) => {
      return this.selections.resolve(openId, deviceId);
    });
    this.feishuLongConnHandler.onRecoverThreads = async (openId, deviceId) => {
      if (this.stopping || this.threadInventoryRequests.size >= 100) {
        await this.feishuLongConnHandler.sendMessage(openId, 'Thread controls are busy. Retry shortly.');
        return true;
      }
      const messageId = randomUUID();
      const fence = this.selections.beginIntent(openId, deviceId);
      const timer = setTimeout(() => {
        if (!this.threadInventoryRequests.delete(messageId)) return;
        void this.feishuLongConnHandler.sendMessage(openId, 'Could not refresh thread controls. Check the device connection and retry /thread list.');
      }, 10_000);
      timer.unref?.();
      this.threadInventoryRequests.set(messageId, { openId, deviceId, fence, timer });
      const sent = await this.connectionHub.sendToDevice(deviceId, { type: 'status', messageId, timestamp: Date.now() });
      if (!sent) {
        clearTimeout(timer);
        this.threadInventoryRequests.delete(messageId);
        await this.feishuLongConnHandler.sendMessage(openId, 'Could not refresh thread controls. Reconnect the device and retry /thread list.');
      }
      return true;
    };

    // Register callback for card button thread switching
    this.feishuLongConnHandler.onCardSwitchThread = async (openId: string, cardId: string, threadId: string) => {
      const revision = this.selections.reserveIntent(openId);
      const source = await this.requireCurrentCardDevice(cardId, openId);
      const fence = { ...this.selections.intent(openId, source.deviceId, revision), epoch: source.epoch };
      if (!this.selections.isCurrent(fence)) throw new Error('This selection was superseded. Use a fresh thread card.');
      if (typeof threadId !== 'string' || !threadId || threadId.length > 200) throw new Error('Invalid target thread.');
      if (this.stopping || this.threadInventoryRequests.size >= 100) throw new Error('Thread controls are busy. Retry shortly.');
      const messageId = randomUUID();
      return new Promise<string | { notice: string }>((resolve, reject) => {
        const fail = () => {
          this.cancelThreadInventory(messageId,
            new Error('Could not verify the target thread. Reconnect the device and retry /thread list.'));
        };
        const timer = setTimeout(fail, 2000);
        timer.unref?.();
        this.threadInventoryRequests.set(messageId, { openId, deviceId: source.deviceId, fence, timer,
          selection: { cardId, threadId, resolve, reject } });
        void this.connectionHub.sendToDevice(source.deviceId, { type: 'status', messageId, timestamp: Date.now() })
          .then(sent => { if (!sent) fail(); }, fail);
      });
    };

    // Register callback for creating a new thread via card button
    this.feishuLongConnHandler.onCardNewThread = async (openId: string, cardId: string) => {
      const revision = this.selections.reserveIntent(openId);
      const source = await this.requireCurrentCardDevice(cardId, openId);
      const intent = { ...this.selections.intent(openId, source.deviceId, revision), epoch: source.epoch };
      console.log(`[RouterServer] Creating new thread for ${openId} via card button`);
      await this.feishuLongConnHandler.sendCommandFromCardAction(openId, '/thread new', true, source.deviceId, intent);
    };

    this.feishuLongConnHandler.onQueueAction = async (openId, action, queueId, threadId, cardMessageId) => {
      return this.feishuLongConnHandler.sendQueueActionFromCardAction(openId, action, queueId, threadId, cardMessageId);
    };

    this.feishuLongConnHandler.onDeviceSwitchIntent = (openId, newDeviceId) => {
      this.selections.beginIntent(openId, newDeviceId);
    };
    // JsonStore invalidates both devices atomically with the binding switch. Do not
    // invalidate again in an asynchronous notification: a later switch may have won.

    this.setupMiddleware();
    this.setupRoutes();
  }

  private async registerCardThread(cardId: string, entry: CardThreadAssociation,
    current: () => boolean = () => true): Promise<void> {
    await this.store.setCardThread(cardId, entry, () => current()
      && this.selections.isOwnershipCurrent(entry.openId, entry.deviceId, entry.epoch));
  }

  private async resolveCardThread(cardId: string, openId: string): Promise<{ threadId: string; deviceId: string } | undefined> {
    const entry = this.store.getCardThread(cardId);
    if (!entry) return undefined;
    if (entry.openId !== openId || !this.selections.isOwnershipCurrent(openId, entry.deviceId, entry.epoch)) return undefined;
    if ((await this.bindingManager.getDeviceBinding(entry.deviceId))?.openId !== openId
      || this.store.getCardThread(cardId) !== entry
      || !this.selections.isOwnershipCurrent(openId, entry.deviceId, entry.epoch)) return undefined;
    return { threadId: entry.threadId, deviceId: entry.deviceId };
  }

  private async requireCurrentCardDevice(cardId: string, openId: string): Promise<{ threadId: string; deviceId: string; epoch: string }> {
    const entry = this.store.getCardThread(cardId);
    const source = await this.resolveCardThread(cardId, openId);
    if (!source) throw new Error('This thread card has expired. Run /thread list for a fresh card.');
    const active = await this.bindingManager.getActiveDevice(openId);
    if (!active || active.deviceId !== source.deviceId || !entry || this.store.getCardThread(cardId) !== entry
      || !this.selections.isOwnershipCurrent(openId, entry.deviceId, entry.epoch)) {
      throw new Error('This card belongs to a different device. Switch back to that device or use a fresh card.');
    }
    return { ...source, epoch: entry.epoch };
  }

  /**
   * Setup Koa middleware
   */
  private setupMiddleware(): void {
    this.app.use(async (ctx, next) => {
      if (ctx.path === '/api/bind/request' && ctx.method === 'POST') {
        if (this.stopping) { ctx.status = 503; return; }
        if (!this.ingress.bindingPeer(ctx.req.socket.remoteAddress ?? 'unknown')) {
          ctx.status = 429;
          ctx.set('Retry-After', '300');
          ctx.body = { success: false, error: 'Binding request limit exceeded. Retry later.' };
          return;
        }
      }
      await next();
    });
    this.app.use(bodyParser({ jsonLimit: '16kb', formLimit: '16kb', textLimit: '16kb' }));

    // Error handling
    this.app.use(async (ctx, next) => {
      try {
        await next();
      } catch (error: any) {
        console.error('Request error:', error);
        ctx.status = error.status || 500;
        ctx.body = {
          success: false,
          error: error.message || 'Internal server error'
        };
      }
    });

    // Request logging
    this.app.use(async (ctx, next) => {
      const start = Date.now();
      await next();
      const ms = Date.now() - start;
      console.log(`${ctx.method} ${ctx.url} - ${ctx.status} (${ms}ms)`);
    });
  }

  /**
   * Setup HTTP routes
   */
  private setupRoutes(): void {
    const router = new Router();

    // Health check endpoint
    router.get('/health', (ctx) => {
      const stats = this.connectionHub.getConnectionStats();
      ctx.body = {
        status: 'ok',
        timestamp: Date.now(),
        connections: stats.totalConnections
      };
    });

    // Version info endpoint — used by CLI to check for upgrades
    router.get('/api/version', (ctx) => {
      ctx.body = {
        success: true,
        version: ROUTER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        minSupportedCliVersion: MIN_SUPPORTED_CLI_VERSION,
      };
    });

    router.post('/api/output-files/:id', async ctx => { if (!this.outputsAvailable) { ctx.status = 503; return; } await this.outputTransfers.receive(ctx, ctx.params.id); });
    router.get('/api/files/:id', async ctx => { await this.fileTransfers.serve(ctx, ctx.params.id); });

    // Binding code request endpoint
    router.post('/api/bind/request', async (ctx) => {
      const { deviceId, deviceName, platform } = (ctx.request.body ?? {}) as {
        deviceId: string;
        deviceName?: string;
        platform?: string;
      };

      // Validate required fields
      if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(deviceId)) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          error: 'deviceId is required'
        };
        return;
      }

      if (this.stopping) { ctx.status = 503; return; }
      if (!this.ingress.bindingDevice(deviceId)) {
        ctx.status = 429;
        ctx.set('Retry-After', '300');
        ctx.body = { success: false, error: 'Binding request limit exceeded. Retry later.' };
        return;
      }
      if (deviceName !== undefined && (typeof deviceName !== 'string' || deviceName.length > 200)) {
        ctx.status = 400; ctx.body = { success: false, error: 'Invalid device name.' }; return;
      }
      try {
        const { devicePublicKey, nonce, signature } = ctx.request.body as any;
        if (devicePublicKey && !this.fileTransfers.enabled) {
          ctx.status = 400; ctx.body = { success: false, error: 'File reception is disabled by the Router administrator (files.enabled=false).' }; return;
        }
        if (devicePublicKey !== undefined && (!DeviceAuth.validKey(devicePublicKey)
          || !DeviceAuth.verifyProof(devicePublicKey, deviceId, nonce, signature))) {
          ctx.status = 400;
          ctx.body = { success: false, error: 'Invalid device enrollment proof.' };
          return;
        }
        // Generate binding code
        const bindingCode = await this.bindingManager.generateBindingCode(
          deviceId,
          deviceName || 'Unknown Device',
          ...(devicePublicKey ? [devicePublicKey] as [string] : [])
        );

        ctx.body = {
          success: true,
          bindingCode: bindingCode.code,
          ...(devicePublicKey ? { deviceAuth: true } : {}),
          expiresAt: bindingCode.expiresAt,
          expiresIn: Math.floor((bindingCode.expiresAt - Date.now()) / 1000) // seconds
        };
      } catch (error: any) {
        console.error('Failed to generate binding code:', error);
        ctx.status = error instanceof IngressLimitError ? 429 : 500;
        if (error instanceof IngressLimitError) ctx.set('Retry-After', String(error.retryAfter));
        ctx.body = {
          success: false,
          error: error.message || 'Failed to generate binding code'
        };
      }
    });

    this.app.use(router.routes());
    this.app.use(router.allowedMethods());
  }

  private diagnosticConnectionEpoch = 0;

  /**
   * Setup WebSocket server
   */
  private setupWebSocket(server: HttpServer): void {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: INGRESS_LIMITS.payloadBytes
    });

    this.wss.on('connection', (ws: WebSocket, req) => {
      const connectionEpoch = ++this.diagnosticConnectionEpoch;
      const admission = this.stopping ? undefined : this.ingress.admit(req.socket.remoteAddress ?? 'unknown');
      if (!admission) {
        ws.on('error', () => {});
        ws.terminate();
        return;
      }
      let registered = false;
      const wireBudget = new PendingFrameBudget(bytes => admission.receive(bytes));
      const inspectFrames = (chunk: Buffer) => {
        if (!registered && !wireBudget.receive(chunk)) { releaseAdmission(); ws.terminate(); }
      };
      // Public net.Socket API; prepend so refused frames cannot reach ws parsing first.
      const observesWire = typeof req.socket.prependListener === 'function';
      if (observesWire) req.socket.prependListener('data', inspectFrames);
      const releaseAdmission = () => {
        admission.release();
        clearTimeout(registrationTimer);
        this.pendingSockets.delete(ws);
        if (observesWire) req.socket.removeListener('data', inspectFrames);
      };
      const registrationTimer = setTimeout(() => {
        releaseAdmission();
        ws.terminate();
      }, INGRESS_LIMITS.registrationMs);
      this.pendingSockets.set(ws, releaseAdmission);

      let deviceId: string | null = null;
      let socketClosed = false;
      let taskRecoveryEnabled = false;
      let scheduleResultsEnabled = false;
      let approvalCardsEnabled = false;
      let delegationProgressEnabled = false;
      let delegationProgressTextEnabled = false;
      let workerContextResetEnabled = false;
      let settingsCardsEnabled = false;
      let modelSpeedSettingsEnabled = false;
      let directoryCardsEnabled = false;
      let delegationCardsEnabled = false;
      let streamingContextEnabled = false;
      let activityProgressEnabled = false;
      let updateNoticeEnabled = false;
      let subscriptionInspectionEnabled = false;
      let bankedResetReminderEnabled = false;
      let authenticationPending = false;
      let automaticEnrollmentEnabled = false;
      let automaticEnrollmentAuthority: EnrollmentAuthority | undefined;
      let automaticEnrollmentRequestPending = false;
      let challengeTimer: NodeJS.Timeout | undefined;
      let heartbeatTimeout: NodeJS.Timeout | null = null;

      // Reset heartbeat timeout
      const resetHeartbeat = () => {
        if (heartbeatTimeout) clearTimeout(heartbeatTimeout);

        // If no heartbeat received within 3x interval, consider connection dead
        const interval = this.config.get('websocket', 'heartbeatInterval');
        heartbeatTimeout = setTimeout(() => {
          deliveryEvent('socket_heartbeat_timeout', { connectionEpoch });
          ws.close();
        }, interval * 3);
      };

      resetHeartbeat();

      // Handle incoming messages
      ws.on('message', async (data: Buffer) => {
        let finishQueueMessage: (() => void) | undefined;
        try {
          if (this.stopping || socketClosed || (!registered && (data.byteLength > INGRESS_LIMITS.preauthBytes
            || !admission.active() || (!observesWire && !admission.receive(data.byteLength))))) {
            releaseAdmission(); ws.terminate(); return;
          }
          const message = JSON.parse(data.toString());
          if (!message || typeof message !== 'object') return;

          if (!deviceId && message.type !== MessageType.BINDING_REQUEST && message.type !== MessageType.HEARTBEAT) return;

          if (deviceId && message.type !== MessageType.BINDING_REQUEST
            && !this.connectionHub.isCurrentConnection(deviceId, ws)) return;

          // Update heartbeat on any message
          resetHeartbeat();
          // Retired presentation: ignore legacy background terminal frames before
          // recipient lookup, card creation, logging or reply-route mutation.
          if (message.type === MessageType.TASK_NOTIFICATION) return;

          if (message.type === 'pending_outputs_ready') {
            if (!deviceId || !this.pendingOutputDevices.has(deviceId) || !this.outputSessions.has(deviceId)
              || !this.connectionHub.isCurrentConnection(deviceId, ws)) return;
            this.readyOutputSessions.set(deviceId, this.outputSessions.get(deviceId)!.id);
            await this.drainPendingOutputs(deviceId);
            return;
          }
          if (message.type === 'automatic_file_enrollment') {
            const current = () => registered && !this.stopping && this.connectionHub.isCurrentConnection(deviceId!, ws) && ws.readyState === WebSocket.OPEN;
            if (!deviceId || !automaticEnrollmentEnabled || !automaticEnrollmentAuthority || !this.fileTransfers.enabled
              || automaticEnrollmentRequestPending || !current()) return;
            automaticEnrollmentRequestPending = true;
            let status = 'unavailable';
            try { status = await this.automaticFileEnrollment.request(deviceId, message.data, automaticEnrollmentAuthority, current); } catch { /* Enrollment must not interrupt text tasks. */ }
            finally { automaticEnrollmentRequestPending = false; }
            if (current()) ws.send(JSON.stringify({ type: 'automatic_file_enrollment_status', data: { status } }));
            return;
          }

          if (message.type === 'status' && this.threadInventoryRequests.has(message.messageId)) {
            await this.handleThreadInventoryResponse(message, deviceId, ws);
            return;
          }

          if (message.type === 'output_offer' || message.type === 'output_transfer_failed' || message.type === 'output_discovery') {
            if (!deviceId || !this.outputSessions.has(deviceId)) return;
            if (message.type === 'output_transfer_failed') this.outputTransfers.failed(deviceId, message.transferId);
            else if (message.type === 'output_discovery') await this.outputTransfers.discovery(deviceId, message);
            else {
              const stream = this.streamingMessages.get(message.reference?.messageId);
              if (stream && stream.deviceId === deviceId
                && this.inlineFileCards.ownerFor(message.reference?.messageId)?.epoch !== this.selections.capture(stream.openId, deviceId).epoch) {
                await this.outputTransfers.admitSource({ messageId: message.reference.messageId, deviceId,
                  openId: stream.openId, threadId: stream.threadId,
                  epoch: stream.selectionFence?.epoch ?? this.selections.capture(stream.openId, deviceId).epoch });
              }
              await this.admitInlineParent(message.reference?.messageId).catch(() => {});
              await this.outputTransfers.offer(deviceId, message.reference);
            }
            return;
          }
          if (message.type === 'file_status') {
            if (deviceId) await this.fileTransfers.handleStatus(deviceId, message);
            return;
          }

          if (['update_notice', 'update_notice_page', 'subscription_reminder'].includes(message.type)) {
            if (!deviceId) return;
            const current = () => this.connectionHub.isCurrentConnection(deviceId!, ws);
            if (message.type === 'update_notice' && updateNoticeEnabled) await this.maintenanceCards.receiveNotice(message, deviceId, current);
            if (message.type === 'update_notice_page' && updateNoticeEnabled) await this.maintenanceCards.receivePage(message, deviceId);
            if (message.type === 'subscription_reminder' && subscriptionInspectionEnabled
              && (message.reminder?.kind !== 'banked_reset_increase' || bankedResetReminderEnabled)) {
              await this.maintenanceCards.receiveReminder(message, deviceId, current);
            }
            return;
          }

          if (message.type === 'worker_context_reset_result') {
            if (workerContextResetEnabled && deviceId) await this.workerContextCards.resolve(deviceId, message);
            return;
          }

          if (message.type === 'settings_result') {
            if (settingsCardsEnabled && deviceId && (message.menu?.kind !== 'delegation' || delegationCardsEnabled)
              && (message.menu?.kind !== 'directory' || directoryCardsEnabled)) await this.settingsCards.resolve(deviceId, message);
            return;
          }
          if (message.type === 'approval_request' || message.type === 'approval_resolved') {
            if (!approvalCardsEnabled || !deviceId) return;
            if (message.type === 'approval_request') {
              await this.approvalCards.receive(message, deviceId, () => this.connectionHub.isCurrentConnection(deviceId!, ws));
            } else await this.approvalCards.resolve(message, deviceId);
            return;
          }
          const imageDevice = deviceId;
          const imageCurrent = () => !socketClosed && ws.readyState === WebSocket.OPEN
            && !!imageDevice && this.connectionHub.isCurrentConnection(imageDevice, ws);
          if ([MessageType.RESPONSE, MessageType.NOTIFICATION,
            'task_resume', 'stream', 'stream_context', 'queue_started'].includes(message.type)
            && !await this.authorizeRecipientOutput(message, imageDevice, imageCurrent)) return;
          if (message.queueStarted?.source !== undefined
            && (!scheduleResultsEnabled || !this.validScheduledResult(message))) return;
          // Establish routing before card creation awaits. Payload admission and
          // response closure must occur before waiting for earlier operations.
          if (imageDevice && taskRecoveryEnabled && message.type === 'task_resume') {
            this.prepareImageReply(message.messageId, message.openId, imageDevice, imageCurrent, message.threadId, true);
          }
          if (imageDevice && message.type === MessageType.RESPONSE) {
            const owner = message.openId || message.data?.openId;
            const stream = this.streamingMessages.get(message.messageId);
            const route = this.imageReplies.get(message.messageId);
            if ((stream && (stream.openId !== owner || stream.deviceId !== imageDevice))
              || (route && (route.openId !== owner || route.deviceId !== imageDevice))) return;
            if (route) this.images.close(route.reply);
            if (stream) this.closeImageIntake(stream, route?.reply.deadline);
          }
          if (message.type === 'stream' && message.streamType === 'image') {
            if (!imageDevice) return;
            const priorImageQueue = this.queueMessageOperations.get(message.messageId);
            const operation = this.handleImage(message.messageId, message.openId, message.image, imageDevice, imageCurrent);
            // Do not retain the parsed payload or raw frame in this async handler.
            delete message.image;
            data = Buffer.alloc(0);
            if (this.startedQueueMessages.has(message.messageId)
              && this.imageReplies.get(message.messageId)?.reply.tail === operation) {
              const barrier = priorImageQueue ? priorImageQueue.then(() => operation, () => operation) : operation;
              this.queueMessageOperations.set(message.messageId, barrier);
              void barrier.then(() => {
                if (this.queueMessageOperations.get(message.messageId) === barrier) this.queueMessageOperations.delete(message.messageId);
              });
            }
            await operation;
            return;
          }
          if (message.type === 'queue_started') {
            await this.handleQueueStarted(message, deviceId, imageCurrent);
            return;
          }
          // Serialize queued output through card creation, asynchronous tool/image
          // updates, and completion. Other threads retain independent streams.
          if (taskRecoveryEnabled && (message.type === 'task_resume' || message.type === MessageType.RESPONSE)) {
            this.startedQueueMessages.set(message.messageId, Date.now());
          }
          if (this.startedQueueMessages.has(message.messageId)) {
            const previous = this.queueMessageOperations.get(message.messageId);
            const completed = new Promise<void>((resolve) => {
              finishQueueMessage = () => {
                resolve();
                if (this.queueMessageOperations.get(message.messageId) === completed) {
                  this.queueMessageOperations.delete(message.messageId);
                }
              };
            });
            this.queueMessageOperations.set(message.messageId, completed);
            if (previous) await previous;
            if (deviceId && !this.connectionHub.isCurrentConnection(deviceId, ws)) return;
          }

          switch (message.type) {
            case 'task_resume': {
              if (!taskRecoveryEnabled || !deviceId) break;
              const current = imageCurrent;
              let success = false;
              deliveryEvent('task_resume_received', { task: taskCorrelation(message.messageId), connectionEpoch });
              try {
                success = await this.handleTaskResume(message, deviceId, current);
              } catch (error) {
                deliveryEvent('task_resume_failed', { task: taskCorrelation(message.messageId), connectionEpoch, ...safeCardError(error) });
              }
              if (!success && current()) this.cancelImageReply(message.messageId);
              if (current()) {
                ws.send(JSON.stringify({ type: 'task_resume_ack', messageId: message.messageId,
                  recoveryId: message.taskResume?.recoveryId, state: message.taskResume?.state, success, timestamp: Date.now() }));
                deliveryEvent('resume_ack_send', { task: taskCorrelation(message.messageId), connectionEpoch, success, acceptedLocally: true });
              }
              break;
            }

            case MessageType.BINDING_REQUEST:
              // Device sends binding request with deviceId and optional protocolVersion
              if (authenticationPending || deviceId) break;
              if (typeof message.data?.deviceId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(message.data.deviceId)) {
                authenticationPending = true;
                const requestedId: string = message.data.deviceId;
                let authenticatedOwner: string | undefined;
                try {
                  if (this.deviceEnrollments.has(requestedId)) {
                    ws.send(JSON.stringify({ type: 'error', data: { code: 'DEVICE_AUTH_REQUIRED', message: 'Device key enrollment is in progress. Retry after approval.' } }));
                    ws.close();
                    break;
                  }
                  const enrolled = await this.deviceAuth.get(requestedId);
                  const binding = await this.bindingManager.getDeviceBinding(requestedId);
                  const requiresAuthentication = binding?.devices?.some(device => device.deviceId === requestedId && device.requiresDeviceAuth);
                  if (requiresAuthentication && !enrolled) {
                    ws.send(JSON.stringify({ type: 'error', data: { code: 'DEVICE_AUTH_REQUIRED', message: 'Device key enrollment is incomplete. Approve the device key and retry.' } }));
                    ws.close();
                    break;
                  }
                  if (enrolled) {
                    if (!message.data.deviceSignature && !enrolled.revoked) {
                      if (this.stopping || socketClosed || !admission.active() || ws.readyState !== WebSocket.OPEN) break;
                      const nonce = this.deviceAuth.challenge(ws, requestedId);
                      ws.send(JSON.stringify({ type: 'device_challenge', data: { nonce } }));
                      if (challengeTimer) clearTimeout(challengeTimer);
                      challengeTimer = setTimeout(() => ws.close(), 15_000);
                      break;
                    }
                    const proof = await this.deviceAuth.verify(ws, requestedId, message.data.deviceSignature);
                    if (!proof || (await this.bindingManager.getDeviceBinding(requestedId))?.openId !== proof.openId
                      || !this.deviceAuth.isCurrent(requestedId, proof)) {
                      ws.send(JSON.stringify({ type: 'error', data: { code: 'DEVICE_AUTH_REQUIRED', message: 'Device authentication failed. Approve a new key using remote-cli files enable --rotate.' } }));
                      ws.close();
                      break;
                    }
                    authenticatedOwner = proof.openId;
                  }
                  if (this.stopping || socketClosed || !admission.active() || ws.readyState !== WebSocket.OPEN) break;
                  if (!authenticatedOwner) {
                    const current = await this.bindingManager.getDeviceBinding(requestedId);
                    const pending = current?.devices?.some(device => device.deviceId === requestedId && device.requiresDeviceAuth);
                    const enrolledAfterLookup = await this.deviceAuth.get(requestedId);
                    if (this.deviceEnrollments.has(requestedId) || pending || enrolledAfterLookup) {
                      ws.send(JSON.stringify({ type: 'error', data: { code: 'DEVICE_AUTH_REQUIRED', message: 'Device authentication is required. Reconnect and retry.' } }));
                      ws.close();
                      break;
                    }
                  }
                } catch {
                  ws.send(JSON.stringify({ type: 'error', data: { code: 'DEVICE_AUTH_REQUIRED', message: 'Device authentication is unavailable. Ask the Router administrator to check the authentication store.' } }));
                  ws.close();
                  break;
                } finally { authenticationPending = false; }
                // Authentication lookups may outlive the socket or its admission lease.
                if (this.stopping || socketClosed || !admission.active() || ws.readyState !== WebSocket.OPEN) break;
                if (challengeTimer) clearTimeout(challengeTimer);
                // Version check: missing protocolVersion defaults to 1 (current baseline)
                const clientVersion: number = message.data?.protocolVersion ?? 1;
                if (clientVersion < MIN_SUPPORTED_CLI_VERSION) {
                  console.log(`Device ${deviceId} rejected: protocol version ${clientVersion} < minimum ${MIN_SUPPORTED_CLI_VERSION}`);
                  ws.send(JSON.stringify({
                    type: MessageType.ERROR,
                    messageId: message.messageId,
                    timestamp: Date.now(),
                    data: {
                      code: 'PROTOCOL_VERSION_INCOMPATIBLE',
                      message: `CLI protocol version ${clientVersion} is no longer supported. Please upgrade remote-cli to the latest version.`,
                      minimumVersion: MIN_SUPPORTED_CLI_VERSION,
                      currentRouterVersion: PROTOCOL_VERSION,
                    },
                  }));
                  ws.close();
                  break;
                }

                deviceId = requestedId;
                registered = true;
                releaseAdmission();
                this.cancelDeviceImages(deviceId);
                this.approvalCards.disconnect(deviceId);
                this.maintenanceCards.disconnect(deviceId);
                this.settingsCards.disconnect(deviceId);
                if (!this.connectionHub.isCurrentConnection(deviceId, ws)) this.cancelThreadInventories(deviceId);
                if (message.data.capabilities?.queueStarted === true) {
                  this.connectionHub.registerConnection(deviceId, ws, { queueStarted: true });
                } else {
                  this.connectionHub.registerConnection(deviceId, ws);
                }
                console.log(`Device registered: ${deviceId} (protocol v${clientVersion})`);
                this.outputTransfers.disconnect(deviceId); this.outputSessions.delete(deviceId);
                const outputsEnabled = Boolean(this.outputsAvailable && authenticatedOwner && message.data.capabilities?.outputFilesV1 === true);
                if (outputsEnabled) this.outputSessions.set(deviceId, { id: randomUUID(), openId: authenticatedOwner! });
                this.attachmentHintStatus.delete(deviceId);
                this.pendingOutputDevices.delete(deviceId);
                this.readyOutputSessions.delete(deviceId);
                if (message.data.capabilities?.pendingOutputFilesV1 === true) this.pendingOutputDevices.add(deviceId);
                if (message.data.capabilities?.outputAttachmentHintsV1 === true) this.attachmentHintStatus.set(deviceId,
                  !this.fileTransfers.enabled ? 'disabled' : !authenticatedOwner ? 'approval'
                    : message.data.capabilities?.outputFilesV1 !== true ? 'upgrade' : !this.outputsAvailable ? 'unavailable' : 'ready');
                const filesEnabled = Boolean(this.fileTransfers.enabled && authenticatedOwner && message.data.capabilities?.fileTransferV1 === true);
                const enrollmentBinding = this.fileTransfers.enabled && !authenticatedOwner
                  && message.data.capabilities?.automaticFileEnrollmentV1 === true
                  ? await this.bindingManager.getDeviceBinding(requestedId) : null;
                const enrollmentEpoch = enrollmentBinding && this.bindingManager.getCardThreadEpoch(enrollmentBinding.openId, requestedId);
                automaticEnrollmentAuthority = enrollmentBinding && enrollmentEpoch
                  ? Object.freeze({ openId: enrollmentBinding.openId, epoch: enrollmentEpoch }) : undefined;
                automaticEnrollmentEnabled = Boolean(automaticEnrollmentAuthority);
                if (filesEnabled) this.connectionHub.setFileSession(deviceId, { id: randomUUID(), openId: authenticatedOwner! });
                this.fileTransfers.disconnect(deviceId);

                taskRecoveryEnabled = message.data.capabilities?.taskRecovery === true;
                scheduleResultsEnabled = taskRecoveryEnabled && message.data.capabilities?.queueStarted === true
                  && message.data.capabilities?.scheduleResultsV1 === true;
                approvalCardsEnabled = message.data.capabilities?.approvalCards === true;
                updateNoticeEnabled = message.data.capabilities?.updateNotice === true;
                subscriptionInspectionEnabled = message.data.capabilities?.subscriptionInspection === true;
                bankedResetReminderEnabled = subscriptionInspectionEnabled && message.data.capabilities?.bankedResetReminder === true;
                this.maintenanceConnections.set(deviceId, { updateNotice: updateNoticeEnabled,
                  current: () => ws.readyState === WebSocket.OPEN && this.connectionHub.isCurrentConnection(requestedId, ws) });
                streamingContextEnabled = message.data.capabilities?.streamingContext === true;
                activityProgressEnabled = message.data.capabilities?.activityProgress === true;
                delegationProgressEnabled = message.data.capabilities?.delegationProgress === true;
                delegationProgressTextEnabled = delegationProgressEnabled
                  && message.data.capabilities?.delegationProgressText === true;
                workerContextResetEnabled = delegationProgressEnabled && message.data.capabilities?.workerContextReset === true;
                if (workerContextResetEnabled) this.workerContextConnections.set(deviceId,
                  () => ws.readyState === WebSocket.OPEN && this.connectionHub.isCurrentConnection(requestedId, ws));
                else this.workerContextConnections.delete(deviceId);
                // Settings cards are negotiated only when the CLI requests them;
                // old peers keep plain text output and never see the capability.
                settingsCardsEnabled = message.data.capabilities?.settingsCards === true;
                modelSpeedSettingsEnabled = settingsCardsEnabled && message.data.capabilities?.modelSpeedSettings === true;
                directoryCardsEnabled = settingsCardsEnabled && message.data.capabilities?.directoryCards === true;
                delegationCardsEnabled = settingsCardsEnabled && message.data.capabilities?.delegationCards === true;
                if (settingsCardsEnabled) this.settingsConnections.set(deviceId,
                  kind => ws.readyState === WebSocket.OPEN && this.connectionHub.isCurrentConnection(requestedId, ws)
                    && (kind !== 'delegation' || delegationCardsEnabled) && (kind !== 'directory' || directoryCardsEnabled)
                    && (kind !== 'speed' || modelSpeedSettingsEnabled));
                else this.settingsConnections.delete(deviceId);
                // Send confirmation with version info for client-side version check
                ws.send(JSON.stringify({
                  type: MessageType.BINDING_CONFIRM,
                  messageId: message.messageId,
                  timestamp: Date.now(),
                  data: {
                    success: true,
                    routerVersion: ROUTER_VERSION,
                    minCliVersion: MIN_SUPPORTED_CLI_VERSION,
                    ...((taskRecoveryEnabled || approvalCardsEnabled || delegationProgressEnabled || streamingContextEnabled || activityProgressEnabled || filesEnabled || outputsEnabled || updateNoticeEnabled || subscriptionInspectionEnabled || settingsCardsEnabled || automaticEnrollmentEnabled || message.data.capabilities?.outputAttachmentHintsV1 === true) ? { capabilities: {
                      ...(automaticEnrollmentEnabled ? { automaticFileEnrollmentV1: true } : {}),
                      ...(activityProgressEnabled ? { activityProgress: true } : {}),
                      ...(updateNoticeEnabled ? { updateNotice: true } : {}),
                      ...(subscriptionInspectionEnabled ? { subscriptionInspection: true } : {}),
                      ...(bankedResetReminderEnabled ? { bankedResetReminder: true } : {}),
                      ...(filesEnabled ? { fileTransferV1: true } : {}),
                      ...(message.data.capabilities?.outputAttachmentHintsV1 === true ? { outputAttachmentHintsV1: true } : {}),
                      ...(message.data.capabilities?.pendingOutputFilesV1 === true ? { pendingOutputFilesV1: true } : {}),
                      ...(outputsEnabled ? { outputFilesV1: true } : {}),
                      ...(taskRecoveryEnabled ? { taskRecovery: true } : {}),
                      ...(scheduleResultsEnabled ? { scheduleResultsV1: true } : {}),
                      ...(approvalCardsEnabled ? { approvalCards: true } : {}),
                      ...(delegationProgressEnabled ? { delegationProgress: true } : {}),
                      ...(delegationProgressTextEnabled ? { delegationProgressText: true } : {}),
                      ...(workerContextResetEnabled ? { workerContextReset: true } : {}),
                      ...(streamingContextEnabled ? { streamingContext: true } : {}),
                      ...(settingsCardsEnabled ? { settingsCards: true } : {}),
                      ...(modelSpeedSettingsEnabled ? { modelSpeedSettings: true } : {}),
                      ...(directoryCardsEnabled ? { directoryCards: true } : {}),
                      ...(delegationCardsEnabled ? { delegationCards: true } : {}),
                    } } : {}),
                  }
                }));
              }
              break;

            case MessageType.HEARTBEAT:
              // Update last active time for the device
              if (deviceId) {
                this.connectionHub.updateLastActive(deviceId);
              }
              // Respond to heartbeat
              ws.send(JSON.stringify({
                type: MessageType.HEARTBEAT,
                messageId: message.messageId,
                timestamp: Date.now(),
                data: {}
              }));
              break;

            case MessageType.RESPONSE:
              deliveryEvent('task_result_received', { task: taskCorrelation(message.messageId), connectionEpoch });
              const scheduledSession = this.streamingMessages.get(message.messageId);
              if (scheduledSession?.queueStarted?.source === 'schedule') {
                if (!scheduleResultsEnabled || message.threadId !== scheduledSession.threadId
                  || message.cwd !== scheduledSession.cwd || message.queueConfirmation || message.data?.queueConfirmation
                  || (message.queueStarted && (message.queueStarted.scheduleId !== scheduledSession.queueStarted.scheduleId
                    || message.queueStarted.backend !== scheduledSession.queueStarted.backend))) break;
              } else if (message.queueStarted?.source === 'schedule'
                && !(deviceId && this.isCompletedTask(message.messageId, deviceId))) {
                // A rejected/missing start must not fall through to an unthreaded plain response.
                break;
              }
              if (taskRecoveryEnabled && deviceId && this.isCompletedTask(message.messageId, deviceId)) {
                ws.send(JSON.stringify({ type: 'task_result_ack', messageId: message.messageId, timestamp: Date.now() }));
                deliveryEvent('result_ack_send', { task: taskCorrelation(message.messageId), connectionEpoch, acceptedLocally: true, duplicate: true });
                break;
              }
              // Device sends response to command - forward to Feishu via long connection
              const responseOpenId = message.openId || message.data?.openId;
              const responseMessageId = message.messageId;
              const sessionAbbr = message.sessionAbbr || message.data?.sessionAbbr;
              const cwd = message.cwd || message.data?.cwd || this.streamingMessages.get(message.messageId)?.queueStarted?.cwd
                || this.streamingMessages.get(message.messageId)?.recoveryCwd
                || this.streamingMessages.get(message.messageId)?.cwd;
              const responseThreadId = message.threadId || message.data?.threadId;
              const responseThreads: ThreadSummary[] | undefined = message.threads || message.data?.threads;
              const queueConfirmation: QueueConfirmationInfo | undefined = message.queueConfirmation || message.data?.queueConfirmation;
              const executionMetadata = parseExecutionMetadata(message.executionMetadata ?? message.data?.executionMetadata);
              // Interactive settings menus only from a capable CLI on this connection;
              // the menu is bound to the original streaming session, never to a
              // user-supplied thread.
              const candidateSettingsMenu = settingsCardsEnabled && deviceId && !queueConfirmation
                ? (message.settingsMenu ?? message.data?.settingsMenu)
                : undefined;
              const settingsMenu = (candidateSettingsMenu?.kind === 'delegation' && !delegationCardsEnabled)
                || (candidateSettingsMenu?.kind === 'directory' && !directoryCardsEnabled) ? undefined : candidateSettingsMenu;

              const responseSession = responseMessageId ? this.streamingMessages.get(responseMessageId) : undefined;
              const responseSuccess = message.success ?? message.data?.success;
              let selectionWarning: string | undefined;
              if (responseSession) {
                if (responseThreadId) {
                  if (responseSession.feishuMessageId && responseSession.threadId !== responseThreadId) {
                    responseSession.threadId = responseThreadId;
                    await this.registerCardThread(responseSession.feishuMessageId, { threadId: responseThreadId, deviceId: responseSession.deviceId, openId: responseSession.openId, epoch: responseSession.selectionFence?.epoch ?? this.selections.capture(responseSession.openId, responseSession.deviceId).epoch, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS },
                      () => this.streamingMessages.get(responseMessageId) === responseSession && imageCurrent());
                  }
                  if (responseThreads) {
                    const match = responseThreads.find(t => t.id === responseThreadId);
                    if (match) responseSession.threadName = match.name;
                  }
                }
                if (responseThreads) responseSession.threads = responseThreads;

                if (responseSuccess === true && responseSession.pendingNewThread && responseSession.newThreadIntent) {
                  const newThread = responseThreadId && isCompleteThreadCatalog(responseThreads)
                    ? responseThreads.find(t => t.id === responseThreadId)
                    : undefined;
                  if (newThread) {
                    try {
                      await this.selections.completeNew(responseSession.newThreadIntent, newThread.id, imageCurrent);
                    } catch {
                      selectionWarning = 'Thread created, but its selection was not saved. Reply to the new thread card or select it explicitly.';
                    }
                  } else {
                    selectionWarning = 'Thread created, but its selection could not be confirmed. Reply to the new thread card or select it explicitly.';
                  }
                }
                if (responseThreads && responseSession.selectionFence) {
                  await this.selections.observeCatalog(responseSession.openId, responseSession.deviceId,
                    responseSession.selectionFence, responseThreads, imageCurrent);
                }
                const responseError = message.error ?? message.data?.error;
                if (responseSuccess === false && !responseThreadId && !responseThreads && responseSession.threadId
                  && responseSession.selectionFence && responseError === `Thread not found: ${responseSession.threadId}`) {
                  await this.selections.handleMissingThread(responseSession.openId, responseSession.deviceId,
                    responseSession.selectionFence, responseSession.threadId, imageCurrent);
                }
              }
              const hints = this.attachmentHintStatus.has(deviceId!) && parseAttachmentHints(message.attachmentHints);
              if (hints && responseSession?.deviceId === deviceId && responseThreadId === responseSession.threadId) {
                await this.admitInlineParent(responseMessageId).catch(() => {});
                await this.inlineFileCards.hints(deviceId!, { ...hints, messageId: responseMessageId, threadId: responseThreadId }, this.attachmentHintStatus.get(deviceId!)!).catch(() => {});
              }
              if (responseMessageId && responseOpenId) {
                // Check if this was a streaming message (stream chunks were sent)
                if (this.streamingMessages.has(responseMessageId)) {
                  const delivered = await this.finalizeStreamingMessage(
                    responseMessageId,
                    message.success ?? message.data?.success,
                    message.output || message.data?.output,
                    message.error || message.data?.error,
                    sessionAbbr,
                    cwd,
                    queueConfirmation,
                    executionMetadata,
                    settingsMenu,
                  );
                  if (scheduledSession?.queueStarted?.source === 'schedule' && !delivered) break;
                } else {
                  // No streaming session found - session should have been created when command was sent
                  // This might happen if there was an error. Just send the result as plain text.
                  const output = message.output || message.data?.output;
                  const success = message.success ?? message.data?.success;
                  const errorMsg = message.error || message.data?.error;

                  if (success) {
                    const delivered = await this.feishuLongConnHandler.sendMessage(
                      responseOpenId,
                      output || '✅ Command completed successfully'
                    );
                    if (delivered === false) throw new Error('Failed to deliver task result');
                  } else {
                    const delivered = await this.feishuLongConnHandler.sendMessage(
                      responseOpenId,
                      `❌ Command failed:\n${errorMsg || 'Unknown error'}`
                    );
                    if (delivered === false) throw new Error('Failed to deliver task result');
                  }
                }
              }
              if (selectionWarning) {
                await this.feishuLongConnHandler.sendMessage(responseOpenId, selectionWarning);
              }
              if (taskRecoveryEnabled && deviceId && this.connectionHub.isCurrentConnection(deviceId, ws)
                && responseOpenId && responseMessageId && !queueConfirmation
                && typeof (message.success ?? message.data?.success) === 'boolean') {
                this.rememberCompletedTask(responseMessageId, deviceId);
                if (this.connectionHub.isCurrentConnection(deviceId, ws)) {
                  ws.send(JSON.stringify({ type: 'task_result_ack', messageId: responseMessageId, timestamp: Date.now() }));
                  deliveryEvent('result_ack_send', { task: taskCorrelation(responseMessageId), connectionEpoch, acceptedLocally: true, duplicate: false });
                }
              }
              break;

            case 'stream_context':
              if (streamingContextEnabled) await this.handleStreamContext(message, deviceId);
              break;

            case 'stream':
              // Handle streaming output from device
              if (message.messageId && message.openId) {
                const streamType = message.streamType || 'text';

                switch (streamType) {
                  case 'activity':
                    if (activityProgressEnabled && this.matchesActivityStream(message, deviceId)) {
                      await this.handleActivityProgress(message);
                    }
                    break;
                  case 'text': {
                    const update = this.handleTextChunk(message.messageId, message.openId, message.chunk || '');
                    if (this.startedQueueMessages.has(message.messageId)) {
                      // Text is accumulated synchronously. Let subsequent deltas
                      // coalesce while the card patch runs; finalization still
                      // waits for updateInFlight before rendering the result.
                      void update.catch(error => deliveryEvent('queued_text_failed', safeCardError(error)));
                    } else {
                      await update;
                    }
                    break;
                  }
                  case 'tool_use':
                    if (message.toolUse) {
                      await this.handleToolUse(message.messageId, message.openId, message.toolUse);
                    }
                    break;
                  case 'tool_result':
                    if (message.toolResult) {
                      await this.handleToolResult(message.messageId, message.openId, message.toolResult);
                    }
                    break;
                  case 'delegation_progress':
                    if (delegationProgressEnabled && message.delegationProgress) {
                      if (activityProgressEnabled && !this.matchesActivityStream(message, deviceId)) break;
                      await this.handleDelegationProgress(message.messageId, message.openId, message.delegationProgress,
                        delegationProgressTextEnabled, workerContextResetEnabled ? deviceId ?? undefined : undefined,
                        activityProgressEnabled);
                    }
                    break;
                  case 'redacted_thinking':
                    await this.handleRedactedThinking(message.messageId, message.openId);
                    break;
                  case 'plan_mode':
                    if (message.planContent !== undefined) {
                      await this.handlePlanMode(message.messageId, message.openId, message.planContent);
                    }
                    break;
                }
              }
              break;

            case MessageType.NOTIFICATION:
              // Handle notification from device - only forward actionable notifications
              // that require user intervention (authorization, input required)
              if (message.openId && message.title && message.message) {
                const actionablePrefixes = ['🔒', '⌨️']; // Authorization Required, Waiting for Input
                const isActionable = actionablePrefixes.some(prefix => message.title.startsWith(prefix));

                if (isActionable) {
                  console.log(`[RouterServer] Forwarding actionable notification to ${message.openId}: ${message.title}`);
                  await this.feishuLongConnHandler.sendMessage(
                    message.openId,
                    `**${message.title}**\n\n${message.message}`
                  );
                } else {
                  // Log non-actionable notifications but don't forward to user
                  console.log(`[RouterServer] Ignoring notification (non-actionable): ${message.title}`);
                }
              }
              break;

            default:
              console.log('Unknown message type:', message.type);
          }
        } catch (error) {
          deliveryEvent('router_message_failed', { connectionEpoch, ...safeCardError(error) });
        } finally {
          finishQueueMessage?.();
        }
      });

      // Control frames also consume the pending connection budget.
      for (const event of ['ping', 'pong'] as const) ws.on(event, (data: Buffer) => {
        if (!registered && (data.byteLength > INGRESS_LIMITS.preauthBytes
            || !admission.active() || (!observesWire && !admission.receive(data.byteLength)))) { releaseAdmission(); ws.terminate(); }
      });

      // Handle connection close
      ws.on('close', (code: number, reason: Buffer) => {
        deliveryEvent('socket_close', { connectionEpoch, code, reasonBytes: reason?.length, registered });
        socketClosed = true;
        releaseAdmission();
        for (const [id, route] of this.imageReplies) {
          if (!route.current()) this.cancelImageReply(id);
        }
        if (challengeTimer) clearTimeout(challengeTimer);
        if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
        if (deviceId && this.connectionHub.unregisterConnection(deviceId, ws)) {
          this.fileTransfers.disconnect(deviceId);
          this.outputTransfers.disconnect(deviceId); this.outputSessions.delete(deviceId); this.attachmentHintStatus.delete(deviceId); this.pendingOutputDevices.delete(deviceId); this.readyOutputSessions.delete(deviceId);
          // Clean up any streaming sessions for this device
          this.approvalCards.disconnect(deviceId);
          this.maintenanceCards.disconnect(deviceId);
          this.settingsCards.disconnect(deviceId);
          this.settingsConnections.delete(deviceId);
          this.maintenanceConnections.delete(deviceId);
          this.workerContextConnections.delete(deviceId);
          void this.cleanupStreamingSessionsForDevice(deviceId).catch(() => console.error('Failed to expire disconnected streaming cards.'));
          deliveryEvent('registered_socket_removed', { connectionEpoch });
        }
      });

      // Handle errors
      ws.on('error', (error) => {
        socketClosed = true;
        releaseAdmission();
        if (challengeTimer) clearTimeout(challengeTimer);
        if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
        // Receiver errors start a bounded ws close handshake before emitting error.
        // Preserve its close frame (for example 1009) for registered connections.
        if (!registered || (ws.readyState !== WebSocket.CLOSING && ws.readyState !== WebSocket.CLOSED)) {
          ws.terminate();
        }
        deliveryEvent('socket_error', { connectionEpoch, ...safeCardError(error) });
      });
    });

    console.log('WebSocket server listening on /ws');
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    await this.fileTransfers.initialize();
    if (this.fileTransfers.enabled) {
      try { await this.outputTransfers.initialize(); this.outputsAvailable = true; }
      catch { console.error('[OutputFiles] Receipt storage unavailable; output transfers are disabled.'); }
    }
    const port = this.config.get('server', 'port');
    const host = this.config.get('server', 'host');

    // Create HTTP server
    this.httpServer = this.app.listen(port, host);
    this.httpServer.requestTimeout = 30_000;
    this.httpServer.headersTimeout = 15_000;

    // Setup WebSocket server
    this.setupWebSocket(this.httpServer);

    // Start Feishu WebSocket long connection
    try {
      await this.feishuLongConnHandler.start();
      this.tips.start();
    } catch (error) {
      console.error('⚠️  Failed to start Feishu long connection:', error);
      console.log('   Server will continue without Feishu integration');
    }

    // Start periodic cleanup of stale connections
    const heartbeatInterval = this.config.get('websocket', 'heartbeatInterval');
    this.cleanupInterval = setInterval(() => {
      // Cleanup connections that haven't sent heartbeat in 3x interval
      this.connectionHub.cleanupStaleConnections(heartbeatInterval * 3);
      // Cleanup stale streaming sessions
      void this.cleanupStaleStreamingSessions().catch(() => console.error('Failed to expire stale streaming cards.'));
    }, heartbeatInterval);

    console.log(`\n🚀 Router server started successfully!`);
    console.log(`   HTTP: http://${host}:${port}`);
    console.log(`   WebSocket: ws://${host}:${port}/ws`);
    console.log(`   Environment: ${this.config.get('server', 'nodeEnv')}`);
    console.log(`\n✅ Ready to receive connections from local clients\n`);
  }

  // Track last update time for each streaming message to enable time-based updates
  private lastStreamUpdateTime: Map<string, number> = new Map();
  private readonly STREAM_UPDATE_INTERVAL_MS = 500; // Update at least every 500ms
  private readonly STREAM_UPDATE_MIN_LENGTH = 10;   // Update every 10 characters

  private async authorizeRecipientOutput(message: any, deviceId: string | null, isCurrent: () => boolean): Promise<boolean> {
    const openId = message.openId || message.data?.openId;
    if (!deviceId || typeof openId !== 'string' || !openId || !isCurrent()) return false;
    const messageId = typeof message.messageId === 'string' && message.messageId ? message.messageId : undefined;
    const originalStream = messageId ? this.streamingMessages.get(messageId) : undefined;
    const originalRoute = messageId ? this.imageReplies.get(messageId) : undefined;
    const binding = await this.bindingManager.getDeviceBinding(deviceId);
    // Registration alone is insufficient: a legacy device can bind or change
    // owners after connecting, and a replacement socket may win during lookup.
    if (!isCurrent() || binding?.openId !== openId) return false;
    if (messageId) {
      if (originalStream && this.streamingMessages.get(messageId) !== originalStream) return false;
      if (originalRoute && this.imageReplies.get(messageId) !== originalRoute) return false;
      const stream = this.streamingMessages.get(messageId);
      if (stream && (stream.deviceId !== deviceId || stream.openId !== openId)) return false;
      const route = this.imageReplies.get(messageId);
      if (route && (route.deviceId !== deviceId || route.openId !== openId)) return false;
      if (stream) stream.currentConnection = isCurrent;
    }
    return true;
  }

  private async canDispatchStreamOutput(messageId: string, stream: StreamingMessageState): Promise<boolean> {
    const current = stream.currentConnection;
    if (this.streamingMessages.get(messageId) !== stream || (current && !current())) return false;
    const binding = await this.bindingManager.getDeviceBinding(stream.deviceId);
    return this.streamingMessages.get(messageId) === stream && binding?.openId === stream.openId
      && (!current || current());
  }

  /** Cancellation is definitive only before the storage FIFO admits the guarded draft. */
  private cancelThreadInventory(id: string, error: Error): void {
    const pending = this.threadInventoryRequests.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.selection?.commitAdmitted) {
      pending.selection.acknowledgedPending = true;
      pending.selection.resolve({ notice: 'The thread selection is still being saved. Do not retry; wait for confirmation or check /thread list after Router recovery.' });
      // Retain the bounded request slot and its completion handler until I/O settles.
      return;
    }
    this.threadInventoryRequests.delete(id);
    pending.selection?.reject(error);
  }

  private cancelThreadInventories(deviceId: string): void {
    for (const [id, pending] of this.threadInventoryRequests) {
      if (pending.deviceId === deviceId) this.cancelThreadInventory(id,
        new Error('Device connection changed. Retry /thread list.'));
    }
  }

  private async sendSelectionOutcome(openId: string, message: string): Promise<void> {
    try { await this.feishuLongConnHandler.sendMessage(openId, message); }
    catch { console.error('Could not deliver the thread selection outcome notice.'); }
  }

  private async handleThreadInventoryResponse(message: any, deviceId: string | null, ws: WebSocket): Promise<void> {
    const pending = this.threadInventoryRequests.get(message.messageId);
    if (!pending || pending.processing || deviceId !== pending.deviceId
      || !this.connectionHub.isCurrentConnection(pending.deviceId, ws)) return;
    pending.processing = true;
    const current = () => !this.stopping && this.threadInventoryRequests.get(message.messageId) === pending
      && this.connectionHub.isCurrentConnection(pending.deviceId, ws) && this.selections.isCurrent(pending.fence);
    try {
      if (pending.selection) {
        const { selection } = pending;
        try {
          if (!current()) throw new Error('This selection was superseded or the device changed.');
          await this.requireCurrentCardDevice(selection.cardId, pending.openId);
          const entry = this.store.getCardThread(selection.cardId);
          const threads = message.status?.threads;
          if (!isCompleteThreadCatalog(threads)) throw new Error('The device returned an invalid thread inventory. Retry /thread list.');
          const target = threads.find(thread => thread.id === selection.threadId);
          if (!target) {
            await this.selections.observeCatalog(pending.openId, pending.deviceId, pending.fence, threads, current);
            throw new Error('This thread no longer exists. Run /thread list for a fresh card.');
          }
          const selected = await this.selections.select(pending.openId, pending.deviceId, target.id, target.name, pending.fence,
            () => current() && !!entry && this.store.getCardThread(selection.cardId) === entry,
            () => { selection.commitAdmitted = true; });
          // A stale post-write guard cannot undo a committed snapshot. Report the
          // historical save without claiming it is still the user's active choice.
          if (selection.commitAdmitted) {
            const notice = `Thread preference was saved: ${target.name}. Check /thread list before sending work if the connection or selection changed.`;
            if (selection.acknowledgedPending) await this.sendSelectionOutcome(pending.openId, notice);
            else if (selected !== 'selected' || !current()) selection.resolve({ notice });
            else selection.resolve(target.name);
          } else {
            if (selected !== 'selected') throw new Error('This selection was superseded or the device changed.');
            selection.resolve(target.name);
          }
        } catch (error) {
          if (selection.acknowledgedPending) await this.sendSelectionOutcome(pending.openId,
            'The thread selection could not be confirmed durably. Do not assume it changed or remained unchanged. Check /thread list after Router storage recovers; no action was replayed.');
          else selection.reject(error instanceof Error ? error : new Error('Could not save the thread selection.'));
        }
        return;
      }
      if (!current()) return;
      const binding = await this.bindingManager.getDeviceBinding(pending.deviceId);
      if (!current() || binding?.openId !== pending.openId) return;
      const threads = message.status?.threads;
      if (!isCompleteThreadCatalog(threads)) {
        await this.feishuLongConnHandler.sendMessage(pending.openId, 'The device returned an invalid thread inventory. Retry /thread list.');
        return;
      }
      const defaultThread = threads.find((thread: ThreadSummary) => thread.name === 'default')!;
      try {
        const reconciled = await this.selections.observeCatalog(pending.openId, pending.deviceId, pending.fence, threads, current);
        if (reconciled === 'stale' || reconciled === 'failed' || !current()) return;
        const cardId = await this.feishuLongConnHandler.sendStreamingStart(pending.openId,
          '🗂️ Thread controls refreshed. Choose a thread for future top-level messages.');
        if (!cardId || !current()) return;
        const finalized = await this.feishuLongConnHandler.finalizeStreamingMessage(cardId, [], undefined,
          pending.openId, undefined, 'Thread selection', threads, defaultThread.id, undefined, undefined, true,
          { onDelivered: async cardIds => {
            for (const deliveredId of cardIds) await this.registerCardThread(deliveredId, {
              threadId: defaultThread.id, deviceId: pending.deviceId, openId: pending.openId,
              epoch: pending.fence.epoch, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS,
            }, current);
          } });
        if (!finalized || !current()) return;
        await this.registerCardThread(cardId, { threadId: defaultThread.id, deviceId: pending.deviceId,
          openId: pending.openId, epoch: pending.fence.epoch, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS }, current);
      } catch {
        if (current()) await this.feishuLongConnHandler.sendMessage(pending.openId, 'Could not create thread controls. Retry /thread list.');
      }
    } finally {
      clearTimeout(pending.timer);
      if (this.threadInventoryRequests.get(message.messageId) === pending) this.threadInventoryRequests.delete(message.messageId);
    }
  }

  private matchesActivityStream(message: any, deviceId: string | null): boolean {
    if (!deviceId || typeof message.messageId !== 'string' || typeof message.openId !== 'string'
      || typeof message.threadId !== 'string' || !message.threadId) return false;
    const stream = this.streamingMessages.get(message.messageId);
    return !!stream && !stream.finalizing && stream.deviceId === deviceId
      && stream.openId === message.openId && stream.threadId === message.threadId;
  }

  private async handleActivityProgress(message: any): Promise<void> {
    const activity = parseActivityProgress(message.activity);
    const stream = this.streamingMessages.get(message.messageId);
    if (!activity || !stream || stream.finalizing) return;
    if (stream.activity?.source === activity.source && stream.activity.text === activity.text) return;
    stream.activity = activity;
    // Display snapshots do not renew stream or worker liveness deadlines.
    await this.updateStreamingText(message.messageId, stream.openId, stream);
  }

  /** Resolve the card header without waiting for backend text or completion. */
  private async handleStreamContext(message: any, deviceId: string | null): Promise<void> {
    const { messageId, openId, threadId, threadName, cwd } = message;
    if (!deviceId || typeof messageId !== 'string' || typeof openId !== 'string'
      || typeof threadId !== 'string' || !threadId || threadId.length > 200
      || typeof threadName !== 'string' || !threadName.trim() || threadName.length > 100
      || typeof cwd !== 'string' || cwd.length > 4096) return;
    const stream = this.streamingMessages.get(messageId);
    if (!stream || stream.finalizing || stream.deviceId !== deviceId || stream.openId !== openId
      || (stream.threadId && stream.threadId !== threadId)) return;
    if (stream.threadId === threadId && stream.threadName === threadName && stream.cwd === cwd) return;
    stream.threadId = threadId;
    stream.threadName = threadName;
    stream.cwd = cwd;
    if (stream.feishuMessageId) {
      await this.registerCardThread(stream.feishuMessageId, {
        threadId, deviceId, openId: stream.openId, epoch: stream.selectionFence?.epoch ?? this.selections.capture(stream.openId, deviceId).epoch, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS,
      }, () => this.streamingMessages.get(messageId) === stream);
      await this.updateStreamingText(messageId, openId, stream);
    }
  }

  /**
   * Handle text streaming chunk
   */
  private async handleTextChunk(messageId: string, openId: string, chunk: string): Promise<void> {
    console.log(`[RouterServer] Received text chunk for ${messageId}, chunk length: ${chunk.length}`);
    const streamData = this.streamingMessages.get(messageId);

    // If no streaming session exists, ignore the chunk
    if (!streamData) {
      console.log(`[RouterServer] No streaming session found for ${messageId}, ignoring chunk`);
      return;
    }
    if (streamData.finalizing || !chunk) return;

    // Accumulate text content
    streamData.currentTextContent += chunk;
    streamData.createdAt = Date.now(); // Update activity timestamp

    // Determine if we should update the card now
    const now = Date.now();
    const lastUpdate = this.lastStreamUpdateTime.get(messageId) || 0;
    const timeSinceLastUpdate = now - lastUpdate;
    const contentLength = streamData.currentTextContent.length;
    const pendingLength = contentLength - streamData.lastRenderedTextLength;

    // Update if:
    // 1. We have a feishuMessageId
    // 2. Either:
    //    a. It's the first content (hasUpdated is false) - show immediately
    //    b. We've accumulated enough characters since last update
    //    c. Enough time has passed since last update
    const shouldUpdate = streamData.feishuMessageId && (
      !streamData.hasUpdated || // First content - always show immediately
      (pendingLength >= this.STREAM_UPDATE_MIN_LENGTH) || // Enough new content
      (timeSinceLastUpdate >= this.STREAM_UPDATE_INTERVAL_MS) // Time-based
    );

    if (shouldUpdate && streamData.feishuMessageId) {
      await this.updateStreamingText(messageId, openId, streamData);
    }
  }

  /**
   * Keep at most one Feishu patch in flight per stream. Token-level backends
   * can emit many tiny deltas while a patch is pending; retain only the newest
   * accumulated state instead of queueing every intermediate card snapshot.
   */
  private async updateStreamingText(
    messageId: string,
    openId: string,
    streamData: StreamingMessageState
  ): Promise<void> {
    if (streamData.updateInFlight) {
      streamData.updatePending = true;
      return;
    }

    const worker = this.runStreamingTextUpdates(messageId, openId, streamData);
    streamData.updateInFlight = worker;
    try {
      await worker;
    } finally {
      if (streamData.updateInFlight === worker) streamData.updateInFlight = undefined;
    }
  }

  private async runStreamingTextUpdates(
    messageId: string,
    openId: string,
    streamData: StreamingMessageState
  ): Promise<void> {
    do {
      streamData.updatePending = false;
      if (streamData.finalizing || this.streamingMessages.get(messageId) !== streamData || !streamData.feishuMessageId) {
        return;
      }

      const elements = [...streamData.elements];
      if (streamData.currentTextContent.trim()) {
        elements.push(...this.renderCurrentText(streamData));
      }

      streamData.lastRenderedTextLength = streamData.currentTextContent.length;
      // A metadata-only patch must not delay the first actual text token.
      if (elements.length > 0) streamData.hasUpdated = true;
      else elements.push(createMarkdownElement('🤔 Processing...'));
      this.lastStreamUpdateTime.set(messageId, Date.now());
      await this.feishuLongConnHandler.updateStreamingMessage(
        streamData.feishuMessageId,
        elements,
        openId,
        streamData.threadName,
        streamData.cwd,
        ...(streamData.activity ? [streamData.activity] as const : [])
      );
    } while (streamData.updatePending);
  }

  /**
   * Handle tool use event
   */
  private async handleToolUse(messageId: string, openId: string, toolUse: ToolUseInfo): Promise<void> {
    console.log(`[RouterServer] Received tool_use for ${messageId}: ${toolUse.name}`);
    const streamData = this.streamingMessages.get(messageId);

    if (!streamData || streamData.finalizing) {
      console.log(`[RouterServer] No streaming session found for ${messageId}`);
      return;
    }

    // Flush current text content to elements if any
    if (streamData.currentTextContent.trim()) {
      streamData.elements.push(...this.renderCurrentText(streamData));
      streamData.currentTextContent = '';
      streamData.recoveryPlainText = false;
      streamData.lastRenderedTextLength = 0;
    }
    streamData.updatePending = false;

    const id = this.toolCallId(toolUse.id);
    let state = id ? streamData.toolCalls.get(id) : undefined;
    // A new start after a received result is another call, even if an adapter
    // reuses its ID. A result-first placeholder can still acquire its identity.
    if (!state || (state.inputElements !== undefined && state.resultElements !== undefined)) {
      state = { elementIndex: streamData.elements.length, id };
      if (id) streamData.toolCalls.set(id, state);
    }
    state.name = typeof toolUse.name === 'string' ? toolUse.name.slice(0, 200) : undefined;
    state.summary = createToolCallSummary(toolUse);
    state.inputElements = createToolUseElement(toolUse);
    streamData.elements[state.elementIndex] = createToolCallElement(state);
    streamData.createdAt = Date.now();

    // Immediately update card to show tool use
    if (streamData.feishuMessageId) {
      await this.feishuLongConnHandler.updateStreamingMessage(
        streamData.feishuMessageId,
        streamData.elements,
        openId,
        streamData.threadName,
        streamData.cwd
      );
      streamData.hasUpdated = true;
    }
  }

  /**
   * Handle tool result event
   */
  private async handleToolResult(messageId: string, openId: string, toolResult: ToolResultInfo): Promise<void> {
    console.log(`[RouterServer] Received tool_result for ${messageId}: ${toolResult.tool_use_id}`);
    const streamData = this.streamingMessages.get(messageId);

    if (!streamData || streamData.finalizing) {
      console.log(`[RouterServer] No streaming session found for ${messageId}`);
      return;
    }

    // Flush current text content to elements if any
    if (streamData.currentTextContent.trim()) {
      streamData.elements.push(...this.renderCurrentText(streamData));
      streamData.currentTextContent = '';
      streamData.recoveryPlainText = false;
      streamData.lastRenderedTextLength = 0;
    }
    streamData.updatePending = false;

    const id = this.toolCallId(toolResult.tool_use_id);
    let state = id ? streamData.toolCalls.get(id) : undefined;
    if (!state) {
      state = { elementIndex: streamData.elements.length, id };
      if (id) streamData.toolCalls.set(id, state);
    }
    state.isError = Boolean(toolResult.is_error);
    state.resultElements = createToolResultElement(toolResult);
    streamData.elements[state.elementIndex] = createToolCallElement(state);
    streamData.createdAt = Date.now();

    // Immediately update card to show tool result
    if (streamData.feishuMessageId) {
      await this.feishuLongConnHandler.updateStreamingMessage(
        streamData.feishuMessageId,
        streamData.elements,
        openId,
        streamData.threadName,
        streamData.cwd
      );
      streamData.hasUpdated = true;
    }
  }

  /** Missing and placeholder IDs cannot safely identify a tool invocation. */
  private toolCallId(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() && value !== 'unknown' && value.length <= 200
      && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : undefined;
  }

  private boundedDelegationProgressText(value: unknown, limit: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    return Array.from(value).slice(0, limit).join('');
  }

  private normalizeDelegationProgress(value: unknown, allowText: boolean, allowActivity = false): DelegationProgressInfo | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const taskId = this.boundedDelegationProgressText(raw.taskId, 200);
    const backend = this.boundedDelegationProgressText(raw.backend, 100);
    if (!taskId || !backend || typeof raw.phase !== 'string' || !DELEGATION_PROGRESS_PHASES.has(raw.phase as DelegationProgressInfo['phase'])) return undefined;
    const activity = allowActivity ? parseActivityProgress(raw.activity) : undefined;
    if (raw.phase === 'text' && !allowText && !activity) return undefined;
    if (allowActivity && raw.phase === 'text' && !activity
      && !(allowText && typeof raw.latestText === 'string' && raw.latestText.trim())) return undefined;

    const toolUseRaw = raw.toolUse;
    const toolUse = toolUseRaw && typeof toolUseRaw === 'object' && !Array.isArray(toolUseRaw)
      ? (() => {
        const tool = toolUseRaw as Record<string, unknown>;
        const name = this.boundedDelegationProgressText(tool.name, 120);
        if (!name) return undefined;
        return { name, id: this.boundedDelegationProgressText(tool.id, 200) ?? '', input: {} };
      })()
      : undefined;
    const toolResultRaw = raw.toolResult;
    const toolResult = toolResultRaw && typeof toolResultRaw === 'object' && !Array.isArray(toolResultRaw)
      ? (() => {
        const result = toolResultRaw as Record<string, unknown>;
        const toolUseId = this.boundedDelegationProgressText(result.tool_use_id, 200);
        if (!toolUseId) return undefined;
        return { tool_use_id: toolUseId, content: '', is_error: result.is_error === true };
      })()
      : undefined;
    const startedAt = typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) && raw.startedAt >= 0
      ? raw.startedAt : undefined;
    const executionMetadata = parseExecutionMetadata(raw.executionMetadata);
    const reference = raw.workerContext as { laneId?: unknown; generation?: unknown } | undefined;
    const workerContext = reference && typeof reference.laneId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference.laneId)
      && Number.isSafeInteger(reference.generation) && (reference.generation as number) >= 0
      ? { laneId: reference.laneId, generation: reference.generation as number } : undefined;
    return {
      taskId,
      backend,
      phase: raw.phase as DelegationProgressInfo['phase'],
      objective: this.boundedDelegationProgressText(raw.objective, 1000),
      toolUse,
      toolResult,
      latestText: allowText || raw.phase !== 'text' ? this.boundedDelegationProgressText(raw.latestText, 1200) : undefined,
      ...(activity ? { activity } : {}),
      ...(allowActivity && typeof raw.waitingForInput === 'boolean' ? { waitingForInput: raw.waitingForInput } : {}),
      summary: this.boundedDelegationProgressText(raw.summary, DELEGATION_RESULT_SUMMARY_LIMIT),
      error: this.boundedDelegationProgressText(raw.error, 4000),
      startedAt,
      ...(executionMetadata?.backend === backend ? { executionMetadata } : {}),
      ...(workerContext ? { workerContext } : {}),
    };
  }

  private appendDelegationProgressEvent(state: DelegationProgressState, label: string, isError = false, toolId?: string): void {
    const existing = toolId ? state.events.find(event => event.toolId === toolId) : undefined;
    if (existing) {
      existing.label = label;
      existing.isError = isError;
      return;
    }
    state.events.push({ label, ...(isError ? { isError: true } : {}), ...(toolId ? { toolId } : {}) });
    if (state.events.length > DELEGATION_PROGRESS_EVENT_LIMIT) {
      state.events.shift();
      state.hiddenEventCount++;
    }
  }

  private renderDelegationProgress(streamData: StreamingMessageState, state: DelegationProgressState): void {
    streamData.elements.splice(state.elementIndex, DELEGATION_PROGRESS_ELEMENT_COUNT, ...createDelegationProgressElements(state));
  }

  private clearDelegationProgressHeartbeat(state: DelegationProgressState): void {
    if (!state.heartbeatTimer) return;
    clearTimeout(state.heartbeatTimer);
    state.heartbeatTimer = undefined;
  }

  private clearDelegationProgressTimers(streamData: StreamingMessageState): void {
    for (const state of streamData.delegationProgress.values()) {
      this.clearDelegationProgressHeartbeat(state);
    }
  }

  private isLiveDelegationProgress(
    messageId: string,
    streamData: StreamingMessageState,
    state: DelegationProgressState,
  ): boolean {
    return this.streamingMessages.get(messageId) === streamData
      && !streamData.finalizing
      && !!streamData.feishuMessageId
      && !state.terminal
      && streamData.delegationProgress.get(state.taskId) === state;
  }

  /** Refresh elapsed time on an active nested worker panel without extending stream liveness. */
  private scheduleDelegationProgressHeartbeat(
    messageId: string,
    streamData: StreamingMessageState,
    state: DelegationProgressState,
  ): void {
    if (!this.isLiveDelegationProgress(messageId, streamData, state) || state.heartbeatTimer) return;
    const timer = setTimeout(() => {
      void (async () => {
        if (state.heartbeatTimer !== timer) return;
        state.heartbeatTimer = undefined;
        if (!this.isLiveDelegationProgress(messageId, streamData, state)) return;
        this.renderDelegationProgress(streamData, state);
        try {
          await this.updateStreamingText(messageId, streamData.openId, streamData);
        } catch (error) {
          deliveryEvent('worker_progress_failed', safeCardError(error));
        } finally {
          if (this.isLiveDelegationProgress(messageId, streamData, state)) {
            this.scheduleDelegationProgressHeartbeat(messageId, streamData, state);
          }
        }
      })();
    }, this.DELEGATION_PROGRESS_HEARTBEAT_MS);
    timer.unref?.();
    state.heartbeatTimer = timer;
  }

  private updateCurrentDelegationTool(state: DelegationProgressState): void {
    const activeId = [...state.activeToolIds].at(-1);
    state.currentToolName = activeId ? state.toolNames.get(activeId) : undefined;
    state.currentToolStartedAt = activeId ? state.toolStartedAt.get(activeId) : undefined;
  }

  /** Update one bounded, nested worker panel rather than flattening child tool cards. */
  private async handleDelegationProgress(messageId: string, openId: string, value: unknown, allowText = false,
    contextDeviceId?: string, allowActivity = false): Promise<void> {
    const progress = this.normalizeDelegationProgress(value, allowText, allowActivity);
    if (!progress) {
      console.log(`[RouterServer] Ignoring malformed delegation progress for ${messageId}`);
      return;
    }
    const streamData = this.streamingMessages.get(messageId);
    if (!streamData || streamData.finalizing) return;

    let state = streamData.delegationProgress.get(progress.taskId);
    if (state?.backend !== undefined && state.backend !== progress.backend) {
      console.log(`[RouterServer] Ignoring delegated progress with inconsistent backend for ${progress.taskId}`);
      return;
    }
    if (state?.terminal) return;
    if (allowActivity && state?.phase === 'waiting_input' && progress.phase === 'text'
      && progress.waitingForInput !== false) return;

    if (!state) {
      if (streamData.currentTextContent.trim()) {
        streamData.elements.push(...this.renderCurrentText(streamData));
        streamData.currentTextContent = '';
        streamData.recoveryPlainText = false;
        streamData.lastRenderedTextLength = 0;
      }
      state = {
        taskId: progress.taskId,
        backend: progress.backend,
        phase: 'started',
        startedAt: progress.startedAt ?? Date.now(),
        ordinal: streamData.delegationProgress.size + 1,
        objective: progress.objective,
        activeToolCount: 0,
        events: [],
        hiddenEventCount: 0,
        activeToolIds: new Set(),
        toolNames: new Map(),
        toolStartedAt: new Map(),
        terminal: false,
        elementIndex: streamData.elements.length + 1,
      };
      streamData.delegationProgress.set(progress.taskId, state);
      streamData.elements.push(createDividerElement(), ...createDelegationProgressElements(state));
    }

    if (!state.objective && progress.objective) state.objective = progress.objective;
    if (DELEGATION_PROGRESS_TERMINAL_PHASES.has(progress.phase) && progress.workerContext && contextDeviceId
      && streamData.deviceId === contextDeviceId && streamData.openId === openId && streamData.threadId) {
      state.contextActionId = this.workerContextCards.register({ openId, deviceId: contextDeviceId,
        threadId: streamData.threadId, ...progress.workerContext });
    }
    if (progress.executionMetadata) state.executionMetadata = progress.executionMetadata;
    if (progress.activity) state.activity = progress.activity;
    if (progress.phase === 'waiting_input') state.inputRequest = progress.summary;
    else state.inputRequest = undefined;
    if (progress.phase !== 'waiting_input' && progress.summary !== undefined) state.summary = progress.summary;
    if (progress.error !== undefined) state.error = progress.error;
    if (progress.phase !== 'text' || state.activeToolIds.size === 0) state.phase = progress.phase;
    if (progress.phase !== 'text' || progress.latestText || progress.activity) state.lastActivityAt = Date.now();

    switch (progress.phase) {
      case 'started':
        this.appendDelegationProgressEvent(state, 'Worker session started');
        break;
      case 'text':
        if (progress.latestText) state.latestText = progress.latestText;
        break;
      case 'tool_use': {
        const tool = progress.toolUse;
        const name = tool?.name || 'Tool';
        const now = Date.now();
        if (tool?.id) {
          state.activeToolIds.add(tool.id);
          state.toolNames.set(tool.id, name);
          state.toolStartedAt.set(tool.id, now);
        }
        state.currentToolName = name;
        state.currentToolStartedAt = now;
        state.lastToolActivityAt = now;
        this.appendDelegationProgressEvent(state, `${name} running`, false, tool?.id);
        break;
      }
      case 'tool_result': {
        const result = progress.toolResult;
        const name = result?.tool_use_id ? state.toolNames.get(result.tool_use_id) ?? 'Tool' : 'Tool';
        const startedAt = result?.tool_use_id ? state.toolStartedAt.get(result.tool_use_id) : undefined;
        const elapsed = startedAt === undefined ? '' : ` · ${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s`;
        if (result?.is_error && !state.events.some(event => event.toolId === result.tool_use_id && event.isError)) {
          state.toolErrorCount = (state.toolErrorCount ?? 0) + 1;
        }
        if (result?.tool_use_id) {
          state.activeToolIds.delete(result.tool_use_id);
          state.toolNames.delete(result.tool_use_id);
          state.toolStartedAt.delete(result.tool_use_id);
        }
        state.lastToolActivityAt = Date.now();
        this.updateCurrentDelegationTool(state);
        this.appendDelegationProgressEvent(state, `${name} ${result?.is_error ? 'failed' : 'completed'}${elapsed}`, result?.is_error === true, result?.tool_use_id);
        break;
      }
      case 'waiting_input':
        state.activeToolIds.clear();
        state.toolNames.clear();
        state.toolStartedAt.clear();
        state.currentToolName = undefined;
        state.currentToolStartedAt = undefined;
        this.appendDelegationProgressEvent(state, 'Waiting for user input');
        break;
      default:
        if (DELEGATION_PROGRESS_TERMINAL_PHASES.has(progress.phase)) {
          state.activeToolIds.clear();
          state.toolNames.clear();
          state.toolStartedAt.clear();
          state.currentToolName = undefined;
          state.currentToolStartedAt = undefined;
          state.finishedAt = Date.now();
          state.terminal = true;
          this.clearDelegationProgressHeartbeat(state);
          this.appendDelegationProgressEvent(state, `Worker ${progress.phase.replace('_', ' ')}`, progress.phase !== 'succeeded');
        }
        break;
    }
    state.activeToolCount = state.activeToolIds.size;
    this.renderDelegationProgress(streamData, state);
    if (progress.phase !== 'text' || progress.latestText) streamData.createdAt = Date.now();

    try {
      if (streamData.feishuMessageId) await this.updateStreamingText(messageId, openId, streamData);
    } finally {
      if (!state.terminal) this.scheduleDelegationProgressHeartbeat(messageId, streamData, state);
    }
  }

  /**
   * Handle redacted thinking event
   * This occurs when AI reasoning is filtered by safety systems (Claude 3.7 Sonnet, Gemini)
   */
  private async handleRedactedThinking(messageId: string, openId: string): Promise<void> {
    console.log(`[RouterServer] Received redacted_thinking for ${messageId}`);

    const streamData = this.streamingMessages.get(messageId);
    if (!streamData || streamData.finalizing) {
      console.log(`[RouterServer] No streaming session found for ${messageId}`);
      return;
    }

    // Flush current text content to elements if any
    if (streamData.currentTextContent.trim()) {
      streamData.elements.push(...this.renderCurrentText(streamData));
      streamData.currentTextContent = '';
      streamData.recoveryPlainText = false;
      streamData.lastRenderedTextLength = 0;
    }
    streamData.updatePending = false;

    // Add redacted thinking notification elements
    const redactedThinkingElements = createRedactedThinkingElement();
    streamData.elements.push(...redactedThinkingElements);
    streamData.createdAt = Date.now();

    // Immediately update card to show redacted thinking notification
    if (streamData.feishuMessageId) {
      await this.feishuLongConnHandler.updateStreamingMessage(
        streamData.feishuMessageId,
        streamData.elements,
        openId,
        streamData.threadName,
        streamData.cwd
      );
      streamData.hasUpdated = true;
    }
  }

  /**
   * Handle plan mode event
   * Fired when Claude completes its plan between EnterPlanMode and ExitPlanMode.
   * Execution is auto-approved; this handler renders the plan for user visibility.
   */
  private async handlePlanMode(messageId: string, openId: string, planContent: string): Promise<void> {
    console.log(`[RouterServer] Received plan_mode for ${messageId}, plan length=${planContent.length}`);

    const streamData = this.streamingMessages.get(messageId);
    if (!streamData || streamData.finalizing) {
      console.log(`[RouterServer] No streaming session found for ${messageId}`);
      return;
    }

    // Flush current text content (the plan text was already streamed inline,
    // so we reset the text buffer to avoid duplication in the card)
    streamData.currentTextContent = '';
    streamData.lastRenderedTextLength = 0;
    streamData.updatePending = false;

    // Add plan mode elements (collapsible panel showing the plan)
    const planModeElements = createPlanModeElement(planContent);
    streamData.elements.push(...planModeElements);
    streamData.createdAt = Date.now();

    // Immediately update card to show the plan section
    if (streamData.feishuMessageId) {
      await this.feishuLongConnHandler.updateStreamingMessage(
        streamData.feishuMessageId,
        streamData.elements,
        openId,
        streamData.threadName,
        streamData.cwd
      );
      streamData.hasUpdated = true;
    }
  }

  /** Response receipt closes admission; accepted jobs consult the mutable deadline. */
  private closeImageIntake(stream: StreamingMessageState, deadline = Date.now() + IMAGE_LIMITS.drainMs): void {
    stream.imageIntakeClosed = true;
    stream.imageDrainDeadline ??= deadline;
  }

  private cancelImageReply(messageId: string): void {
    const route = this.imageReplies.get(messageId);
    if (route) {
      const stream = this.streamingMessages.get(messageId);
      if (stream && stream === route.stream) {
        stream.imageAttempts = route.reply.attempts;
        stream.imageHashes = route.reply.hashes;
      }
      this.images.cancel(route.reply);
    }
    this.imageReplies.delete(messageId);
  }

  private cancelDeviceImages(deviceId: string): void {
    for (const [id, route] of this.imageReplies) if (route.deviceId === deviceId) this.cancelImageReply(id);
  }

  private prepareImageReply(messageId: string, openId: string, deviceId: string, current: () => boolean,
    threadId?: string, pendingCard = false) {
    if (typeof messageId !== 'string' || !messageId || messageId.length > 200
      || typeof openId !== 'string' || !openId || openId.length > 200
      || (threadId !== undefined && (typeof threadId !== 'string' || threadId.length > 200))) return;
    const stream = this.streamingMessages.get(messageId);
    if (stream && (stream.openId !== openId || stream.deviceId !== deviceId
      || (stream.threadId && threadId && stream.threadId !== threadId))) return;
    const existing = this.imageReplies.get(messageId);
    if (existing) {
      if (existing.openId !== openId || existing.deviceId !== deviceId
        || (existing.threadId && threadId && existing.threadId !== threadId)) return;
      return existing;
    }
    if ((!stream && !pendingCard) || stream?.finalizing || stream?.imageIntakeClosed
      || this.isCompletedTask(messageId, deviceId) || this.imageReplies.size >= 1024) return;
    const reply = this.images.createReply();
    reply.attempts = stream?.imageAttempts ?? 0;
    reply.hashes = stream?.imageHashes ?? new Set();
    const route = { reply, openId, deviceId, threadId, current,
      stream: pendingCard ? undefined : stream, createdAt: Date.now() };
    this.imageReplies.set(messageId, route);
    return route;
  }

  private noteImageFailure(messageId: string, stream: StreamingMessageState): void {
    if (stream.imageFailureHinted || stream.finalizing || this.streamingMessages.get(messageId) !== stream) return;
    stream.imageFailureHinted = true;
    stream.elements.push(createMarkdownElement('⚠️ Generated image could not be uploaded to Feishu.'));
    void this.refreshStreamCard(messageId, stream);
  }

  private async refreshStreamCard(messageId: string, stream: StreamingMessageState): Promise<void> {
    try { await this.updateStreamingText(messageId, stream.openId, stream); }
    catch { console.warn('[RouterServer] Could not refresh the image result.'); }
  }

  private handleImage(messageId: string, openId: string, image: ImageBlock, deviceId: string,
    connectionCurrent: () => boolean): Promise<void> {
    const route = this.prepareImageReply(messageId, openId, deviceId, connectionCurrent);
    if (!route || !route.current()) return Promise.resolve();
    const previous = this.queueMessageOperations.get(messageId);
    const current = () => {
      const stream = this.streamingMessages.get(messageId);
      return this.imageReplies.get(messageId) === route && route.current() && !!stream
        && stream === route.stream && !stream.finalizing && stream.openId === route.openId
        && stream.deviceId === route.deviceId;
    };
    const failure = () => {
      if (current()) this.noteImageFailure(messageId, route.stream!);
    };
    return this.images.offer(route.reply, image, previous, {
      current,
      upload: (data, mimeType) => this.feishuLongConnHandler.uploadImage(data, mimeType),
      failure,
      publish: async key => {
        if (!current()) return;
        const stream = route.stream!;
        if (stream.currentTextContent.trim()) {
          stream.elements.push(...this.renderCurrentText(stream));
          stream.currentTextContent = '';
          stream.recoveryPlainText = false;
          stream.lastRenderedTextLength = 0;
        }
        stream.elements.push(createImageElement(key));
        stream.createdAt = Date.now();
        await this.refreshStreamCard(messageId, stream);
      },
    });
  }

  /** Bind pre-card admissions only to the card produced by their original route. */
  private bindImageStream(messageId: string): void {
    const route = this.imageReplies.get(messageId);
    const stream = this.streamingMessages.get(messageId);
    if (!route || !stream || !route.current() || stream.deviceId !== route.deviceId || stream.openId !== route.openId) return;
    route.stream = stream;
    if (route.reply.closed) this.closeImageIntake(stream, route.reply.deadline);
    if (route.reply.failed) this.noteImageFailure(messageId, stream);
  }

  private rememberCompletedTask(messageId: string, deviceId: string): void {
    this.completedTasks.set(messageId, { deviceId, completedAt: Date.now() });
    for (const [id, receipt] of this.completedTasks) {
      if (Date.now() - receipt.completedAt > 24 * 60 * 60 * 1000 || this.completedTasks.size > 1000) {
        this.completedTasks.delete(id);
      }
    }
  }

  private isCompletedTask(messageId: string, deviceId: string): boolean {
    const receipt = this.completedTasks.get(messageId);
    return receipt?.deviceId === deviceId && Date.now() - receipt.completedAt <= 24 * 60 * 60 * 1000;
  }

  /** A resumed segment may start inside a code fence or a table from the old card. */
  private renderCurrentText(stream: StreamingMessageState): FeishuCardElement[] {
    if (!stream.recoveryPlainText) return [createMarkdownElement(stream.currentTextContent)];
    const characters = Array.from(stream.currentTextContent);
    const elements: FeishuCardElement[] = [];
    for (let start = 0; start < characters.length; start += 1000) {
      const text = characters.slice(start, start + 1000).join('')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      elements.push(createMarkdownElement(`<raw>${text}</raw>`));
    }
    return elements;
  }

  /** Restore only task routing and future output; no old transcript is replayed. */
  private async handleTaskResume(message: any, deviceId: string, isCurrent: () => boolean): Promise<boolean> {
    const info = message.taskResume as TaskResumeInfo | undefined;
    const { messageId, openId, threadId } = message;
    if (typeof messageId !== 'string' || !messageId || typeof openId !== 'string' || !openId
      || typeof threadId !== 'string' || !threadId || !info
      || typeof info.recoveryId !== 'string' || !info.recoveryId || info.recoveryId.length > 100
      || typeof info.threadName !== 'string' || info.threadName.length > 100
      || typeof info.backend !== 'string' || info.backend.length > 100
      || typeof info.cwd !== 'string' || info.cwd.length > 4096
      || typeof info.preview !== 'string' || info.preview.length > 240
      || !['running', 'completed', 'failed'].includes(info.state)
      || (info.error !== undefined && (typeof info.error !== 'string' || info.error.length > 500))) return false;
    if (this.isCompletedTask(messageId, deviceId)) return true;
    const selectionFence = this.selections.capture(openId, deviceId);
    const previous = this.streamingMessages.get(messageId);
    if (previous && (previous.deviceId !== deviceId || previous.openId !== openId
      || (previous.threadId && previous.threadId !== threadId))) return false;

    const hints = this.attachmentHintStatus.has(deviceId) && parseAttachmentHints(info.attachmentHints);
    const identity: InlineIdentity = { messageId, openId, deviceId, threadId, epoch: selectionFence.epoch,
      ...(hints ? { generation: hints.generation } : {}) };
    const sourceStatus = this.outputTransfers.identityStatus(identity);
    const inlineCapable = this.outputSessions.has(deviceId) || this.attachmentHintStatus.has(deviceId);
    const parentStatus = inlineCapable ? await this.inlineFileCards.identityStatus(identity).catch(() => 'unavailable' as const) : 'unknown';
    if (!isCurrent() || sourceStatus === 'conflict' || parentStatus === 'conflict') return false;
    // A known empty initialized ledger can establish a new source. Disabled or
    // unavailable byte storage is never initialized just to authorize a hint.
    if (this.outputsAvailable && inlineCapable) await this.outputTransfers.admitSource(identity);
    // A missing journal cannot prove that an existing source was unpublished.
    const holdInline = !inlineCapable || parentStatus === 'unavailable'
      || (sourceStatus === 'match' && parentStatus === 'unknown')
      || (!this.outputsAvailable && parentStatus !== 'match');

    // A failed terminal patch can retry on its own recovery card, but an old
    // finalizing card cannot accept a newly resumed stream.
    const reusable = previous?.feishuMessageId && (!previous.finalizing
      || (previous.recoveryId === info.recoveryId && info.state !== 'running'));
    if (previous && reusable) {
      deliveryEvent('resume_card_reused', { task: taskCorrelation(messageId), card: taskCorrelation(previous.feishuMessageId),
        reason: previous.finalizing ? 'same_recovery_terminal_retry' : 'existing_active_card' });
      if (previous.recoveryId !== info.recoveryId) {
        await previous.updateInFlight;
        if (!isCurrent() || this.streamingMessages.get(messageId) !== previous || previous.finalizing) return false;
        // Seal the old Markdown component before adding the gap notice. Later
        // output may begin inside a lost code fence or table and stays plain.
        if (previous.currentTextContent.trim()) previous.elements.push(...this.renderCurrentText(previous));
        previous.currentTextContent = '';
        previous.elements.push(createMarkdownElement('🔄 **Connection restored** — output during the interruption may be missing.'));
        previous.recoveryPlainText = true;
        previous.lastRenderedTextLength = 0;
        previous.recoveryId = info.recoveryId;
        previous.recoveryCardPending = true;
        previous.recoveryCwd = info.cwd;
        previous.cwd = info.cwd;
        previous.threadId = previous.threadId ?? threadId;
        previous.threadName = previous.threadName ?? info.threadName;
        previous.createdAt = Date.now();
      }
      if (previous.recoveryCardPending) {
        const elements = [...previous.elements];
        if (previous.currentTextContent.trim()) elements.push(...this.renderCurrentText(previous));
        const textLength = previous.currentTextContent.length;
        const updated = await this.feishuLongConnHandler.updateStreamingMessage(
          previous.feishuMessageId!, elements, openId, previous.threadName, previous.cwd
        );
        if (!updated || !isCurrent() || this.streamingMessages.get(messageId) !== previous) return false;
        // Keep the staged recovery notice on failure so the same round can retry
        // without appending a duplicate notice or acknowledging a failed patch.
        previous.recoveryCardPending = false;
        previous.hasUpdated = true;
        previous.lastRenderedTextLength = textLength;
        this.lastStreamUpdateTime.set(messageId, Date.now());
      }
      await this.registerCardThread(previous.feishuMessageId!, { threadId, deviceId, openId, epoch: previous.selectionFence?.epoch ?? this.selections.capture(openId, deviceId).epoch, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS },
        () => isCurrent() && this.streamingMessages.get(messageId) === previous);
    } else {
      const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const intro = `🔄 **${info.state === 'running' ? 'Connection restored — task continues' : 'Task status recovered'}**\n\n`
        + `Output before this card, including output during disconnection, was not retained.\n\n`
        + `**Thread:** <raw>${escape(info.threadName)}</raw> · **Backend:** <raw>${escape(info.backend)}</raw>\n`
        + `**Working directory:** <raw>${escape(info.cwd)}</raw>\n**Task:** <raw>${escape(info.preview)}</raw>`;
      const cardId = await this.feishuLongConnHandler.sendStreamingStart(openId, intro, info.threadName, info.cwd, messageId);
      if (!cardId || !isCurrent()) return false;
      this.feishuLongConnHandler.bindDiagnosticTask?.(cardId, messageId);
      deliveryEvent('resume_card_created', { task: taskCorrelation(messageId), card: taskCorrelation(cardId),
        reason: previous?.finalizing ? 'previous_card_finalizing' : previous ? 'previous_card_missing' : 'no_previous_stream' });
      if (previous) this.clearDelegationProgressTimers(previous);
      this.streamingMessages.set(messageId, {
        openId, deviceId, threadId, threadName: info.threadName, cwd: info.cwd, feishuMessageId: cardId,
        elements: [createMarkdownElement(intro)], currentTextContent: '', hasUpdated: false,
        createdAt: Date.now(), updatePending: false, finalizing: false, lastRenderedTextLength: 0,
        delegationProgress: new Map(),
        toolCalls: new Map(),
        recoveryId: info.recoveryId, recoveryPlainText: true, recoveryCwd: info.cwd, selectionFence,
      });
      await this.registerCardThread(cardId, { threadId, deviceId, openId, epoch: selectionFence.epoch, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS }, isCurrent);
    }
    const recoveredStream = this.streamingMessages.get(messageId);
    if (recoveredStream) recoveredStream.inlineRecoveryHeld = holdInline;
    this.bindImageStream(messageId);
    await this.admitInlineParent(messageId, true).catch(() => {});
    if (hints) await this.inlineFileCards.hints(deviceId, { ...hints, messageId, threadId }, this.attachmentHintStatus.get(deviceId)!).catch(() => {});
    if (info.state !== 'running') {
      await this.finalizeStreamingMessage(messageId, info.state === 'completed', undefined, info.error, undefined, info.cwd,
        undefined, parseExecutionMetadata(info.executionMetadata));
      if (!isCurrent()) return false;
      this.rememberCompletedTask(messageId, deviceId);
    }
    return true;
  }

  /** Validate the additive scheduled-result envelope without changing ordinary queue metadata. */
  private validScheduledResult(message: any): boolean {
    const info = message.queueStarted;
    const bounded = (value: unknown, maximum: number, empty = false) => typeof value === 'string'
      && (empty || value.length > 0) && value.length <= maximum;
    return (message.type === 'queue_started' || message.type === MessageType.RESPONSE)
      && info?.source === 'schedule' && bounded(info.scheduleId, 256)
      && bounded(message.messageId, 256) && bounded(message.openId, 256) && bounded(message.threadId, 256)
      && (info.backend === 'claude' || info.backend === 'dsh') && bounded(info.threadName, 100, true) && bounded(info.cwd, 4096)
      && bounded(info.preview, 240, true) && info.remainingCount === 0
      && message.cwd === info.cwd;
  }

  /** Create a fresh card before accepting any output for a dequeued task. */
  private async handleQueueStarted(message: any, deviceId: string | null, isCurrent = () => true): Promise<void> {
    const info = message.queueStarted as QueueStartedInfo | undefined;
    const { messageId, openId, threadId } = message;
    if (!deviceId || typeof messageId !== 'string' || !messageId
      || typeof openId !== 'string' || !openId || typeof threadId !== 'string' || !threadId
      || !info || typeof info.threadName !== 'string' || typeof info.backend !== 'string'
      || typeof info.cwd !== 'string' || typeof info.preview !== 'string'
      || !Number.isInteger(info.remainingCount) || info.remainingCount < 0) return;
    if (info.source === 'schedule' && this.isCompletedTask(messageId, deviceId)) return;
    const selectionFence = this.selections.capture(openId, deviceId);
    const previous = this.streamingMessages.get(messageId);
    if (previous && (previous.deviceId !== deviceId || previous.openId !== openId
      || (previous.threadId && previous.threadId !== threadId))) return;
    const pending = this.queueMessageOperations.get(messageId);
    if (pending) return pending;
    // Disconnect cleanup removes unfinished sessions. A persisted schedule outbox
    // may recreate those cards; completed results are fenced by the receipt cache above.
    if (this.startedQueueMessages.has(messageId) && (info.source !== 'schedule' || previous?.feishuMessageId)) return;

    this.startedQueueMessages.set(messageId, Date.now());
    this.cancelImageReply(messageId);
    const imageRoute = this.prepareImageReply(messageId, openId, deviceId, isCurrent, threadId, true);
    const operation = Promise.resolve().then(async () => {
      const escape = (value: string) => value.replace(/[\\`*_{}\[\]()<>!#|]/g, '\\$&');
      const intro = info.source === 'schedule'
        ? `🕒 **Scheduled task result**\n\n**Thread:** ${escape(info.threadName)} · **Backend:** ${info.backend}\n**Working directory:** ${escape(info.cwd)}\n**Task:** ${escape(info.preview)}`
        : `▶️ **Queued task started**

**Thread:** ${info.threadName} · **Backend:** ${info.backend}
**Working directory:** \`${info.cwd}\`
**Task:** ${info.preview}
**Remaining in queue:** ${info.remainingCount}`;
      let cardId: string | null = null;
      try {
        cardId = await this.feishuLongConnHandler.sendStreamingStart(openId, intro, info.threadName, info.cwd, messageId);
        if (cardId) this.feishuLongConnHandler.bindDiagnosticTask?.(cardId, messageId);
      } catch (error) {
        deliveryEvent('queued_card_create_failed', { task: taskCorrelation(messageId), ...safeCardError(error) });
      }
      if (!isCurrent() || (imageRoute && this.imageReplies.get(messageId) !== imageRoute)) return;
      const fallbackCardId = previous?.feishuMessageId || previous?.queueCardId || null;
      if (previous && this.streamingMessages.get(messageId) === previous) {
        this.clearDelegationProgressTimers(previous);
      }
      this.streamingMessages.set(messageId, {
        openId,
        deviceId,
        threadId,
        threadName: info.threadName,
        cwd: info.cwd,
        feishuMessageId: cardId || fallbackCardId,
        elements: [createMarkdownElement(intro)],
        currentTextContent: '',
        hasUpdated: false,
        createdAt: Date.now(),
        updatePending: false,
        finalizing: false,
        lastRenderedTextLength: 0,
        delegationProgress: new Map(),
        toolCalls: new Map(),
        queueStarted: info,
        selectionFence,
        threads: Array.isArray(message.threads) ? message.threads : undefined,
      });
      this.bindImageStream(messageId);
      if (cardId || fallbackCardId) {
        await this.registerCardThread((cardId || fallbackCardId)!, {
          threadId, deviceId, openId, epoch: selectionFence.epoch, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS,
        }, isCurrent);
      }
      if (cardId) {
        const oldCards = new Set([previous?.queueCardId, previous?.feishuMessageId]);
        for (const oldCard of oldCards) {
          if (!isCurrent()) return;
          if (!oldCard || oldCard === cardId) continue;
          try {
            await this.feishuLongConnHandler.markQueueCardStarted(oldCard);
          } catch (error) {
            // The new execution card remains usable if its old receipt expired.
            deliveryEvent('queue_receipt_failed', safeCardError(error));
          }
        }
      }
    });
    this.queueMessageOperations.set(messageId, operation);
    try {
      await operation;
    } finally {
      if (this.queueMessageOperations.get(messageId) === operation) {
        this.queueMessageOperations.delete(messageId);
      }
    }
  }

  /** Dispatch only into the exact authenticated session that acknowledged local output readiness. */
  private async drainPendingOutputs(deviceId: string): Promise<void> {
    const session = this.outputSessions.get(deviceId);
    if (!session || this.readyOutputSessions.get(deviceId) !== session.id || !this.pendingOutputDevices.has(deviceId)) return;
    for (const [id, owner] of this.preparedOutputParents) {
      if (owner.deviceId !== deviceId) continue;
      if (session.openId !== owner.openId || !this.selections.isOwnershipCurrent(owner.openId, deviceId, owner.epoch)) {
        this.preparedOutputParents.delete(id); continue;
      }
      // A failed presentation update must not consume the original-task preparation permit.
      await this.inlineFileCards.refresh(id).catch(() => {});
      if (this.outputSessions.get(deviceId)?.id !== session.id || !this.pendingOutputDevices.has(deviceId)
        || this.preparedOutputParents.get(id) !== owner
        || !this.selections.isOwnershipCurrent(owner.openId, deviceId, owner.epoch)) continue;
      const sent = await this.connectionHub.sendToDevice(deviceId, { type: 'prepare_pending_output', messageId: owner.messageId,
        openId: owner.openId, threadId: owner.threadId, generation: owner.generation });
      if (sent && this.preparedOutputParents.get(id) === owner) this.preparedOutputParents.delete(id);
    }
  }

  private async admitInlineParent(messageId: string, replacePending = false): Promise<void> {
    const stream = this.streamingMessages.get(messageId);
    if (!stream?.feishuMessageId || !stream.threadId || stream.inlineRecoveryHeld
      || (!this.outputSessions.has(stream.deviceId) && !this.attachmentHintStatus.has(stream.deviceId))) return;
    const owner = { messageId, rootId: stream.feishuMessageId, openId: stream.openId,
      deviceId: stream.deviceId, threadId: stream.threadId,
      epoch: stream.selectionFence?.epoch ?? this.selections.capture(stream.openId, stream.deviceId).epoch };
    if (this.outputTransfers.identityStatus(owner) === 'conflict') return;
    await this.inlineFileCards.admit(owner, replacePending);
  }

  private async registerDeliveredThreadCards(messageId: string, streamData: StreamingMessageState, cardIds: string[]): Promise<void> {
    if (!streamData.threadId || this.streamingMessages.get(messageId) !== streamData) return;
    const fence = streamData.selectionFence;
    if (streamData.currentConnection && !streamData.currentConnection()) return;
    const epoch = fence?.epoch ?? this.selections.capture(streamData.openId, streamData.deviceId).epoch;
    if (!this.selections.isOwnershipCurrent(streamData.openId, streamData.deviceId, epoch)) return;
    await this.admitInlineParent(messageId).catch(() => {});
    const delivered = cardIds.filter(id => typeof id === 'string' && id.length > 0);
    streamData.deliveredCardIds ??= new Set();
    // Track the whole batch before disk I/O so interruption revokes pending writes too.
    for (const cardId of delivered) streamData.deliveredCardIds.add(cardId);
    for (const cardId of delivered) {
      await this.registerCardThread(cardId, { threadId: streamData.threadId, deviceId: streamData.deviceId,
        openId: streamData.openId, epoch, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS },
        () => this.streamingMessages.get(messageId) === streamData && (!streamData.currentConnection || streamData.currentConnection()));
    }
  }

  private async finalizeStreamingMessage(messageId: string, success: boolean, output?: string, error?: string, sessionAbbr?: string, cwd?: string, queueConfirmation?: QueueConfirmationInfo, executionMetadata?: ExecutionMetadata, settingsMenu?: unknown): Promise<boolean> {
    const streamData = this.streamingMessages.get(messageId);
    if (!streamData) return false;
    const task = taskCorrelation(messageId);
    deliveryEvent('task_finalization_started', { task, card: taskCorrelation(streamData.feishuMessageId) });
    try {

      const route = this.imageReplies.get(messageId);
      if (route) this.images.close(route.reply);
      this.closeImageIntake(streamData, route?.reply.deadline);
      // Snapshot accepted work before awaiting; intake is already closed.
      const accepted = route?.reply.tail;
      if (accepted) await accepted;
      if (this.streamingMessages.get(messageId) !== streamData
        || (route && (this.imageReplies.get(messageId) !== route || !route.current()))) return false;
      if (route?.reply.failed) this.noteImageFailure(messageId, streamData);
      this.cancelImageReply(messageId);
      streamData.finalizing = true;
      streamData.updatePending = false;
      this.clearDelegationProgressTimers(streamData);
      await streamData.updateInFlight;
      if (!await this.canDispatchStreamOutput(messageId, streamData)) return false;

      await this.admitInlineParent(messageId).catch(() => {});
      const { feishuMessageId, openId } = streamData;

      if (feishuMessageId) {
        if (streamData.queueStarted?.source === 'schedule') {
          // Scheduled results have no live stream. Replace the body on retry after a failed PATCH.
          streamData.elements = streamData.elements.slice(0, 1);
          streamData.currentTextContent = output || '';
        }
        // Flush any remaining text content
        if (streamData.currentTextContent.trim()) {
          streamData.elements.push(...this.renderCurrentText(streamData));
          streamData.currentTextContent = '';
          streamData.recoveryPlainText = false;
        }

        // If there are no elements at all, use the output parameter as fallback
        if (streamData.elements.length === 0 && output) {
          streamData.elements.push(createMarkdownElement(output));
        }

        // A capable CLI's settings menu replaces the placeholder with a dedicated
        // interactive card bound to the original user/device/thread/request. The
        // text output is for incapable peers or delivery failure only: including
        // its complete catalog here would defeat pagination and its node/byte budget.
        const prepared = settingsMenu && success
          ? this.settingsCards.present({ openId: streamData.openId, deviceId: streamData.deviceId, menu: settingsMenu, requestMessageId: messageId, expectedThreadId: streamData.threadId })
          : undefined;
        if (prepared) {
          const finalized = await this.feishuLongConnHandler.finalizeStreamingMessage(
            feishuMessageId,
            prepared.elements,
            undefined,
            openId,
            cwd,
            streamData.threadName,
            undefined,
            streamData.threadId,
            undefined,
            undefined,
            true,
            { bare: true, onDelivered: cardIds => prepared.deliver(cardIds) }
          );
          if (!finalized) {
            prepared.discard();
            if (!await this.canDispatchStreamOutput(messageId, streamData)) return false;
            const delivered = await this.feishuLongConnHandler.sendMessage(openId, output || '⚙️ Settings are unavailable as a card. Use the text command.');
            if (delivered === false) throw new Error('Failed to deliver settings result');
          }
        } else if (success) {
          const finalized = await this.feishuLongConnHandler.finalizeStreamingMessage(
            feishuMessageId,
            streamData.elements,
            sessionAbbr,
            openId,
            cwd,
            streamData.threadName,
            streamData.threads,
            streamData.threadId,
            queueConfirmation,
            executionMetadata,
            true,
            { onDelivered: cardIds => this.registerDeliveredThreadCards(messageId, streamData, cardIds) }
          );
          if (finalized === false) throw new Error('Failed to finalize task card');
        } else {
          // Add error message to elements
          const finalElements = [...streamData.elements];
          if (!queueConfirmation) {
            const errorMsg = error || 'Command failed';
            finalElements.push(createMarkdownElement(`\n\n❌ **Error:** ${errorMsg}`));
          }
          const finalized = await this.feishuLongConnHandler.finalizeStreamingMessage(
            feishuMessageId,
            finalElements,
            undefined,
            openId,
            cwd,
            streamData.threadName,
            streamData.threads,
            streamData.threadId,
            queueConfirmation,
            executionMetadata,
            false,
            { onDelivered: cardIds => this.registerDeliveredThreadCards(messageId, streamData, cardIds) }
          );
          if (finalized === false) throw new Error('Failed to finalize task card');
        }
      } else if (streamData.queueStarted) {
        if (streamData.queueStarted.source === 'schedule') {
          // An unthreaded plain message would lose the original reply route.
          // Leave this occurrence in the CLI outbox for a fresh card attempt.
          throw new Error('Scheduled result card is unavailable');
        }
        // If card creation failed after session recovery, retain a text result
        // rather than silently losing the completed queued task's output.
        const text = streamData.elements
          .filter((element) => element.tag === 'markdown')
          .map((element) => element.content)
          .concat(streamData.currentTextContent, output || '')
          .filter(Boolean)
          .join('\n\n');
        const delivered = await this.feishuLongConnHandler.sendMessage(openId,
          `${text}\n\n${success ? '✅ Completed' : `❌ Error: ${error || 'Command failed'}`}`);
        if (delivered === false) throw new Error('Failed to deliver task result');
      }

      deliveryEvent('task_finalization_complete', { task });
      // Keep durable card associations after removing the completed streaming session.
      if (this.streamingMessages.get(messageId) === streamData) {
        this.streamingMessages.delete(messageId);
        this.lastStreamUpdateTime.delete(messageId);
      }
      return true;
    } catch (failure) {
      deliveryEvent('task_finalization_failed', { task, ...safeCardError(failure) });
      throw failure;
    }
  }

  private removeActiveCardRoutes(session: StreamingMessageState): Promise<void>[] {
    const ids = new Set(session.deliveredCardIds);
    if (session.feishuMessageId) ids.add(session.feishuMessageId);
    return [...ids].map(id => this.store.removeCardThread(id));
  }

  /** Clean up timed-out executions without discarding completed card routes. */
  private async cleanupStaleStreamingSessions(): Promise<void> {
    const now = Date.now();
    let cleanedCount = 0;
    const removals: Promise<void>[] = [];
    for (const [messageId, route] of this.imageReplies) {
      if (!route.current() || (!this.streamingMessages.has(messageId)
        && now - route.createdAt > this.STREAMING_SESSION_TIMEOUT_MS)) this.cancelImageReply(messageId);
    }

    for (const [messageId, session] of this.streamingMessages.entries()) {
      if (now - session.createdAt > this.STREAMING_SESSION_TIMEOUT_MS) {
        console.log(`[RouterServer] Cleaning up stale streaming session: ${messageId}`);
        // Stale in-flight sessions lose their card association;
        // completed sessions deliberately keep theirs (see finalizeStreamingMessage).
        this.streamingMessages.delete(messageId);
        removals.push(...this.removeActiveCardRoutes(session));
        this.clearDelegationProgressTimers(session);
        this.cancelImageReply(messageId);
        this.lastStreamUpdateTime.delete(messageId);
        cleanedCount++;
      }
    }

    for (const [messageId, startedAt] of this.startedQueueMessages) {
      if (now - startedAt > this.CARD_THREAD_MAP_TTL_MS && !this.streamingMessages.has(messageId)) {
        this.startedQueueMessages.delete(messageId);
      }
    }

    const results = await Promise.allSettled(removals);
    await this.store.pruneCardThreads();
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (cleanedCount > 0) {
      console.log(`[RouterServer] Cleaned up ${cleanedCount} stale streaming sessions, remaining: ${this.streamingMessages.size}`);
    }
  }

  /**
   * Cleanup streaming sessions for a specific device when it disconnects
   * @param deviceId Device ID that disconnected
   */
  private async cleanupStreamingSessionsForDevice(deviceId: string): Promise<void> {
    this.cancelThreadInventories(deviceId);
    this.cancelDeviceImages(deviceId);
    let cleanedCount = 0;
    const removals: Promise<void>[] = [];

    for (const [messageId, session] of this.streamingMessages.entries()) {
      if (session.deviceId === deviceId) {
        console.log(`[RouterServer] Cleaning up streaming session for disconnected device: ${messageId}`);
        // Remove the session identity before awaiting durable card removal.
        this.streamingMessages.delete(messageId);
        removals.push(...this.removeActiveCardRoutes(session));
        this.clearDelegationProgressTimers(session);
        this.cancelImageReply(messageId);
        this.lastStreamUpdateTime.delete(messageId);
        cleanedCount++;
      }
    }

    // Completed cards survive ordinary disconnects and Router shutdown.

    const results = await Promise.allSettled(removals);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (cleanedCount > 0) {
      deliveryEvent('disconnected_streams_cleaned', { count: cleanedCount, remaining: this.streamingMessages.size });
    }
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    console.log('Stopping router server...');
    this.stopping = true;
    for (const [ws, release] of this.pendingSockets) { release(); ws.terminate(); }
    let firstError: unknown;
    let failed = false;
    const attempt = async (label: string, operation: () => Promise<void> | void): Promise<void> => {
      try { await operation(); }
      catch (error) {
        failed = true;
        firstError ??= error;
        console.error(`${label}:`, error);
      }
    };

    // Drain accepted binding writes before any slow card or transfer cleanup.
    // A failure must not skip the remaining resource cleanup or be hidden.
    for (const id of this.threadInventoryRequests.keys()) {
      this.cancelThreadInventory(id, new Error('Router is stopping. Retry the thread selection.'));
    }
    await attempt('Error flushing bindings during shutdown', () => this.store.flush());
    await attempt('Error stopping Tips scheduler', () => this.tips.stop());
    for (const id of this.imageReplies.keys()) this.cancelImageReply(id);
    this.approvalCards.destroy();
    this.workerContextCards.destroy();
    this.workerContextConnections.clear();
    this.settingsCards.destroy();
    this.settingsConnections.clear();
    this.maintenanceCards.destroy();
    this.maintenanceConnections.clear();
    await attempt('Error destroying output transfers', () => this.outputTransfers.destroy());
    await attempt('Error draining automatic enrollment', () => this.automaticFileEnrollment.destroy());
    await attempt('Error destroying file transfers', () => this.fileTransfers.destroy());

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const [messageId, session] of Array.from(this.streamingMessages.entries())) {
      this.clearDelegationProgressTimers(session);
      if (session.finalizing) continue;
      try {
        await this.finalizeStreamingMessage(
          messageId, false, undefined, 'Router server is restarting — task was interrupted.'
        );
      } catch (error) {
        failed = true;
        firstError ??= error;
        deliveryEvent('shutdown_card_finalize_failed', { task: taskCorrelation(messageId), ...safeCardError(error) });
      }
    }
    this.streamingMessages.clear();
    this.lastStreamUpdateTime.clear();

    await attempt('Error destroying inline file cards', () => this.inlineFileCards.destroy());
    await attempt('Error stopping Feishu long connection', () => this.feishuLongConnHandler.stop());
    await attempt('Error closing WebSocket connections', () => this.connectionHub.closeAllConnections());
    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      await attempt('Error closing WebSocket server', () => wss.close());
    }

    if (this.httpServer) {
      const httpServer = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          console.warn('HTTP server close timed out, forcing shutdown');
          failed = true;
          firstError ??= new Error('HTTP server close timed out');
          resolve();
        }, 3000);
        httpServer.close((err) => {
          clearTimeout(timer);
          if (err) {
            failed = true;
            firstError ??= err;
            console.error('HTTP server close error:', err);
          }
          resolve();
        });
      });
    }

    await attempt('Error flushing card routes during shutdown', () => this.store.flush());
    if (failed) throw firstError;
    console.log('✅ Router server stopped');
  }

  /**
   * Get connection statistics
   */
  getStats() {
    return this.connectionHub.getConnectionStats();
  }
}

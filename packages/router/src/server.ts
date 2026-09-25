import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import Router from '@koa/router';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { ConfigManager } from './config/ConfigManager';
import { JsonStore } from './storage/JsonStore';
import { FeishuLongConnHandler } from './feishu/FeishuLongConnHandler';
import { ConnectionHub } from './websocket/ConnectionHub';
import { BindingManager } from './binding/BindingManager';
import { MessageType, ToolUseInfo, ToolResultInfo, TaskNotificationInfo, PROTOCOL_VERSION, MIN_SUPPORTED_CLI_VERSION, ROUTER_VERSION, ThreadSummary, QueueConfirmationInfo, QueueStartedInfo, TaskResumeInfo, ImageBlock } from './types';
import { FeishuCardElement, createToolUseElement, createToolResultElement, createMarkdownElement, createRedactedThinkingElement, createPlanModeElement, createTaskNotificationElement, createImageElement } from './utils/ToolFormatter';

interface StreamingMessageState {
  openId: string;
  feishuMessageId: string | null;
  elements: FeishuCardElement[];
  currentTextContent: string;
  hasUpdated: boolean;
  createdAt: number;
  deviceId: string;
  threadId?: string;
  threadName?: string;
  threads?: ThreadSummary[];
  pendingNewThread?: boolean;
  queueCardId?: string;
  queueStarted?: QueueStartedInfo;
  recoveryId?: string;
  recoveryPlainText?: boolean;
  recoveryCwd?: string;
  updateInFlight?: Promise<void>;
  updatePending: boolean;
  finalizing: boolean;
  lastRenderedTextLength: number;
}

/**
 * Router Server
 * Handles Feishu WebSocket long connection, local WebSocket connections, and message routing
 */
export class RouterServer {
  private app: Koa;
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private config: ConfigManager;
  private store: JsonStore;
  private feishuLongConnHandler: FeishuLongConnHandler;
  private connectionHub: ConnectionHub;
  private bindingManager: BindingManager;
  private cleanupInterval: NodeJS.Timeout | null = null;
  // Track streaming messages and coalesced Feishu card update state.
  private streamingMessages = new Map<string, StreamingMessageState>();
  private completedTasks = new Map<string, { deviceId: string; completedAt: number }>();
  private queueMessageOperations = new Map<string, Promise<void>>();
  private startedQueueMessages = new Map<string, number>();
  private readonly STREAMING_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes timeout
  // TTL for cardThreadMap entries: 7 days (allows users to reply to old cards)
  private readonly CARD_THREAD_MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  // Map from Feishu card message_id to threadId for parent_id-based routing.
  // Entries are NOT removed on finalize so users can reply to completed cards.
  // Each entry carries an expiresAt timestamp for TTL-based eviction.
  private cardThreadMap = new Map<string, { threadId: string; deviceId: string; expiresAt: number }>();
  // Map from openId to the user's currently active thread (set by card button click).
  // New top-level messages (no parent_id) are routed to this thread.
  private activeThreadMap = new Map<string, { threadId: string; threadName: string }>();

  constructor(config: ConfigManager, store: JsonStore) {
    this.config = config;
    this.store = store;
    this.app = new Koa();
    this.connectionHub = new ConnectionHub();
    this.bindingManager = new BindingManager(store);

    // Initialize FeishuLongConnHandler (WebSocket mode)
    this.feishuLongConnHandler = new FeishuLongConnHandler({
      appId: config.get('feishu', 'appId'),
      appSecret: config.get('feishu', 'appSecret'),
      store: this.store
    });

    // Share ConnectionHub with Feishu handler
    this.feishuLongConnHandler.setConnectionHub(this.connectionHub);

    // Register callback for streaming message start
    this.feishuLongConnHandler.setOnStartStreaming((messageId: string, openId: string, feishuMessageId: string | null, deviceId: string, threadId?: string, pendingNewThread?: boolean, queueCardId?: string) => {
      console.log(`[RouterServer] Registering streaming session: msgId=${messageId}, feishuMsgId=${feishuMessageId}, deviceId=${deviceId}, threadId=${threadId}, pendingNewThread=${pendingNewThread}`);
      this.streamingMessages.set(messageId, {
        openId,
        feishuMessageId,
        elements: [],
        currentTextContent: '',
        hasUpdated: false,
        createdAt: Date.now(),
        deviceId,
        threadId,
        pendingNewThread,
        queueCardId,
        updatePending: false,
        finalizing: false,
        lastRenderedTextLength: 0,
      });
      // Populate cardThreadMap for parent_id-based routing
      if (feishuMessageId && threadId) {
        this.cardThreadMap.set(feishuMessageId, { threadId, deviceId, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS });
      }
      console.log(`[RouterServer] Total streaming sessions: ${this.streamingMessages.size}`);
    });

    // Register callback for thread resolution from Feishu parent_id
    this.feishuLongConnHandler.setOnResolveThread((feishuMessageId: string) => {
      const entry = this.cardThreadMap.get(feishuMessageId);
      if (!entry) return undefined;
      // Evict expired entries on read
      if (Date.now() > entry.expiresAt) {
        this.cardThreadMap.delete(feishuMessageId);
        return undefined;
      }
      return entry;
    });

    // Register callback for resolving user's active thread (new top-level messages)
    this.feishuLongConnHandler.setOnResolveActiveThread((openId: string) => {
      return this.activeThreadMap.get(openId);
    });

    // Register callback for card button thread switching
    this.feishuLongConnHandler.onCardSwitchThread = async (openId: string, threadId: string, threadName: string) => {
      this.activeThreadMap.set(openId, { threadId, threadName });
      console.log(`[RouterServer] Active thread set for ${openId}: ${threadName} (${threadId})`);
    };

    // Register callback for creating a new thread via card button
    this.feishuLongConnHandler.onCardNewThread = async (openId: string) => {
      console.log(`[RouterServer] Creating new thread for ${openId} via card button`);
      await this.feishuLongConnHandler.sendCommandFromCardAction(openId, '/thread new', true);
    };

    this.feishuLongConnHandler.onQueueAction = async (openId, action, queueId, threadId, cardMessageId) => {
      return this.feishuLongConnHandler.sendQueueActionFromCardAction(openId, action, queueId, threadId, cardMessageId);
    };

    // Register callback for device switch — clear thread state tied to the old device
    this.feishuLongConnHandler.onDeviceSwitch = (openId: string, oldDeviceId: string | undefined) => {
      // Clear the active thread so the next message goes to the new device's default thread
      this.activeThreadMap.delete(openId);
      console.log(`[RouterServer] Cleared activeThreadMap for ${openId} after device switch`);

      // Remove cardThreadMap entries that belonged to the old device to avoid stale thread lookups
      if (oldDeviceId) {
        for (const [feishuMessageId, entry] of this.cardThreadMap.entries()) {
          if (entry.deviceId === oldDeviceId) {
            this.cardThreadMap.delete(feishuMessageId);
          }
        }
        console.log(`[RouterServer] Cleared cardThreadMap entries for old device ${oldDeviceId}`);
      }
    };

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Koa middleware
   */
  private setupMiddleware(): void {
    this.app.use(bodyParser());

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
        connections: stats.totalConnections,
        devices: stats.deviceIds
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

    // Binding code request endpoint
    router.post('/api/bind/request', async (ctx) => {
      const { deviceId, deviceName, platform } = ctx.request.body as {
        deviceId: string;
        deviceName?: string;
        platform?: string;
      };

      // Validate required fields
      if (!deviceId) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          error: 'deviceId is required'
        };
        return;
      }

      try {
        // Generate binding code
        const bindingCode = await this.bindingManager.generateBindingCode(
          deviceId,
          deviceName || 'Unknown Device'
        );

        ctx.body = {
          success: true,
          bindingCode: bindingCode.code,
          expiresAt: bindingCode.expiresAt,
          expiresIn: Math.floor((bindingCode.expiresAt - Date.now()) / 1000) // seconds
        };
      } catch (error: any) {
        console.error('Failed to generate binding code:', error);
        ctx.status = 500;
        ctx.body = {
          success: false,
          error: error.message || 'Failed to generate binding code'
        };
      }
    });

    // Feishu card callback endpoint — receives button click events from Feishu
    router.post('/api/feishu/card-callback', async (ctx) => {
      const body = ctx.request.body as any;
      // Feishu card callback wraps the action data under body.event
      const eventData = body?.event ?? body;
      const result = await this.feishuLongConnHandler.handleCardAction(eventData);
      ctx.status = 200;
      ctx.body = result ?? {};
    });

    this.app.use(router.routes());
    this.app.use(router.allowedMethods());
  }

  /**
   * Setup WebSocket server
   */
  private setupWebSocket(server: HttpServer): void {
    this.wss = new WebSocketServer({
      server,
      path: '/ws'
    });

    this.wss.on('connection', (ws: WebSocket, req) => {
      console.log('New WebSocket connection from:', req.socket.remoteAddress);

      let deviceId: string | null = null;
      let taskRecoveryEnabled = false;
      let heartbeatTimeout: NodeJS.Timeout | null = null;

      // Reset heartbeat timeout
      const resetHeartbeat = () => {
        if (heartbeatTimeout) clearTimeout(heartbeatTimeout);

        // If no heartbeat received within 3x interval, consider connection dead
        const interval = this.config.get('websocket', 'heartbeatInterval');
        heartbeatTimeout = setTimeout(() => {
          console.log('Heartbeat timeout for device:', deviceId);
          ws.close();
        }, interval * 3);
      };

      resetHeartbeat();

      // Handle incoming messages
      ws.on('message', async (data: Buffer) => {
        let finishQueueMessage: (() => void) | undefined;
        try {
          const message = JSON.parse(data.toString());

          if (deviceId && message.type !== MessageType.BINDING_REQUEST
            && !this.connectionHub.isCurrentConnection(deviceId, ws)) return;

          // Update heartbeat on any message
          resetHeartbeat();

          if (message.type === 'queue_started') {
            await this.handleQueueStarted(message, deviceId);
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
              const current = () => this.connectionHub.isCurrentConnection(deviceId!, ws);
              let success = false;
              try {
                success = await this.handleTaskResume(message, deviceId, current);
              } catch (error) {
                console.error('[RouterServer] Failed to recover task card:', error);
              }
              if (current()) ws.send(JSON.stringify({ type: 'task_resume_ack', messageId: message.messageId,
                recoveryId: message.taskResume?.recoveryId, state: message.taskResume?.state, success, timestamp: Date.now() }));
              break;
            }

            case MessageType.BINDING_REQUEST:
              // Device sends binding request with deviceId and optional protocolVersion
              deviceId = message.data.deviceId;
              if (deviceId) {
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

                if (message.data.capabilities?.queueStarted === true) {
                  this.connectionHub.registerConnection(deviceId, ws, { queueStarted: true });
                } else {
                  this.connectionHub.registerConnection(deviceId, ws);
                }
                console.log(`Device registered: ${deviceId} (protocol v${clientVersion})`);

                taskRecoveryEnabled = message.data.capabilities?.taskRecovery === true;
                // Send confirmation with version info for client-side version check
                ws.send(JSON.stringify({
                  type: MessageType.BINDING_CONFIRM,
                  messageId: message.messageId,
                  timestamp: Date.now(),
                  data: {
                    success: true,
                    routerVersion: ROUTER_VERSION,
                    minCliVersion: MIN_SUPPORTED_CLI_VERSION,
                    ...(taskRecoveryEnabled ? { capabilities: { taskRecovery: true } } : {}),
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
              if (taskRecoveryEnabled && deviceId && this.isCompletedTask(message.messageId, deviceId)) {
                ws.send(JSON.stringify({ type: 'task_result_ack', messageId: message.messageId, timestamp: Date.now() }));
                break;
              }
              // Device sends response to command - forward to Feishu via long connection
              const responseOpenId = message.openId || message.data?.openId;
              const responseMessageId = message.messageId;
              const sessionAbbr = message.sessionAbbr || message.data?.sessionAbbr;
              const cwd = message.cwd || message.data?.cwd || this.streamingMessages.get(message.messageId)?.queueStarted?.cwd
                || this.streamingMessages.get(message.messageId)?.recoveryCwd;
              const responseThreadId = message.threadId || message.data?.threadId;
              const responseThreads: ThreadSummary[] | undefined = message.threads || message.data?.threads;
              const queueConfirmation: QueueConfirmationInfo | undefined = message.queueConfirmation || message.data?.queueConfirmation;

              // If CLI reported a threadId and there is a streaming session for this message,
              // ensure the cardThreadMap is up to date (in case the CLI-reported threadId differs).
              if (responseThreadId && responseMessageId) {
                const session = this.streamingMessages.get(responseMessageId);
                if (session) {
                  if (session.feishuMessageId && !session.threadId) {
                    session.threadId = responseThreadId;
                    this.cardThreadMap.set(session.feishuMessageId, { threadId: responseThreadId, deviceId: session.deviceId, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS });
                  }
                  // Resolve thread name from the threads summary array
                  if (!session.threadName && responseThreads) {
                    const match = responseThreads.find(t => t.id === responseThreadId);
                    if (match) session.threadName = match.name;
                  }
                  // Store full threads list for button rendering
                  if (responseThreads) {
                    session.threads = responseThreads;
                  }
                  // When the "+ New" card button triggered this command, update activeThreadMap
                  // so the user's next new message routes to the newly created thread.
                  if (session.pendingNewThread && responseThreadId && responseThreads && responseOpenId) {
                    const newThread = responseThreads.find(t => t.id === responseThreadId);
                    if (newThread) {
                      this.activeThreadMap.set(responseOpenId, { threadId: responseThreadId, threadName: newThread.name });
                      console.log(`[RouterServer] activeThreadMap updated for ${responseOpenId} after new thread: ${newThread.name} (${responseThreadId})`);
                    }
                  }
                }
              }
              if (responseMessageId && responseOpenId) {
                // Check if this was a streaming message (stream chunks were sent)
                if (this.streamingMessages.has(responseMessageId)) {
                  await this.finalizeStreamingMessage(
                    responseMessageId,
                    message.success ?? message.data?.success,
                    message.output || message.data?.output,
                    message.error || message.data?.error,
                    sessionAbbr,
                    cwd,
                    queueConfirmation,
                  );
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
              if (taskRecoveryEnabled && deviceId && this.connectionHub.isCurrentConnection(deviceId, ws)
                && responseOpenId && responseMessageId && !queueConfirmation
                && typeof (message.success ?? message.data?.success) === 'boolean') {
                this.rememberCompletedTask(responseMessageId, deviceId);
                if (this.connectionHub.isCurrentConnection(deviceId, ws)) {
                  ws.send(JSON.stringify({ type: 'task_result_ack', messageId: responseMessageId, timestamp: Date.now() }));
                }
              }
              break;

            case 'stream':
              // Handle streaming output from device
              if (message.messageId && message.openId) {
                const streamType = message.streamType || 'text';

                switch (streamType) {
                  case 'text': {
                    const update = this.handleTextChunk(message.messageId, message.openId, message.chunk || '');
                    if (this.startedQueueMessages.has(message.messageId)) {
                      // Text is accumulated synchronously. Let subsequent deltas
                      // coalesce while the card patch runs; finalization still
                      // waits for updateInFlight before rendering the result.
                      void update.catch(error => console.error('[RouterServer] Failed to update queued text:', error));
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
                  case 'redacted_thinking':
                    await this.handleRedactedThinking(message.messageId, message.openId);
                    break;
                  case 'plan_mode':
                    if (message.planContent !== undefined) {
                      await this.handlePlanMode(message.messageId, message.openId, message.planContent);
                    }
                    break;
                  case 'image':
                    if (message.image) {
                      await this.handleImage(message.messageId, message.openId, message.image);
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

            case MessageType.TASK_NOTIFICATION:
              // Background task terminal-state event (Claude Code 2.x).
              // Not tied to any streaming session — rendered as a standalone card.
              if (message.openId && message.taskNotification) {
                await this.handleTaskNotification(message.openId, message.taskNotification, message.threadId, deviceId, message.threadName);
              } else {
                console.log('[RouterServer] Ignoring task_notification with missing openId or payload');
              }
              break;

            default:
              console.log('Unknown message type:', message.type);
          }
        } catch (error) {
          console.error('Error processing message:', error);
        } finally {
          finishQueueMessage?.();
        }
      });

      // Handle connection close
      ws.on('close', () => {
        if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
        if (deviceId && this.connectionHub.unregisterConnection(deviceId, ws)) {
          // Clean up any streaming sessions for this device
          this.cleanupStreamingSessionsForDevice(deviceId);
          console.log('Device disconnected:', deviceId);
        }
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });

    console.log('WebSocket server listening on /ws');
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    const port = this.config.get('server', 'port');
    const host = this.config.get('server', 'host');

    // Create HTTP server
    this.httpServer = this.app.listen(port, host);

    // Setup WebSocket server
    this.setupWebSocket(this.httpServer);

    // Start Feishu WebSocket long connection
    try {
      await this.feishuLongConnHandler.start();
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
      this.cleanupStaleStreamingSessions();
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

  /**
   * Handle streaming chunk from device
   */
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
      streamData.hasUpdated = true;
      this.lastStreamUpdateTime.set(messageId, Date.now());
      await this.feishuLongConnHandler.updateStreamingMessage(
        streamData.feishuMessageId,
        elements,
        openId,
        streamData.threadName
      );
    } while (streamData.updatePending);
  }

  /**
   * Handle tool use event
   */
  private async handleToolUse(messageId: string, openId: string, toolUse: ToolUseInfo): Promise<void> {
    console.log(`[RouterServer] Received tool_use for ${messageId}: ${toolUse.name}`);
    const streamData = this.streamingMessages.get(messageId);

    if (!streamData) {
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

    // Add tool use elements (divider + markdown)
    const toolUseElements = createToolUseElement(toolUse);
    streamData.elements.push(...toolUseElements);
    streamData.createdAt = Date.now();

    // Immediately update card to show tool use
    if (streamData.feishuMessageId) {
      await this.feishuLongConnHandler.updateStreamingMessage(
        streamData.feishuMessageId,
        streamData.elements,
        openId,
        streamData.threadName
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

    if (!streamData) {
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

    // Add tool result elements (markdown + status div)
    const toolResultElements = createToolResultElement(toolResult);
    streamData.elements.push(...toolResultElements);
    streamData.createdAt = Date.now();

    // Immediately update card to show tool result
    if (streamData.feishuMessageId) {
      await this.feishuLongConnHandler.updateStreamingMessage(
        streamData.feishuMessageId,
        streamData.elements,
        openId,
        streamData.threadName
      );
      streamData.hasUpdated = true;
    }
  }

  /**
   * Handle redacted thinking event
   * This occurs when AI reasoning is filtered by safety systems (Claude 3.7 Sonnet, Gemini)
   */
  private async handleRedactedThinking(messageId: string, openId: string): Promise<void> {
    console.log(`[RouterServer] Received redacted_thinking for ${messageId}`);

    const streamData = this.streamingMessages.get(messageId);
    if (!streamData) {
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
        streamData.threadName
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
    if (!streamData) {
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
        streamData.threadName
      );
      streamData.hasUpdated = true;
    }
  }

  private async handleImage(messageId: string, openId: string, image: ImageBlock): Promise<void> {
    console.log(`[RouterServer] Received generated image for ${messageId}`);
    const streamData = this.streamingMessages.get(messageId);
    if (!streamData || streamData.finalizing) return;
    if (!image || image.type !== 'image' || typeof image.data !== 'string' || typeof image.mimeType !== 'string') return;

    const imageKey = await this.feishuLongConnHandler.uploadImage(image.data, image.mimeType);
    if (!imageKey) {
      streamData.elements.push(createMarkdownElement('⚠️ Generated image could not be uploaded to Feishu.'));
      return;
    }

    if (streamData.currentTextContent.trim()) {
      streamData.elements.push(...this.renderCurrentText(streamData));
      streamData.currentTextContent = '';
      streamData.recoveryPlainText = false;
      streamData.lastRenderedTextLength = 0;
    }
    streamData.updatePending = false;
    streamData.elements.push(createImageElement(imageKey));
    streamData.createdAt = Date.now();

    if (streamData.feishuMessageId) {
      await this.feishuLongConnHandler.updateStreamingMessage(
        streamData.feishuMessageId,
        streamData.elements,
        openId,
        streamData.threadName
      );
      streamData.hasUpdated = true;
    }
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
    const previous = this.streamingMessages.get(messageId);
    if (previous && (previous.deviceId !== deviceId || previous.openId !== openId
      || (previous.threadId && previous.threadId !== threadId))) return false;

    if (previous && previous.recoveryId !== info.recoveryId && !previous.finalizing) {
      // The pre-disconnect session survived: the CLI reconnected before the old
      // socket's close handler could run cleanup. Adopt the existing card instead
      // of replacing it — retained output stays visible and new output continues
      // in the same card, with a separator marking the possible gap.
      previous.recoveryId = info.recoveryId;
      previous.recoveryCwd = info.cwd;
      previous.threadId = previous.threadId ?? threadId;
      previous.threadName = previous.threadName ?? info.threadName;
      previous.currentTextContent += '\n\n---\n🔄 **Connection restored** — output during the interruption may be missing.\n\n';
      previous.createdAt = Date.now();
      if (previous.feishuMessageId) {
        await this.updateStreamingText(messageId, openId, previous);
        if (!isCurrent()) return false;
      }
    } else if (!previous) {
      const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const intro = `🔄 **${info.state === 'running' ? 'Connection restored — task continues' : 'Task status recovered'}**\n\n`
        + `Output before this card, including output during disconnection, was not retained.\n\n`
        + `**Thread:** <raw>${escape(info.threadName)}</raw> · **Backend:** <raw>${escape(info.backend)}</raw>\n`
        + `**Working directory:** <raw>${escape(info.cwd)}</raw>\n**Task:** <raw>${escape(info.preview)}</raw>`;
      const cardId = await this.feishuLongConnHandler.sendStreamingStart(openId, intro, info.threadName);
      if (!cardId || !isCurrent()) return false;
      this.streamingMessages.set(messageId, {
        openId, deviceId, threadId, threadName: info.threadName, feishuMessageId: cardId,
        elements: [createMarkdownElement(intro)], currentTextContent: '', hasUpdated: false,
        createdAt: Date.now(), updatePending: false, finalizing: false, lastRenderedTextLength: 0,
        recoveryId: info.recoveryId, recoveryPlainText: true, recoveryCwd: info.cwd,
      });
      this.cardThreadMap.set(cardId, { threadId, deviceId, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS });
    }
    if (info.state !== 'running') {
      await this.finalizeStreamingMessage(messageId, info.state === 'completed', undefined, info.error, undefined, info.cwd);
      if (!isCurrent()) return false;
      this.rememberCompletedTask(messageId, deviceId);
    }
    return true;
  }

  /** Create a fresh card before accepting any output for a dequeued task. */
  private async handleQueueStarted(message: any, deviceId: string | null): Promise<void> {
    const info = message.queueStarted as QueueStartedInfo | undefined;
    const { messageId, openId, threadId } = message;
    if (!deviceId || typeof messageId !== 'string' || !messageId
      || typeof openId !== 'string' || !openId || typeof threadId !== 'string' || !threadId
      || !info || typeof info.threadName !== 'string' || typeof info.backend !== 'string'
      || typeof info.cwd !== 'string' || typeof info.preview !== 'string'
      || !Number.isInteger(info.remainingCount) || info.remainingCount < 0) return;
    const previous = this.streamingMessages.get(messageId);
    if (previous && (previous.deviceId !== deviceId || previous.openId !== openId
      || (previous.threadId && previous.threadId !== threadId))) return;
    const pending = this.queueMessageOperations.get(messageId);
    if (pending) return pending;
    if (this.startedQueueMessages.has(messageId)) return;

    this.startedQueueMessages.set(messageId, Date.now());
    const operation = Promise.resolve().then(async () => {
      const intro = `▶️ **Queued task started**

**Thread:** ${info.threadName} · **Backend:** ${info.backend}
**Working directory:** \`${info.cwd}\`
**Task:** ${info.preview}
**Remaining in queue:** ${info.remainingCount}`;
      let cardId: string | null = null;
      try {
        cardId = await this.feishuLongConnHandler.sendStreamingStart(openId, intro, info.threadName);
      } catch (error) {
        console.error('[RouterServer] Failed to create queued execution card:', error);
      }
      const fallbackCardId = previous?.feishuMessageId || previous?.queueCardId || null;
      this.streamingMessages.set(messageId, {
        openId,
        deviceId,
        threadId,
        threadName: info.threadName,
        feishuMessageId: cardId || fallbackCardId,
        elements: [createMarkdownElement(intro)],
        currentTextContent: '',
        hasUpdated: false,
        createdAt: Date.now(),
        updatePending: false,
        finalizing: false,
        lastRenderedTextLength: 0,
        queueStarted: info,
        threads: Array.isArray(message.threads) ? message.threads : undefined,
      });
      if (cardId || fallbackCardId) {
        this.cardThreadMap.set((cardId || fallbackCardId)!, {
          threadId, deviceId, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS,
        });
      }
      if (cardId) {
        const oldCards = new Set([previous?.queueCardId, previous?.feishuMessageId]);
        for (const oldCard of oldCards) {
          if (!oldCard || oldCard === cardId) continue;
          try {
            await this.feishuLongConnHandler.markQueueCardStarted(oldCard);
          } catch (error) {
            // The new execution card remains usable if its old receipt expired.
            console.error('[RouterServer] Failed to update queue receipt:', error);
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

  /**
   * Handle background task notification (Claude Code 2.x)
   *
   * Sent as a standalone one-shot card — the event may arrive while no
   * streaming session exists (the originating command's card is often
   * already finalized), so it deliberately never touches streamingMessages.
   * The new card is registered in cardThreadMap so the user can reply to it
   * to continue working in the originating thread.
   */
  private async handleTaskNotification(openId: string, info: TaskNotificationInfo, threadId?: string, deviceId?: string | null, threadName?: string): Promise<void> {
    // Boundary validation — the WS message is external data, never trust it.
    // Required for rendering: a non-empty taskId and a string summary.
    // Unknown status values are allowed through (forward compatibility);
    // createTaskNotificationElement renders them with a neutral label.
    if (!info || typeof info.taskId !== 'string' || info.taskId.length === 0 || typeof info.summary !== 'string') {
      console.log('[RouterServer] Ignoring task_notification with invalid payload:', JSON.stringify(info).slice(0, 200));
      return;
    }

    console.log(`[RouterServer] Task notification for ${openId}: task=${info.taskId} status=${info.status} thread=${threadId || 'default'}`);

    const elements = createTaskNotificationElement(info, typeof threadName === 'string' ? threadName : undefined);
    const feishuMessageId = await this.feishuLongConnHandler.sendTaskNotificationCard(openId, elements);

    if (feishuMessageId && threadId && deviceId) {
      this.cardThreadMap.set(feishuMessageId, { threadId, deviceId, expiresAt: Date.now() + this.CARD_THREAD_MAP_TTL_MS });
      console.log(`[RouterServer] Registered task notification card ${feishuMessageId} for thread ${threadId}`);
    }
  }

  /**
   * Finalize streaming message
   */
  private async finalizeStreamingMessage(messageId: string, success: boolean, output?: string, error?: string, sessionAbbr?: string, cwd?: string, queueConfirmation?: QueueConfirmationInfo): Promise<void> {
    const streamData = this.streamingMessages.get(messageId);
    if (!streamData) return;

    streamData.finalizing = true;
    streamData.updatePending = false;
    await streamData.updateInFlight;

    const { feishuMessageId, openId } = streamData;

    if (feishuMessageId) {
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

      if (success) {
        const finalized = await this.feishuLongConnHandler.finalizeStreamingMessage(
          feishuMessageId,
          streamData.elements,
          sessionAbbr,
          openId,
          cwd,
          streamData.threadName,
          streamData.threads,
          streamData.threadId,
          queueConfirmation
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
          queueConfirmation
        );
        if (finalized === false) throw new Error('Failed to finalize task card');
      }
    } else if (streamData.queueStarted) {
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

    // Clean up streaming session state (but NOT cardThreadMap — keep it alive
    // so users can reply to the completed card and route to the same thread).
    if (this.streamingMessages.get(messageId) === streamData) {
      this.streamingMessages.delete(messageId);
      this.lastStreamUpdateTime.delete(messageId);
    }
  }

  /**
   * Cleanup stale streaming sessions that have timed out
   * This prevents memory leaks when devices disconnect without sending a response
   */
  private cleanupStaleStreamingSessions(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [messageId, session] of this.streamingMessages.entries()) {
      if (now - session.createdAt > this.STREAMING_SESSION_TIMEOUT_MS) {
        console.log(`[RouterServer] Cleaning up stale streaming session: ${messageId}`);
        // Stale in-flight sessions have their cardThreadMap entry removed;
        // completed sessions deliberately keep theirs (see finalizeStreamingMessage).
        if (session.feishuMessageId) {
          this.cardThreadMap.delete(session.feishuMessageId);
        }
        this.streamingMessages.delete(messageId);
        this.lastStreamUpdateTime.delete(messageId);
        cleanedCount++;
      }
    }

    for (const [messageId, startedAt] of this.startedQueueMessages) {
      if (now - startedAt > this.CARD_THREAD_MAP_TTL_MS && !this.streamingMessages.has(messageId)) {
        this.startedQueueMessages.delete(messageId);
      }
    }

    // Evict expired cardThreadMap entries (TTL-based, independent of streaming sessions)
    for (const [feishuMessageId, entry] of this.cardThreadMap.entries()) {
      if (now > entry.expiresAt) {
        this.cardThreadMap.delete(feishuMessageId);
      }
    }

    if (cleanedCount > 0) {
      console.log(`[RouterServer] Cleaned up ${cleanedCount} stale streaming sessions, remaining: ${this.streamingMessages.size}`);
    }
  }

  /**
   * Cleanup streaming sessions for a specific device when it disconnects
   * @param deviceId Device ID that disconnected
   */
  private cleanupStreamingSessionsForDevice(deviceId: string): void {
    let cleanedCount = 0;

    for (const [messageId, session] of this.streamingMessages.entries()) {
      if (session.deviceId === deviceId) {
        console.log(`[RouterServer] Cleaning up streaming session for disconnected device: ${messageId}`);
        // Also clean up any cardThreadMap entries associated with this session's feishuMessageId
        if (session.feishuMessageId) {
          this.cardThreadMap.delete(session.feishuMessageId);
        }
        this.streamingMessages.delete(messageId);
        this.lastStreamUpdateTime.delete(messageId);
        cleanedCount++;
      }
    }

    // Clean up any orphaned cardThreadMap entries for this device
    for (const [feishuMessageId, entry] of this.cardThreadMap.entries()) {
      if (entry.deviceId === deviceId) {
        this.cardThreadMap.delete(feishuMessageId);
      }
    }

    if (cleanedCount > 0) {
      console.log(`[RouterServer] Cleaned up ${cleanedCount} streaming sessions for device ${deviceId}, remaining: ${this.streamingMessages.size}`);
    }
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    console.log('Stopping router server...');

    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Finalize in-flight streaming cards before losing the Feishu connection,
    // so a graceful restart does not leave users with permanently unfinished
    // cards. (A hard crash still cannot do this.)
    for (const [messageId, session] of Array.from(this.streamingMessages.entries())) {
      if (session.finalizing) continue;
      try {
        await this.finalizeStreamingMessage(
          messageId, false, undefined, 'Router server is restarting — task was interrupted.'
        );
      } catch (error) {
        console.error(`[RouterServer] Failed to finalize streaming card ${messageId} during shutdown:`, error);
      }
    }
    this.streamingMessages.clear();
    this.lastStreamUpdateTime.clear();

    // Stop Feishu long connection
    try {
      await this.feishuLongConnHandler.stop();
    } catch (error) {
      console.error('Error stopping Feishu long connection:', error);
    }

    // Close all WebSocket connections
    this.connectionHub.closeAllConnections();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Close HTTP server — with a 3s timeout so lingering sockets don't block shutdown
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          console.warn('HTTP server close timed out, forcing shutdown');
          resolve();
        }, 3000);
        this.httpServer!.close((err) => {
          clearTimeout(timer);
          if (err) console.error('HTTP server close error:', err);
          resolve();
        });
      });
      this.httpServer = null;
    }

    console.log('✅ Router server stopped');
  }

  /**
   * Get connection statistics
   */
  getStats() {
    return this.connectionHub.getConnectionStats();
  }
}

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
import { MessageType, ToolUseInfo, ToolResultInfo } from './types';
import { FeishuCardElement, createToolUseElement, createToolResultElement, createMarkdownElement, createRedactedThinkingElement } from './utils/ToolFormatter';

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
  // Track streaming messages: messageId -> { openId, feishuMessageId, elements, currentTextContent, hasUpdated, createdAt, deviceId }
  private streamingMessages: Map<string, {
    openId: string;
    feishuMessageId: string | null;
    elements: FeishuCardElement[];
    currentTextContent: string;
    hasUpdated: boolean;
    createdAt: number;
    deviceId: string;
  }> = new Map();
  private readonly STREAMING_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes timeout

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
    this.feishuLongConnHandler.setOnStartStreaming((messageId: string, openId: string, feishuMessageId: string | null, deviceId: string) => {
      console.log(`[RouterServer] Registering streaming session: msgId=${messageId}, feishuMsgId=${feishuMessageId}, deviceId=${deviceId}`);
      // Register this message as a streaming message so chunks and response update the same card
      // hasUpdated starts as false to ensure first content is immediately shown
      this.streamingMessages.set(messageId, {
        openId,
        feishuMessageId,
        elements: [],
        currentTextContent: '',
        hasUpdated: false,
        createdAt: Date.now(),
        deviceId
      });
      console.log(`[RouterServer] Total streaming sessions: ${this.streamingMessages.size}`);
    });

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
        try {
          const message = JSON.parse(data.toString());

          // Update heartbeat on any message
          resetHeartbeat();

          switch (message.type) {
            case MessageType.BINDING_REQUEST:
              // Device sends binding request with deviceId
              deviceId = message.data.deviceId;
              if (deviceId) {
                this.connectionHub.registerConnection(deviceId, ws);
                console.log('Device registered:', deviceId);

                // Send confirmation
                ws.send(JSON.stringify({
                  type: MessageType.BINDING_CONFIRM,
                  messageId: message.messageId,
                  timestamp: Date.now(),
                  data: { success: true }
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
              // Device sends response to command - forward to Feishu via long connection
              const responseOpenId = message.openId || message.data?.openId;
              const responseMessageId = message.messageId;
              const sessionAbbr = message.sessionAbbr || message.data?.sessionAbbr;
              const cwd = message.cwd || message.data?.cwd;
              if (responseMessageId && responseOpenId) {
                // Check if this was a streaming message (stream chunks were sent)
                if (this.streamingMessages.has(responseMessageId)) {
                  await this.finalizeStreamingMessage(
                    responseMessageId,
                    message.success ?? message.data?.success,
                    message.output || message.data?.output,
                    message.error || message.data?.error,
                    sessionAbbr,
                    cwd
                  );
                } else {
                  // No streaming session found - session should have been created when command was sent
                  // This might happen if there was an error. Just send the result as plain text.
                  const output = message.output || message.data?.output;
                  const success = message.success ?? message.data?.success;
                  const errorMsg = message.error || message.data?.error;

                  if (success) {
                    await this.feishuLongConnHandler.sendMessage(
                      responseOpenId,
                      output || '✅ Command completed successfully'
                    );
                  } else {
                    await this.feishuLongConnHandler.sendMessage(
                      responseOpenId,
                      `❌ Command failed:\n${errorMsg || 'Unknown error'}`
                    );
                  }
                }
              }
              break;

            case 'stream':
              // Handle streaming output from device
              if (message.messageId && message.openId) {
                const streamType = message.streamType || 'text';

                switch (streamType) {
                  case 'text':
                    await this.handleTextChunk(message.messageId, message.openId, message.chunk || '');
                    break;
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
          console.error('Error processing message:', error);
        }
      });

      // Handle connection close
      ws.on('close', () => {
        if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
        if (deviceId) {
          this.connectionHub.unregisterConnection(deviceId);
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

    // Accumulate text content
    streamData.currentTextContent += chunk;
    streamData.createdAt = Date.now(); // Update activity timestamp

    // Determine if we should update the card now
    const now = Date.now();
    const lastUpdate = this.lastStreamUpdateTime.get(messageId) || 0;
    const timeSinceLastUpdate = now - lastUpdate;
    const contentLength = streamData.currentTextContent.length;

    // Update if:
    // 1. We have a feishuMessageId
    // 2. Either:
    //    a. It's the first content (hasUpdated is false) - show immediately
    //    b. We've accumulated enough characters since last update
    //    c. Enough time has passed since last update
    const shouldUpdate = streamData.feishuMessageId && (
      !streamData.hasUpdated || // First content - always show immediately
      (contentLength % this.STREAM_UPDATE_MIN_LENGTH === 0) || // Every N characters
      (timeSinceLastUpdate >= this.STREAM_UPDATE_INTERVAL_MS) // Time-based
    );

    if (shouldUpdate && streamData.feishuMessageId) {
      // Build current element list: existing elements + current text (if any)
      const elements = [...streamData.elements];
      if (streamData.currentTextContent.trim()) {
        elements.push(createMarkdownElement(streamData.currentTextContent));
      }

      await this.feishuLongConnHandler.updateStreamingMessage(
        streamData.feishuMessageId,
        elements,
        openId
      );
      this.lastStreamUpdateTime.set(messageId, now);
      streamData.hasUpdated = true;
    }
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
      streamData.elements.push(createMarkdownElement(streamData.currentTextContent));
      streamData.currentTextContent = '';
    }

    // Add tool use elements (divider + markdown)
    const toolUseElements = createToolUseElement(toolUse);
    streamData.elements.push(...toolUseElements);
    streamData.createdAt = Date.now();

    // Immediately update card to show tool use
    if (streamData.feishuMessageId) {
      await this.feishuLongConnHandler.updateStreamingMessage(
        streamData.feishuMessageId,
        streamData.elements,
        openId
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
      streamData.elements.push(createMarkdownElement(streamData.currentTextContent));
      streamData.currentTextContent = '';
    }

    // Add tool result elements (markdown + status div)
    const toolResultElements = createToolResultElement(toolResult);
    streamData.elements.push(...toolResultElements);
    streamData.createdAt = Date.now();

    // Immediately update card to show tool result
    if (streamData.feishuMessageId) {
      await this.feishuLongConnHandler.updateStreamingMessage(
        streamData.feishuMessageId,
        streamData.elements,
        openId
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
      streamData.elements.push(createMarkdownElement(streamData.currentTextContent));
      streamData.currentTextContent = '';
    }

    // Add redacted thinking notification elements
    const redactedThinkingElements = createRedactedThinkingElement();
    streamData.elements.push(...redactedThinkingElements);
    streamData.createdAt = Date.now();

    // Immediately update card to show redacted thinking notification
    if (streamData.feishuMessageId) {
      await this.feishuLongConnHandler.updateStreamingMessage(
        streamData.feishuMessageId,
        streamData.elements,
        openId
      );
      streamData.hasUpdated = true;
    }
  }

  /**
   * Finalize streaming message
   */
  private async finalizeStreamingMessage(messageId: string, success: boolean, output?: string, error?: string, sessionAbbr?: string, cwd?: string): Promise<void> {
    const streamData = this.streamingMessages.get(messageId);
    if (!streamData) return;

    const { feishuMessageId, openId } = streamData;

    if (feishuMessageId) {
      // Flush any remaining text content
      if (streamData.currentTextContent.trim()) {
        streamData.elements.push(createMarkdownElement(streamData.currentTextContent));
        streamData.currentTextContent = '';
      }

      // If there are no elements at all, use the output parameter as fallback
      if (streamData.elements.length === 0 && output) {
        streamData.elements.push(createMarkdownElement(output));
      }

      if (success) {
        await this.feishuLongConnHandler.finalizeStreamingMessage(
          feishuMessageId,
          streamData.elements,
          sessionAbbr,
          openId,
          cwd
        );
      } else {
        // Add error message to elements
        const errorMsg = error || 'Command failed';
        streamData.elements.push(createMarkdownElement(`\n\n❌ **Error:** ${errorMsg}`));
        await this.feishuLongConnHandler.finalizeStreamingMessage(
          feishuMessageId,
          streamData.elements,
          undefined,
          openId
        );
      }
    }

    // Clean up
    this.streamingMessages.delete(messageId);
    this.lastStreamUpdateTime.delete(messageId);
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
        this.streamingMessages.delete(messageId);
        this.lastStreamUpdateTime.delete(messageId);
        cleanedCount++;
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
        this.streamingMessages.delete(messageId);
        this.lastStreamUpdateTime.delete(messageId);
        cleanedCount++;
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

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => {
          if (err) reject(err);
          else resolve();
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

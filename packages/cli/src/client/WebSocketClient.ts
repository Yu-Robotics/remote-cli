import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { PROTOCOL_VERSION, CLI_VERSION } from '../types';
import { TaskRecovery, type RecoverableTask } from './TaskRecovery';
import { DeviceIdentity, signDeviceProof } from '../files/DeviceIdentity';

/**
 * WebSocket client configuration
 */
export interface WebSocketClientOptions {
  identityLoader?: () => Promise<DeviceIdentity | undefined>;
  /** Reconnect interval (milliseconds), default 5000 */
  reconnectInterval?: number;
  /** Heartbeat interval (milliseconds), default 15000 */
  heartbeatInterval?: number;
  /** Maintenance features can opt out independently without changing the wire baseline. */
  maintenanceCapabilities?: { updateNotice: boolean; subscriptionInspection: boolean };
}

/**
 * Connection status
 */
export interface ConnectionStatus {
  connected: boolean;
  serverUrl: string;
  deviceId: string;
  lastHeartbeat?: number;
}

/**
 * WebSocket Client
 * Responsible for establishing and maintaining WebSocket connection with router server
 */
export class WebSocketClient {
  private serverUrl: string;
  private deviceId: string;
  private ws: WebSocket | null = null;
  private reconnectInterval: number;
  private heartbeatInterval: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private manualDisconnect = false;
  private connected = false;
  private lastReceivedAt = 0;
  private identity?: DeviceIdentity;
  private readonly identityLoader?: () => Promise<DeviceIdentity | undefined>;
  private readonly maintenanceCapabilities: { updateNotice: boolean; subscriptionInspection: boolean };
  private readonly taskRecovery = new TaskRecovery(message => this.sendRaw(message));
  private messageHandlers: Array<(message: any) => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private closeHandlers: Array<(code: number, reason: string) => void> = [];
  private connectHandlers: Array<() => void> = [];

  constructor(serverUrl: string, deviceId: string, options: WebSocketClientOptions = {}) {
    this.serverUrl = serverUrl;
    this.deviceId = deviceId;
    this.identityLoader = options.identityLoader;
    this.maintenanceCapabilities = options.maintenanceCapabilities ?? { updateNotice: true, subscriptionInspection: true };
    this.reconnectInterval = options.reconnectInterval ?? 5000;
    this.heartbeatInterval = options.heartbeatInterval ?? 15000;
  }

  /**
   * Connect to server
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.manualDisconnect = false;

      try {
        const socket = new WebSocket(this.serverUrl, { handshakeTimeout: 15000 });
        this.ws = socket;

        const onOpen = () => {
          if (this.ws !== socket) return;
          this.connected = true;
          this.lastReceivedAt = Date.now();
          this.startHeartbeat();
          void this.registerSocket(socket);
          this.connectHandlers.forEach(handler => handler());
          resolve();
        };

        const onError = (error: Error) => {
          if (this.ws !== socket) return;
          this.errorHandlers.forEach(handler => handler(error));
          if (!this.connected) {
            reject(error);
          }
        };

        const onClose = (code: number, reason: Buffer) => {
          if (this.ws !== socket) return;
          this.connected = false;
          this.taskRecovery.disconnected();
          this.stopHeartbeat();
          const reasonStr = reason.toString();
          this.closeHandlers.forEach(handler => handler(code, reasonStr));

          if (!this.manualDisconnect) {
            this.scheduleReconnect();
          }
        };

        const onMessage = (data: WebSocket.Data) => {
          if (this.ws !== socket) return;
          try {
            const message = JSON.parse(data.toString());
            this.lastReceivedAt = Date.now();
            if (message.type === 'device_challenge') {
              if (this.identity && /^[a-f0-9]{64}$/.test(message.data?.nonce ?? '')) {
                this.sendRegistration(signDeviceProof(this.identity, this.deviceId, message.data.nonce));
              } else {
                this.errorHandlers.forEach(handler => handler(new Error('This device requires authentication. Run remote-cli files enable and approve its binding code.')));
                this.manualDisconnect = true;
                socket.close();
              }
              return;
            }
            if (message.type === 'binding_confirm' && message.data?.success === true) {
              this.taskRecovery.registered(message.data?.capabilities?.taskRecovery === true);
            }
            if (message.type === 'task_resume_ack' || message.type === 'task_result_ack') {
              this.taskRecovery.acknowledge(message);
              return;
            }

            // Stop reconnecting if the router rejects this CLI version
            if (
              message.type === 'error' &&
              ['PROTOCOL_VERSION_INCOMPATIBLE', 'DEVICE_AUTH_REQUIRED'].includes(message.data?.code)
            ) {
              console.error(`\n[remote-cli] ${message.data.message}`);
              console.error('[remote-cli] Reconnection paused until this process restarts with a compatible CLI version.\n');
              this.manualDisconnect = true;
            }

            this.messageHandlers.forEach(handler => handler(message));
          } catch (error) {
            // Ignore malformed messages
          }
        };

        this.ws.on('open', onOpen);
        this.ws.on('error', onError);
        this.ws.on('close', onClose);
        this.ws.on('message', onMessage);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect
   */
  disconnect(): void {
    this.manualDisconnect = true;
    this.connected = false;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.taskRecovery.destroy();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Clear all handlers
    this.messageHandlers = [];
    this.errorHandlers = [];
    this.closeHandlers = [];
    this.connectHandlers = [];
  }

  /**
   * Send message
   * @param message Message object
   */
  send(message: any): void {
    this.taskRecovery.send(message);
  }

  trackTask(task: RecoverableTask): void {
    this.taskRecovery.track(task);
  }

  hasPendingTaskResults(): boolean {
    return this.taskRecovery.hasPendingResults();
  }

  private sendRaw(message: any): void {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected to server');
    }

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get connection status
   */
  getStatus(): ConnectionStatus {
    return {
      connected: this.connected,
      serverUrl: this.serverUrl,
      deviceId: this.deviceId
    };
  }

  /**
   * Register message handler
   * @param handler Message handler function
   */
  onMessage(handler: (message: any) => void): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Register error handler
   * @param handler Error handler function
   */
  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  /**
   * Register close handler
   * @param handler Close handler function
   */
  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandlers.push(handler);
  }

  /**
   * Register connect handler
   * @param handler Connect handler function
   */
  onConnect(handler: () => void): void {
    this.connectHandlers.push(handler);
  }

  /**
   * Event emitter style: on method
   * @param event Event name
   * @param handler Event handler
   */
  on(event: 'connected', handler: () => void): void;
  on(event: 'disconnected', handler: () => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  on(event: 'message', handler: (message: any) => void): void;
  on(event: string, handler: (...args: any[]) => void): void {
    switch (event) {
      case 'connected':
        this.onConnect(handler as () => void);
        break;
      case 'disconnected':
        this.onClose(() => handler());
        break;
      case 'error':
        this.onError(handler as (error: Error) => void);
        break;
      case 'message':
        this.onMessage(handler as (message: any) => void);
        break;
      default:
        console.warn(`Unknown event: ${event}`);
    }
  }

  /**
   * Send device registration message
   */
  private async registerSocket(socket: WebSocket): Promise<void> {
    try {
      const identity = this.identityLoader ? await this.identityLoader() : undefined;
      if (this.ws === socket && this.connected) { this.identity = identity; this.sendRegistration(); }
    } catch (error) {
      if (this.ws !== socket || !this.connected) return;
      this.manualDisconnect = true;
      this.errorHandlers.forEach(handler => handler(error instanceof Error ? error : new Error('Device identity could not be loaded.')));
      socket.close();
    }
  }

  private sendRegistration(signature?: string): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify({
        type: 'binding_request',
        messageId: uuidv4(),
        timestamp: Date.now(),
        data: {
          deviceId: this.deviceId,
          protocolVersion: PROTOCOL_VERSION,
          ...(signature ? { deviceSignature: signature } : {}),
          capabilities: {
            queueStarted: true,
            taskRecovery: true,
            approvalCards: true,
            delegationProgress: true,
            delegationProgressText: true,
            workerContextReset: true,
            streamingContext: true,
            activityProgress: true,
            ...(this.maintenanceCapabilities.updateNotice ? { updateNotice: true } : {}),
            ...(this.maintenanceCapabilities.subscriptionInspection ? { subscriptionInspection: true, bankedResetReminder: true } : {}),
            ...(this.identity ? { fileTransferV1: true } : {}),
          },
        }
      }));
    }
  }

  /**
   * Start heartbeat
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.connected) {
        if (Date.now() - this.lastReceivedAt >= this.heartbeatInterval * 3) {
          this.ws.terminate();
          return;
        }
        this.ws.send(JSON.stringify({
          type: 'heartbeat',
          timestamp: Date.now()
        }));
      }
    }, this.heartbeatInterval);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Schedule reconnection
   */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    if (!this.manualDisconnect) {
      this.reconnectTimer = setTimeout(() => {
        this.connect().catch(error => {
          console.error('Reconnection failed:', error);
        });
      }, this.reconnectInterval);
    }
  }

  /**
   * Clear reconnect timer
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { PROTOCOL_VERSION, CLI_VERSION } from '../types';

/**
 * WebSocket client configuration
 */
export interface WebSocketClientOptions {
  /** Reconnect interval (milliseconds), default 5000 */
  reconnectInterval?: number;
  /** Heartbeat interval (milliseconds), default 15000 */
  heartbeatInterval?: number;
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
  private messageHandlers: Array<(message: any) => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private closeHandlers: Array<(code: number, reason: string) => void> = [];
  private connectHandlers: Array<() => void> = [];

  constructor(serverUrl: string, deviceId: string, options: WebSocketClientOptions = {}) {
    this.serverUrl = serverUrl;
    this.deviceId = deviceId;
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
        this.ws = new WebSocket(this.serverUrl);

        const onOpen = () => {
          this.connected = true;
          this.startHeartbeat();
          this.sendRegistration();
          this.connectHandlers.forEach(handler => handler());
          resolve();
        };

        const onError = (error: Error) => {
          this.errorHandlers.forEach(handler => handler(error));
          if (!this.connected) {
            reject(error);
          }
        };

        const onClose = (code: number, reason: Buffer) => {
          this.connected = false;
          this.stopHeartbeat();
          const reasonStr = reason.toString();
          this.closeHandlers.forEach(handler => handler(code, reasonStr));

          if (!this.manualDisconnect) {
            this.scheduleReconnect();
          }
        };

        const onMessage = (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());

            // Stop reconnecting if the router rejects this CLI version
            if (
              message.type === 'error' &&
              message.data?.code === 'PROTOCOL_VERSION_INCOMPATIBLE'
            ) {
              console.error(`\n[remote-cli] ${message.data.message}`);
              console.error('[remote-cli] Disconnecting — please upgrade and restart.\n');
              this.manualDisconnect = true;
            }

            // Check for version mismatch on binding confirmation
            if (message.type === 'binding_confirm' && message.data?.routerVersion) {
              const routerVersion = message.data.routerVersion;
              if (routerVersion !== CLI_VERSION) {
                console.warn(`\n[remote-cli] ⚠️  Version mismatch: CLI ${CLI_VERSION} ↔ Router ${routerVersion}`);
                console.warn('[remote-cli] Consider upgrading to the latest version for best compatibility.\n');
              }
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
  private sendRegistration(): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify({
        type: 'binding_request',
        messageId: uuidv4(),
        timestamp: Date.now(),
        data: {
          deviceId: this.deviceId,
          protocolVersion: PROTOCOL_VERSION,
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

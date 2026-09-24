import { WebSocket } from 'ws';

/**
 * WebSocket Connection Hub
 * Manages all device WebSocket connections, responsible for message routing and connection management
 */
export class ConnectionHub {
  // Store deviceId -> WebSocket mapping
  private connections: Map<string, WebSocket>;
  // Store deviceId -> last active time mapping
  private lastActiveMap: Map<string, number>;
  private queueStartedDevices = new Set<string>();

  constructor() {
    this.connections = new Map();
    this.lastActiveMap = new Map();
  }

  /**
   * Register device connection
   * @param deviceId Device unique identifier
   * @param ws WebSocket connection
   */
  registerConnection(deviceId: string, ws: WebSocket, capabilities?: { queueStarted?: boolean }): void {
    const oldWs = this.connections.get(deviceId);
    // Replace the mapping first so the old socket cannot unregister its replacement.
    this.connections.set(deviceId, ws);
    if (oldWs && oldWs !== ws) {
      try {
        oldWs.close();
      } catch (error) {
        // Ignore close errors
      }
    }

    this.lastActiveMap.set(deviceId, Date.now());
    if (capabilities?.queueStarted === true) this.queueStartedDevices.add(deviceId);
    else this.queueStartedDevices.delete(deviceId);
  }

  /** Older clients need an execution card prepared at confirmation time. */
  supportsQueueStarted(deviceId: string): boolean {
    return this.queueStartedDevices.has(deviceId);
  }

  /**
   * Unregister device connection
   * @param deviceId Device unique identifier
   */
  isCurrentConnection(deviceId: string, ws: WebSocket): boolean {
    return this.connections.get(deviceId) === ws;
  }

  unregisterConnection(deviceId: string, ws?: WebSocket): boolean {
    if (ws && !this.isCurrentConnection(deviceId, ws)) return false;
    this.connections.delete(deviceId);
    this.lastActiveMap.delete(deviceId);
    this.queueStartedDevices.delete(deviceId);
    return true;
  }

  /**
   * Send message to specified device
   * @param deviceId Device unique identifier
   * @param message Message object
   * @returns Whether sending was successful
   */
  async sendToDevice(deviceId: string, message: any): Promise<boolean> {
    const ws = this.connections.get(deviceId);

    if (!ws) {
      return false;
    }

    try {
      const messageStr = JSON.stringify(message);
      ws.send(messageStr);

      // Update last active time
      this.lastActiveMap.set(deviceId, Date.now());

      return true;
    } catch (error) {
      // Sending failed, connection may be disconnected
      return false;
    }
  }

  /**
   * Check if device is online
   * @param deviceId Device unique identifier
   * @returns Whether it is online
   */
  isDeviceOnline(deviceId: string): boolean {
    return this.connections.has(deviceId);
  }

  /**
   * Get device last active time
   * @param deviceId Device unique identifier
   * @returns Last active timestamp, returns undefined if device does not exist
   */
  getLastActiveTime(deviceId: string): number | undefined {
    return this.lastActiveMap.get(deviceId);
  }

  /**
   * Get list of all online device IDs
   * @returns Device ID array
   */
  getOnlineDevices(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Update device last active time
   * @param deviceId Device unique identifier
   */
  updateLastActive(deviceId: string): void {
    if (this.connections.has(deviceId)) {
      this.lastActiveMap.set(deviceId, Date.now());
    }
  }

  /**
   * Get connection statistics
   * @returns Connection statistics
   */
  getConnectionStats(): {
    totalConnections: number;
    deviceIds: string[];
  } {
    const deviceIds = this.getOnlineDevices();
    return {
      totalConnections: deviceIds.length,
      deviceIds
    };
  }

  /**
   * Broadcast message to all devices
   * @param message Message object
   */
  async broadcast(message: any): Promise<void> {
    const messageStr = JSON.stringify(message);
    const promises: Promise<void>[] = [];

    for (const [deviceId, ws] of this.connections.entries()) {
      const promise = new Promise<void>((resolve) => {
        try {
          ws.send(messageStr);
          this.lastActiveMap.set(deviceId, Date.now());
        } catch (error) {
          // Sending failed, ignore this device
        } finally {
          resolve();
        }
      });
      promises.push(promise);
    }

    await Promise.all(promises);
  }

  /**
   * Clean up stale connections
   * @param timeoutMs Timeout duration (milliseconds)
   */
  cleanupStaleConnections(timeoutMs: number): void {
    const now = Date.now();
    const staleDevices: string[] = [];

    for (const [deviceId, lastActive] of this.lastActiveMap.entries()) {
      if (now - lastActive > timeoutMs) {
        staleDevices.push(deviceId);
      }
    }

    for (const deviceId of staleDevices) {
      const ws = this.connections.get(deviceId);
      if (ws) {
        try {
          ws.close();
        } catch (error) {
          // Ignore close errors
        }
      }
      this.unregisterConnection(deviceId);
    }
  }

  /**
   * Close all connections
   */
  closeAllConnections(): void {
    for (const ws of this.connections.values()) {
      try {
        // Use terminate() instead of close() to immediately destroy the socket
        // without waiting for the WebSocket close handshake (which has a 30s timeout
        // per connection and blocks httpServer.close() during shutdown)
        ws.terminate();
      } catch (error) {
        // Ignore close errors
      }
    }

    this.connections.clear();
    this.lastActiveMap.clear();
    this.queueStartedDevices.clear();
  }
}

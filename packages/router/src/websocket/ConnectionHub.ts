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

  constructor() {
    this.connections = new Map();
    this.lastActiveMap = new Map();
  }

  /**
   * Register device connection
   * @param deviceId Device unique identifier
   * @param ws WebSocket connection
   */
  registerConnection(deviceId: string, ws: WebSocket): void {
    // If device already has a connection, close the old connection first
    if (this.connections.has(deviceId)) {
      const oldWs = this.connections.get(deviceId)!;
      try {
        oldWs.close();
      } catch (error) {
        // Ignore close errors
      }
    }

    // Register new connection
    this.connections.set(deviceId, ws);
    this.lastActiveMap.set(deviceId, Date.now());
  }

  /**
   * Unregister device connection
   * @param deviceId Device unique identifier
   */
  unregisterConnection(deviceId: string): void {
    this.connections.delete(deviceId);
    this.lastActiveMap.delete(deviceId);
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
  }
}

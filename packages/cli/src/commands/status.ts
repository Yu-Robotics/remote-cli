import { ConfigManager } from '../config/ConfigManager';
import { WebSocketClient } from '../client/WebSocketClient';
import { loadIdentity } from '../files/DeviceIdentity';

/**
 * Status command options
 */
export interface StatusCommandOptions {
  /** Output as JSON */
  json?: boolean;
}

/**
 * Service status
 */
export interface ServiceStatus {
  initialized: boolean;
  deviceId?: string;
  serverUrl?: string;
  openId?: string;
  bound: boolean;
  running: boolean;
  connected: boolean;
  uptime?: number;
  allowedDirectories?: string[];
  startedAt?: number;
  pid?: number;
}

/**
 * Status command result
 */
export interface StatusCommandResult {
  success: boolean;
  status?: ServiceStatus;
  json?: boolean;
  error?: string;
}

/**
 * Get service status
 */
export async function statusCommand(
  options: StatusCommandOptions = {}
): Promise<StatusCommandResult> {
  try {
    const config = await ConfigManager.initialize();

    // Get all configuration
    const allConfig = config.getAll();

    // Check if initialized
    if (!config.has('deviceId')) {
      return {
        success: true,
        status: {
          initialized: false,
          bound: false,
          running: false,
          connected: false,
        },
        json: options.json,
      };
    }

    const { deviceId, serverUrl, openId, security, service } = allConfig;

    // Calculate uptime
    let uptime: number | undefined;
    if (service?.running && service.startedAt) {
      uptime = Date.now() - service.startedAt;
    }

    // Check WebSocket connection (if service is running)
    let connected = false;
    if (service?.running) {
      try {
        const wsUrl = serverUrl?.replace(/^http/, 'ws') + '/ws';
        const wsClient = new WebSocketClient(wsUrl || '', deviceId || '', {
          identityLoader: () => loadIdentity(config.getConfigDir(), wsUrl || '', deviceId || ''),
        });
        connected = wsClient.isConnected();
      } catch {
        connected = false;
      }
    }

    const status: ServiceStatus = {
      initialized: true,
      deviceId,
      serverUrl,
      openId,
      bound: Boolean(openId),
      running: Boolean(service?.running),
      connected,
      uptime,
      allowedDirectories: security?.allowedDirectories,
      startedAt: service?.startedAt,
      pid: service?.pid,
    };

    return {
      success: true,
      status,
      json: options.json,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

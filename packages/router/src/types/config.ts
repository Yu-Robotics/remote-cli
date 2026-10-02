/**
 * Router server configuration types
 */

export interface RouterConfig {
  files?: {
    /** Same public origin as the WebSocket endpoint; HTTPS except on loopback. */
    publicUrl: string;
    maxBytes?: number;
  };
  server: ServerConfig;
  feishu: FeishuConfig;
  websocket: WebSocketConfig;
  security: SecurityConfig;
}

export interface ServerConfig {
  port: number;
  host: string;
  nodeEnv: 'development' | 'production';
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
}

export interface WebSocketConfig {
  heartbeatInterval: number;
  reconnectDelay: number;
}

export interface SecurityConfig {
  bindingCodeExpiry: number;
  maxBindingAttempts: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  server: {
    port: 3000,
    host: '0.0.0.0',
    nodeEnv: 'production' as const,
  },
  feishu: {
    appId: '',
    appSecret: '',
    encryptKey: '',
    verificationToken: '',
  },
  websocket: {
    heartbeatInterval: 15000,
    reconnectDelay: 5000,
  },
  security: {
    bindingCodeExpiry: 300000, // 5 minutes
    maxBindingAttempts: 5,
  },
};

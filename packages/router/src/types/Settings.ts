/** Additive, capability-gated settings-card protocol. Never send credentials or native sessions. */
export type SettingsBackend = 'claude' | 'codex' | 'opencode' | 'kimi' | 'zcode' | 'pi' | 'agy' | 'dsh';
export type SettingsKind = 'backend' | 'model' | 'effort';
export type SettingsScope = 'thread' | 'all';

export interface SettingsChoice {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  reason?: string;
}

export interface SettingsBackendInfo {
  value: SettingsBackend;
  label: string;
  installed: boolean;
  reason?: string;
}

/** A bounded, opaque CLI-owned snapshot, bound to the original thread and configuration. */
export interface SettingsMenu {
  snapshotId: string;
  kind: SettingsKind;
  threadId: string;
  threadName: string;
  coordinatorBackend: SettingsBackend;
  targetBackend: SettingsBackend;
  backends: SettingsBackendInfo[];
  choices: SettingsChoice[];
  configuredValue?: string;
  effectiveValue?: string;
  defaultValue?: string;
  effectiveSource: 'native' | 'configured' | 'unknown';
  supportsReset: boolean;
  followsGlobal?: boolean;
  busy: boolean;
  expiresAt: number;
  unavailableReason?: string;
  omittedChoices?: number;
}

/** Only view requests and explicit backend confirmation may carry a target/scope. */
export interface SettingsActionMessage {
  type: 'settings_action';
  messageId: string;
  openId: string;
  threadId: string;
  snapshotId: string;
  operation: 'view' | 'apply' | 'reset' | 'follow_global';
  targetBackend?: SettingsBackend;
  value?: string;
  scope?: SettingsScope;
  timestamp: number;
}

export interface SettingsResultMessage {
  type: 'settings_result';
  messageId: string;
  openId: string;
  threadId: string;
  snapshotId: string;
  success: boolean;
  error?: string;
  notice?: string;
  menu?: SettingsMenu;
  timestamp: number;
}

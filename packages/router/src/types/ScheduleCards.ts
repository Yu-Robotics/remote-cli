const scheduleBackends = ['claude', 'dsh', 'agy', 'codex', 'opencode', 'kimi', 'zcode', 'pi'] as const;
export type ScheduleBackend = typeof scheduleBackends[number];

export function isScheduleBackend(value: unknown, allBackends: boolean): value is ScheduleBackend {
  if (value === 'claude' || value === 'dsh' || value === 'agy') return true;
  return allBackends && scheduleBackends.some(backend => backend === value);
}

/** Additive scheduleCardsV1 protocol. Values identify immutable CLI-owned choices. */
export interface ScheduleCardEntry {
  value: string;
  id: string;
  backend: ScheduleBackend;
  state: 'creating' | 'active' | 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed';
  rule: string;
  prompt: string;
  error?: string;
  canCancel: boolean;
  pending?: 'execution' | 'delivery';
}
export type ScheduleView = 'current' | 'history';
export function scheduleView(entry: ScheduleCardEntry): ScheduleView {
  return ['creating', 'active', 'running'].includes(entry.state) ? 'current' : 'history';
}
export interface ScheduleMenu {
  snapshotId: string;
  threadId: string;
  threadName: string;
  expiresAt: number;
  entries: ScheduleCardEntry[];
  more?: Partial<Record<ScheduleView, string>>;
}
export interface ScheduleActionMessage {
  type: 'schedule_action';
  messageId: string;
  openId: string;
  threadId: string;
  snapshotId: string;
  operation: 'refresh' | 'cancel' | 'more';
  value?: string;
  timestamp: number;
}
export interface ScheduleActionResult {
  type: 'schedule_action_result';
  messageId: string;
  openId: string;
  threadId: string;
  snapshotId: string;
  success: boolean;
  error?: string;
  menu?: ScheduleMenu;
  timestamp: number;
}

/** Separate management card; never replaces or completes the foreground response. */
export interface ScheduleToolCardMessage {
  type: 'schedule_tool_card';
  messageId: string;
  parentMessageId: string;
  openId: string;
  threadId: string;
  menu: ScheduleMenu;
  timestamp: number;
}
export interface ScheduleToolCardAck {
  type: 'schedule_tool_card_ack';
  messageId: string;
  success: boolean;
  timestamp: number;
}

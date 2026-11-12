/** Additive scheduleCardsV1 protocol. Values identify immutable CLI-owned choices. */
export interface ScheduleCardEntry {
  value: string;
  id: string;
  backend: 'claude' | 'dsh';
  state: 'creating' | 'active' | 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed';
  rule: string;
  prompt: string;
  error?: string;
  canCancel: boolean;
}
export interface ScheduleMenu {
  snapshotId: string;
  threadId: string;
  threadName: string;
  expiresAt: number;
  entries: ScheduleCardEntry[];
}
export interface ScheduleActionMessage {
  type: 'schedule_action';
  messageId: string;
  openId: string;
  threadId: string;
  snapshotId: string;
  operation: 'refresh' | 'cancel';
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

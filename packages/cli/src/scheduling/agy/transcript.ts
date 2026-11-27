/** Supported hook transcript records. Text receipts are joined by native stepIdx,
 * never adjacent model text, prompt echoes or callback arrival order. */
export interface TranscriptRecord {
  step_index: number; source: string; type: string; status: string;
  content?: string; tool_calls?: unknown[];
}
export const MAX_TRANSCRIPT = 8 * 1024 * 1024;
export const MAX_RECORDS = 20_000;
export const NOTIFICATION_PREFIX = 'The following is a <SYSTEM_MESSAGE> not actually sent by the user. '
  + 'It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n';
const PREFIX_LINE = /^(?:Created At|Completed At): [^\r\n]+\r?\n/;

export function parseTranscript(text: string): TranscriptRecord[] {
  if (Buffer.byteLength(text) > MAX_TRANSCRIPT) throw new Error('AGY transcript exceeds the observation limit.');
  const records: TranscriptRecord[] = [];
  const seen = new Set<number>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!row || !Number.isSafeInteger(row.step_index) || row.step_index < 0 || seen.has(row.step_index)
      || typeof row.source !== 'string' || typeof row.type !== 'string' || typeof row.status !== 'string'
      || row.content !== undefined && typeof row.content !== 'string'
      || row.tool_calls !== undefined && !Array.isArray(row.tool_calls)) throw new Error('Unsupported AGY transcript schema.');
    seen.add(row.step_index); records.push(row);
    if (records.length > MAX_RECORDS) throw new Error('AGY transcript record limit reached.');
  }
  return records.sort((a, b) => a.step_index - b.step_index);
}

export function receiptText(record: TranscriptRecord | undefined): string | undefined {
  if (!record || record.source !== 'MODEL' || record.type !== 'GENERIC' || typeof record.content !== 'string') return;
  let text = record.content;
  while (PREFIX_LINE.test(text)) text = text.replace(PREFIX_LINE, '');
  return text;
}

export function creationReceipt(record: TranscriptRecord | undefined, session: string, step: number): string | undefined {
  const text = receiptText(record);
  if (!text || !['RUNNING', 'DONE'].includes(record!.status)) return;
  const match = /^Tool is running as a background task with task id: ([^\s]+)\nTask Description: [\s\S]+\nTask logs are available at: file:\/\/[^\r\n]+\s*$/.exec(text);
  const id = `${session}/task-${step}`;
  return match?.[1] === id ? id : undefined;
}

export function creationDescription(record: TranscriptRecord | undefined): string | undefined {
  return /\nTask Description: ([\s\S]+)\nTask logs are available at: file:\/\//.exec(receiptText(record) ?? '')?.[1];
}

export interface NativeTask { taskId: string; toolName: string; description: string; isDaemon?: boolean }
export function inventoryReceipt(record: TranscriptRecord | undefined): NativeTask[] | undefined {
  const text = receiptText(record);
  if (record?.status !== 'DONE' || text === undefined) return;
  if (text === 'No background tasks are currently running.') return [];
  const match = /^You have (\d+) background task\(s\) currently running:\n([\s\S]+)$/.exec(text);
  if (!match) return;
  const rows = JSON.parse(match[2]);
  if (!Array.isArray(rows) || rows.length !== Number(match[1]) || rows.length > 1000) throw new Error('Invalid native AGY inventory.');
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.taskId !== 'string' || row.taskId.length > 256 || ids.has(row.taskId)
      || typeof row.toolName !== 'string' || typeof row.description !== 'string'
      || row.isDaemon !== undefined && typeof row.isDaemon !== 'boolean') throw new Error('Invalid native AGY task.');
    ids.add(row.taskId);
  }
  return rows;
}

export function deletionReceipt(record: TranscriptRecord | undefined, id: string): boolean {
  return record?.status === 'DONE' && receiptText(record) === `Task "${id}" cancelled.`;
}

export function nativeWake(record: TranscriptRecord): { sender: string; timestamp: string; prompt: string } | undefined {
  if (record.source !== 'SYSTEM' || record.type !== 'SYSTEM_MESSAGE' || record.status !== 'DONE'
    || !record.content?.startsWith(NOTIFICATION_PREFIX)) return;
  const match = /^\[Message\] timestamp=(\S+) sender=([^\s]+\/task-\d+) priority=MESSAGE_PRIORITY_HIGH content=([\s\S]*)\n<\/SYSTEM_MESSAGE>$/.exec(record.content.slice(NOTIFICATION_PREFIX.length));
  if (!match || !Number.isFinite(Date.parse(match[1]))) return;
  return { sender: match[2], timestamp: match[1], prompt: match[3] };
}

export function matchesWake(prompt: string, actual: string, recurring: boolean): boolean {
  if (!recurring) return prompt === actual;
  if (!actual.startsWith(prompt)) return false;
  return /^ \(iteration [1-9]\d*\)$/.test(actual.slice(prompt.length));
}

/** Native load emits this informational notice even for a proven empty session.
 * It is not a task wake or queue-absence proof. Keep its source and full payload
 * exact; an arbitrary SYSTEM sender or MODEL echo does not qualify. */
export function nativeRestartNotice(record: TranscriptRecord, reason: 'server restart' | 'user force cancellation' = 'server restart'): boolean {
  if (record.source !== 'SYSTEM' || record.type !== 'SYSTEM_MESSAGE' || record.status !== 'DONE'
    || !record.content?.startsWith(NOTIFICATION_PREFIX)) return false;
  const match = /^\[Message\] timestamp=\S+ sender=system priority=MESSAGE_PRIORITY_LOW content=\[Notice\] All your subagents and background tasks have been stopped due to (server restart|user force cancellation)\. If you want a subagent to continue working, it needs to be revived by sending it a new message\. If resuming work, please check on status and restart as needed\.\n<\/SYSTEM_MESSAGE>$/.exec(record.content.slice(NOTIFICATION_PREFIX.length));
  return match?.[1] === reason;
}

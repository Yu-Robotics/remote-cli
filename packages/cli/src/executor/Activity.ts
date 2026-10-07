import type { ActivityProgressInfo } from '../types';

export const MAX_ACTIVITY_TEXT_LENGTH = 240;
export const ACTIVITY_BUFFER_LIMIT = 1_024;
export const ACTIVITY_SUMMARY_KEYS = 32;

export type ActivitySource = ActivityProgressInfo['source'];

function tail(text: string, limit: number): string {
  return Array.from(text.slice(-limit * 2)).slice(-limit).join('');
}

function appendBounded(previous: string, delta: string): string {
  return tail(previous + tail(delta, ACTIVITY_BUFFER_LIMIT), ACTIVITY_BUFFER_LIMIT);
}

function latestText(value: string): string {
  return sanitizeActivityText(tail(value, MAX_ACTIVITY_TEXT_LENGTH));
}

const VALID_SOURCES = new Set<ActivitySource>([
  'public_text',
  'reasoning_summary',
  'plan',
  'tool',
  'state',
]);

/**
 * Sanitize activity text: single-line, stripped control codes, bounded to <= 240 Unicode code points.
 */
export function sanitizeActivityText(text: string): string {
  if (typeof text !== 'string') return '';
  // Strip ANSI escape codes
  const noAnsi = text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  // Strip ASCII non-printable control characters except space
  const noCtrl = noAnsi.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
  // Collapse whitespace and newlines into a single space
  const singleLine = noCtrl.replace(/\s+/g, ' ').trim();
  if (!singleLine) return '';

  // Bound to <= 240 Unicode code points
  const codePoints = Array.from(singleLine);
  if (codePoints.length > MAX_ACTIVITY_TEXT_LENGTH) {
    return codePoints.slice(0, MAX_ACTIVITY_TEXT_LENGTH).join('');
  }
  return singleLine;
}

/**
 * Validate and normalize an activity progress payload.
 * Returns undefined if value is invalid, source is unsupported, or text is empty after sanitization.
 */
export function normalizeActivity(value: unknown): ActivityProgressInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.source !== 'string' || !VALID_SOURCES.has(obj.source as ActivitySource)) {
    return undefined;
  }
  if (typeof obj.text !== 'string') return undefined;
  const sanitized = sanitizeActivityText(obj.text);
  if (!sanitized) return undefined;
  return {
    source: obj.source as ActivitySource,
    text: sanitized,
  };
}

/**
 * Extract active or in-progress todo task from tool input parameters (e.g. ACP todo tools).
 */
export function extractTodoPlan(input?: Record<string, unknown>): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const todos = (Array.isArray(input.todos)
    ? input.todos
    : (input.rawInput && typeof input.rawInput === 'object' && Array.isArray((input.rawInput as any).todos))
      ? (input.rawInput as any).todos
      : undefined) as unknown[];

  if (!Array.isArray(todos) || todos.length === 0) return undefined;

  const inProgress = todos.find((t: any) => {
    if (!t || typeof t !== 'object') return false;
    const status = String(t.status ?? '').toLowerCase();
    return ['in_progress', 'in-progress', 'inprogress', 'doing', 'active', 'running'].includes(status);
  });

  const pending = todos.find((t: any) => {
    if (!t || typeof t !== 'object') return false;
    const status = String(t.status ?? '').toLowerCase();
    return status === 'pending' || status === 'todo';
  });

  const blocked = todos.find((t: any) => t && typeof t === 'object' && t.status === 'blocked');
  const target = inProgress ?? blocked ?? pending ?? todos.find((t: any) => t && (typeof t === 'string' || !t.status));
  if (!target && todos.every((t: any) => t && ['completed', 'done'].includes(t.status))) return 'Plan steps complete';
  if (!target) return undefined;
  if (typeof target === 'string') return target.trim() || undefined;
  if (typeof target === 'object') {
    const item = target as Record<string, unknown>;
    const text = item.content || item.text || item.title || item.step || item.description;
    if (typeof text === 'string' && text.trim()) return item.status === 'blocked' ? `Blocked: ${text.trim()}` : text.trim();
  }
  return undefined;
}

/**
 * Produce a safe activity item from tool invocation info without leaking raw commands or sensitive arguments.
 */
function safeToolDescription(value: unknown, input?: Record<string, unknown>): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return;
  const text = sanitizeActivityText(value);
  if (!text || /https?:\/\/|\b(?:bearer|password|secret|token|api[_ -]?key|authorization|cookie)\b/i.test(text)
    || /[;&|`$<>]|(?:^|\s)--[\w-]+(?:=|\s)|(?:^|\s)(?:bash|sh|curl|wget|ssh|ls|git|npm|python\d*)\s+-/.test(text)) return;
  // A native title may be the command or argument itself, not a human summary.
  for (const field of ['command', 'cmd', 'url', 'query', 'file_path', 'path']) {
    const argument = input?.[field];
    if (typeof argument === 'string' && argument.trim() && text.includes(argument.trim())) return;
  }
  return text;
}

export function activityFromTool(
  name: string,
  input?: Record<string, unknown>,
  title?: string
): ActivityProgressInfo | undefined {
  const toolName = typeof name === 'string' && /^[\w./:-]{1,100}$/.test(name) ? name : '';
  const safeTitle = safeToolDescription(title, input);

  // If this tool represents todo / plan updates, extract plan item
  const isTodoTool = /^(?:todo_write|todowrite)$/i.test(toolName) || /^(?:todo_write|todowrite|update todos)$/i.test(title ?? '');
  const todoText = extractTodoPlan(input);
  if (todoText && isTodoTool) {
    return normalizeActivity({ source: 'plan', text: todoText });
  }

  // Check for safe description from tool input
  const inputDesc = safeToolDescription(input?.description, input);

  let text: string;
  if (inputDesc) {
    if (safeTitle && !safeTitle.toLowerCase().includes(inputDesc.toLowerCase())) {
      text = `${safeTitle}: ${inputDesc}`;
    } else {
      text = inputDesc;
    }
  } else if (safeTitle) {
    text = safeTitle;
  } else {
    // Map known tool names to safe human-readable descriptions
    const lower = toolName.toLowerCase();
    if (['bash', 'run_command', 'execute_command', 'exec', 'exec_command', 'commandexecution'].includes(lower)) {
      text = 'Running command';
    } else if (lower === 'edit' || lower === 'write_to_file' || lower === 'replace_file_content' || lower === 'filechange') {
      text = 'Editing file';
    } else if (lower === 'read' || lower === 'view_file' || lower === 'read_file') {
      text = 'Reading file';
    } else if (lower === 'websearch' || lower === 'web_search' || lower === 'search_web') {
      text = 'Searching the web';
    } else if (lower === 'glob' || lower === 'grep' || lower === 'search_code' || lower === 'find_files') {
      text = 'Searching code';
    } else if (toolName) {
      text = `Using ${toolName}`;
    } else {
      text = 'Tool execution';
    }
  }

  return normalizeActivity({ source: 'tool', text });
}

/**
 * Activity accumulator and deduplicating emitter helper.
 * Tracks activity across a command turn with clean reset lifecycle.
 */
export class ActivityTracker {
  private lastActivity?: ActivityProgressInfo;
  private callback?: (activity: ActivityProgressInfo) => void;
  private accumulatedPublicText = '';
  private readonly summaries = new Map<string, string>();

  constructor(callback?: (activity: ActivityProgressInfo) => void) {
    this.callback = callback;
  }

  setCallback(callback?: (activity: ActivityProgressInfo) => void): void {
    this.callback = callback;
  }

  getLastActivity(): ActivityProgressInfo | undefined {
    return this.lastActivity ? { ...this.lastActivity } : undefined;
  }

  reset(): void {
    this.lastActivity = undefined;
    this.accumulatedPublicText = '';
    this.summaries.clear();
  }

  emit(candidate: unknown): ActivityProgressInfo | undefined {
    const normalized = normalizeActivity(candidate);
    if (!normalized) return undefined;

    // Deduplicate against the most recent emitted activity
    if (
      this.lastActivity &&
      this.lastActivity.source === normalized.source &&
      this.lastActivity.text === normalized.text
    ) {
      return undefined;
    }

    // Reset cross-source accumulators
    if (normalized.source !== 'public_text') {
      this.accumulatedPublicText = '';
    }
    this.lastActivity = normalized;
    try { this.callback?.({ ...normalized }); } catch { /* Display must not fail execution. */ }
    return normalized;
  }

  emitPublicText(chunk: string): ActivityProgressInfo | undefined {
    if (typeof chunk !== 'string' || !chunk) return undefined;
    if (this.lastActivity && this.lastActivity.source !== 'public_text') {
      this.accumulatedPublicText = '';
    }
    this.accumulatedPublicText = appendBounded(this.accumulatedPublicText, chunk);
    return this.emit({
      source: 'public_text',
      text: latestText(this.accumulatedPublicText),
    });
  }

  emitReasoningSummary(delta: string, key?: string): ActivityProgressInfo | undefined {
    if (typeof delta !== 'string' || !delta) return undefined;
    const boundedKey = typeof key === 'string' && key.length <= 256 ? key : undefined;
    const summary = appendBounded(boundedKey ? this.summaries.get(boundedKey) ?? '' : '', delta);
    if (boundedKey) {
      this.summaries.delete(boundedKey);
      this.summaries.set(boundedKey, summary);
      if (this.summaries.size > ACTIVITY_SUMMARY_KEYS) this.summaries.delete(this.summaries.keys().next().value!);
    }
    return this.emit({
      source: 'reasoning_summary',
      text: latestText(summary),
    });
  }

  emitPlan(text: string): ActivityProgressInfo | undefined {
    if (!text) return undefined;
    return this.emit({
      source: 'plan',
      text,
    });
  }

  emitTool(name: string, input?: Record<string, unknown>, title?: string): ActivityProgressInfo | undefined {
    const activity = activityFromTool(name, input, title);
    if (!activity) return undefined;
    return this.emit(activity);
  }
}

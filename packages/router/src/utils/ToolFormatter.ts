import { DelegationProgressPhase, ToolUseInfo, ToolResultInfo, TaskNotificationInfo, type ExecutionMetadata, type ActivityProgressInfo } from '../types';
import { activityLiteral, parseActivityProgress } from './ActivityProgress';
import { createExecutionMetadataElement } from './ExecutionMetadata';
import { createDiffPanels, createEditPanels, createWritePanels } from './DiffFormatter';
import MarkdownIt from 'markdown-it';
import { formatWorkerResultMarkdown } from './WorkerResultMarkdown';
import { limitCardTables } from './CardTables';
import { workerContextControl } from '../feishu/WorkerContextCards';

/**
 * Feishu Card 2.0 element types
 */
export interface FeishuCardElement {
  tag: string;
  [key: string]: any;
}

/**
 * Tool emoji mapping
 */
const TOOL_EMOJIS: Record<string, string> = {
  Bash: '⚡',
  Read: '📖',
  Write: '✍️',
  Edit: '✏️',
  Grep: '🔍',
  Glob: '📁',
  Task: '🤖',
  WebFetch: '🌐',
  WebSearch: '🔎',
  TodoWrite: '📝',
  AskUserQuestion: '❓',
  Skill: '🎯',
  EnterPlanMode: '📋',
  ExitPlanMode: '✅',
  NotebookEdit: '📓',
};

/**
 * Get emoji for tool name
 */
export function getToolEmoji(toolName: string): string {
  return TOOL_EMOJIS[toolName] || '🔧';
}

/** Tool events may arrive before arguments or use a backend-specific schema. */
function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined) return {};
  return typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : { input };
}

/**
 * Extract context from tool input based on tool type
 */
export function extractToolContext(toolName: string, rawInput: unknown): string {
  const input = normalizeToolInput(rawInput);
  switch (toolName) {
    case 'Bash':
      return extractBashContext(input);
    case 'Read':
      return extractReadContext(input);
    case 'Write':
      return extractWriteContext(input);
    case 'Edit':
      return extractEditContext(input);
    case 'Grep':
      return extractGrepContext(input);
    case 'Glob':
      return extractGlobContext(input);
    case 'Task':
      return extractTaskContext(input);
    case 'WebFetch':
      return extractWebFetchContext(input);
    case 'WebSearch':
      return extractWebSearchContext(input);
    case 'TodoWrite':
      return extractTodoWriteContext(input);
    case 'AskUserQuestion':
      return extractAskUserQuestionContext(input);
    default:
      return formatGenericContext(input);
  }
}

function extractBashContext(input: Record<string, unknown>): string {
  const { command, description } = input;
  if (typeof command !== 'string' || (description != null && typeof description !== 'string')) {
    return formatGenericContext(input);
  }

  if (typeof description === 'string' && description.length > 0 && description.length < 100) {
    return `**${description}**\n\`\`\`bash\n${truncate(command, 500)}\n\`\`\``;
  }

  return `\`\`\`bash\n${truncate(command, 500)}\n\`\`\``;
}

function extractReadContext(input: Record<string, unknown>): string {
  const filePath = input.file_path;
  if (typeof filePath !== 'string') return formatGenericContext(input);
  const offset = input.offset as number | undefined;
  const limit = input.limit as number | undefined;

  let context = `**File:** ${formatFilePath(filePath)}`;

  if (offset !== undefined || limit !== undefined) {
    const rangeInfo = [];
    if (offset !== undefined) rangeInfo.push(`offset: ${offset}`);
    if (limit !== undefined) rangeInfo.push(`limit: ${limit}`);
    context += `\n**Range:** ${rangeInfo.join(', ')}`;
  }

  return context;
}

function extractWriteContext(input: Record<string, unknown>): string {
  const { file_path: filePath, content } = input;
  if (typeof filePath !== 'string' || typeof content !== 'string') return formatGenericContext(input);
  const lines = content.split('\n').length;
  const chars = content.length;

  return `**File:** ${formatFilePath(filePath)}\n**Size:** ${lines} lines, ${chars} chars`;
}

function extractEditContext(input: Record<string, unknown>): string {
  const { file_path: filePath, old_string: oldString, new_string: newString } = input;
  if (typeof filePath !== 'string'
    || (oldString != null && typeof oldString !== 'string')
    || (newString != null && typeof newString !== 'string')) return formatGenericContext(input);

  let context = `**File:** ${formatFilePath(filePath)}`;

  if (typeof oldString === 'string' && typeof newString === 'string' && oldString && newString) {
    const oldLines = oldString.split('\n').length;
    const newLines = newString.split('\n').length;
    context += `\n**Change:** ${oldLines} → ${newLines} lines`;
  }

  return context;
}

function looksLikeDiff(content: string): boolean {
  return /^(?:diff --git |--- .*\n\+\+\+ |@@ .* @@)/m.test(content) && /^(?:\+\+\+|---|@@|[+-][^+-])/m.test(content);
}

function extractGrepContext(input: Record<string, unknown>): string {
  const { pattern, path } = input;
  if (typeof pattern !== 'string' || (path != null && typeof path !== 'string')) return formatGenericContext(input);
  const glob = input.glob as string | undefined;
  const type = input.type as string | undefined;

  let context = `**Pattern:** \`${truncate(pattern, 100)}\``;

  if (typeof path === 'string' && path) {
    context += `\n**Path:** ${formatFilePath(path)}`;
  }

  if (glob) {
    context += `\n**Glob:** \`${glob}\``;
  }

  if (type) {
    context += `\n**Type:** ${type}`;
  }

  return context;
}

function extractGlobContext(input: Record<string, unknown>): string {
  const { pattern, path } = input;
  if (typeof pattern !== 'string' || (path != null && typeof path !== 'string')) return formatGenericContext(input);

  let context = `**Pattern:** \`${pattern}\``;

  if (typeof path === 'string' && path) {
    context += `\n**Path:** ${formatFilePath(path)}`;
  }

  return context;
}

function extractTaskContext(input: Record<string, unknown>): string {
  const { subagent_type: subagentType, description, prompt } = input;
  if (typeof subagentType !== 'string'
    || (description != null && typeof description !== 'string')
    || (prompt != null && typeof prompt !== 'string')) return formatGenericContext(input);

  let context = `**Agent:** ${subagentType}`;

  if (typeof description === 'string' && description) {
    context += `\n**Task:** ${truncate(description, 100)}`;
  }

  if (typeof prompt === 'string' && prompt && prompt.length < 200) {
    context += `\n**Prompt:** ${truncate(prompt, 150)}`;
  }

  return context;
}

function extractWebFetchContext(input: Record<string, unknown>): string {
  const { url, prompt } = input;
  if (typeof url !== 'string' || (prompt != null && typeof prompt !== 'string')) return formatGenericContext(input);

  let context = `**URL:** ${url}`;

  if (typeof prompt === 'string' && prompt && prompt.length < 150) {
    context += `\n**Prompt:** ${truncate(prompt, 100)}`;
  }

  return context;
}

function extractWebSearchContext(input: Record<string, unknown>): string {
  const query = input.query;
  if (typeof query !== 'string') return formatGenericContext(input);

  return `**Query:** ${truncate(query, 150)}`;
}

function extractTodoWriteContext(input: Record<string, unknown>): string {
  const todos = input.todos;
  if (todos != null && !Array.isArray(todos)) return formatGenericContext(input);

  if (!Array.isArray(todos) || todos.length === 0) {
    return '**Updating todo list**';
  }

  return `**Todos:** ${todos.length} items`;
}

function extractAskUserQuestionContext(input: Record<string, unknown>): string {
  const questions = input.questions;
  if (questions != null && !Array.isArray(questions)) return formatGenericContext(input);

  if (!Array.isArray(questions) || questions.length === 0) {
    return '**Asking user question**';
  }

  if (questions.length === 1) {
    if (typeof questions[0]?.question !== 'string') return formatGenericContext(input);
    return `**Question:** ${truncate(questions[0].question, 150)}`;
  }

  return `**Questions:** ${questions.length} items`;
}

function formatGenericContext(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) {
    return '_(no parameters)_';
  }

  const summary = keys.slice(0, 3).map(key => {
    const value = input[key];
    const valueStr = typeof value === 'string' ? truncate(value, 50)
      : truncate(JSON.stringify(value) ?? String(value), 200);
    return `**${key}:** ${valueStr}`;
  }).join('\n');

  if (keys.length > 3) {
    return `${summary}\n_...and ${keys.length - 3} more_`;
  }

  return summary;
}

/**
 * Format file path for display (shorten home directory)
 */
export function formatFilePath(filePath: string): string {
  const homeDir = process.env.HOME || '/Users';
  if (filePath.startsWith(homeDir)) {
    return `~${filePath.slice(homeDir.length)}`;
  }
  return filePath;
}

/**
 * Truncate string to max length
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Create a Feishu Card 2.0 divider element
 */
export function createDividerElement(): FeishuCardElement {
  return { tag: 'hr' };
}

const cardMarkdownParser = new MarkdownIt('commonmark');

/** Keep image files on the upload channel instead of treating their paths as Feishu keys. */
function sanitizeMarkdownImages(content: string): string {
  if (!content.includes('![')) return content;
  const sanitizeText = (text: string): string => text.replace(
    /(`+)([\s\S]*?)\1(?!`)|<raw>[\s\S]*?(?:<\/raw>|$)|\\[\s\S]|!\[((?:\\.|[^\]\\])*)\](?:\(\s*(<[^>\r\n]*>|(?:\\.|[^\s()\\]|\([^()\r\n]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)|\[[^\]\r\n]*\])?/gi,
    (token: string, _code: string, _body: string, label: string | undefined, destination: string | undefined) => {
      if (label === undefined || (destination && !label.includes('[') && /^(?:img_[\w-]+|<img_[\w-]+>)$/.test(destination))) return token;
      const caption = (label.replace(/\\(.)/g, '$1') || 'Image')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<raw>${caption}</raw>`;
    },
  );

  // Use parsed block boundaries: indentation can belong to a list or paragraph,
  // and an unclosed fence ends when its quote or list container ends.
  const lineOffsets = [0];
  for (const newline of content.matchAll(/\r\n|\r|\n/g)) {
    lineOffsets.push(newline.index! + newline[0].length);
  }
  let output = '';
  let offset = 0;
  for (const token of cardMarkdownParser.parse(content, {})) {
    if (!token.map || (token.type !== 'fence' && token.type !== 'code_block')) continue;
    const start = lineOffsets[token.map[0]] ?? content.length;
    const end = lineOffsets[token.map[1]] ?? content.length;
    output += sanitizeText(content.slice(offset, start)) + content.slice(start, end);
    offset = end;
  }
  return output + sanitizeText(content.slice(offset));
}

/**
 * Create a Feishu Card 2.0 markdown element
 */
export function createMarkdownElement(content: string): FeishuCardElement {
  return {
    tag: 'markdown',
    content: sanitizeMarkdownImages(content),
  };
}

/**
 * Create a Feishu Card 2.0 image element from an uploaded image key.
 */
export function createImageElement(imageKey: string): FeishuCardElement {
  return {
    tag: 'img',
    img_key: imageKey,
    mode: 'fit_horizontal',
    alt: { tag: 'plain_text', content: 'Generated image' },
  };
}

/**
 * Create a Feishu Card 2.0 tool use element with collapsible panel
 */
export function createToolUseElement(toolInfo: ToolUseInfo): FeishuCardElement[] {
  const { name, id } = toolInfo;
  const input = normalizeToolInput(toolInfo.input);
  const emoji = getToolEmoji(name);
  const context = extractToolContext(name, input);

  // Build header title
  let headerTitle = `<text_tag color='blue'>${emoji} TOOL USE</text_tag> · **${name}**`;
  if (id && id !== 'unknown') {
    headerTitle += ` · \`${id.slice(0, 8)}\``;
  }

  const diffPanels = name === 'Edit' ? createEditPanels(input, headerTitle)
    : name === 'Write' ? createWritePanels(input, headerTitle) : null;
  if (diffPanels) return [createDividerElement(), ...diffPanels];

  // Create collapsible panel with tool details inside
  const collapsiblePanel: FeishuCardElement = {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'markdown',
        content: headerTitle,
      },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '14px 14px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    vertical_spacing: '8px',
    padding: '4px 8px',
    elements: [
      createMarkdownElement(context),
    ],
  };

  return [
    createDividerElement(),
    collapsiblePanel,
  ];
}

/**
 * Create a Feishu Card 2.0 tool result element with collapsible panel
 */
export function createToolResultElement(resultInfo: ToolResultInfo): FeishuCardElement[] {
  const { tool_use_id, content, is_error, diff } = resultInfo;

  // Determine status
  const statusColor = is_error ? 'red' : 'green';
  const statusText = is_error ? 'ERROR' : 'SUCCESS';
  const statusEmoji = is_error ? '❌' : '✅';

  // Build header title with status, emoji, and tool_use_id
  let headerTitle = `<text_tag color='${statusColor}'>${statusEmoji} ${statusText}</text_tag>`;
  if (tool_use_id && tool_use_id !== 'unknown') {
    headerTitle += ` · \`${tool_use_id.slice(0, 8)}\``;
  }

  // Prepare content elements inside the collapsible panel
  const panelElements: FeishuCardElement[] = [];

  if (!is_error && (diff || looksLikeDiff(content))) {
    const panels = createDiffPanels(diff || content, headerTitle);
    if (content && !looksLikeDiff(content) && panels[0]?.elements) {
      panels[0].elements.unshift(createMarkdownElement(`\`\`\`\n${truncate(content, 500)}\n\`\`\``));
    }
    return panels;
  }

  if (content && !is_error) {
    panelElements.push(createMarkdownElement(`\`\`\`\n${truncate(content, 500)}\n\`\`\``));
  } else if (content && is_error) {
    // For errors, show the error message
    const truncated = truncate(content, 500);
    panelElements.push(createMarkdownElement(truncated));
  } else {
    // No content
    panelElements.push(createMarkdownElement('_(no output)_'));
  }

  // Create collapsible panel with result details inside
  const collapsiblePanel: FeishuCardElement = {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'markdown',
        content: headerTitle,
      },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '14px 14px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    vertical_spacing: '8px',
    padding: '4px 8px',
    elements: panelElements,
  };

  return [collapsiblePanel];
}

/** Retain rendered previews, not the backend's potentially unbounded payloads. */
export interface ToolCallCardState {
  /** Router-owned fixed slot; never derived from a backend-provided tool ID. */
  elementIndex?: number;
  name?: string;
  id?: string;
  inputElements?: FeishuCardElement[];
  resultElements?: FeishuCardElement[];
  isError?: boolean;
}

export const TOOL_CALL_ELEMENT_PREFIX = 'tc_';

/** Inline existing bounded previews inside one tool-call disclosure. */
function inlineToolDetails(elements: FeishuCardElement[], label: string): FeishuCardElement[] {
  return elements.flatMap(element => {
    if (element.tag === 'hr') return [];
    if (element.tag !== 'collapsible_panel') return [element];
    const children: FeishuCardElement[] = element.elements ?? [];
    // Diff headers carry file names and change counts that must remain available.
    const fileHeader = children.some(child => child.tag === 'markdown' && child.content?.startsWith('**File:**'))
      ? element.header?.title?.content : undefined;
    const heading = [`**${label}**`, fileHeader].filter(Boolean).join('\n');
    if (children[0]?.tag === 'markdown') {
      return [{ ...children[0], content: `${heading}\n\n${children[0].content}` }, ...children.slice(1)];
    }
    return [createMarkdownElement(heading), ...children];
  });
}

/** A result replaces the same visible tool row; independent calls never aggregate. */
export function createToolCallElement(state: ToolCallCardState): FeishuCardElement {
  const received = state.resultElements !== undefined;
  const color = received ? state.isError ? 'red' : 'green' : 'blue';
  const status = received ? state.isError ? '❌ ERROR' : '✅ SUCCESS' : '🔧 TOOL USE';
  const name = literalWorkerText(state.name || 'Tool', 100);
  const id = state.id && state.id !== 'unknown' ? ` · ${literalWorkerText(state.id, 8)}` : '';
  return {
    tag: 'collapsible_panel', expanded: false,
    ...(state.elementIndex !== undefined ? { element_id: `${TOOL_CALL_ELEMENT_PREFIX}${state.elementIndex}` } : {}),
    header: {
      title: { tag: 'markdown', content: `<text_tag color='${color}'>${status}</text_tag> · **${name}**${id}` },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '14px 14px' },
      icon_position: 'right', icon_expanded_angle: -180,
    },
    vertical_spacing: '8px', padding: '4px 8px',
    elements: [
      ...inlineToolDetails(state.inputElements ?? [], 'Input'),
      ...inlineToolDetails(state.resultElements ?? [], 'Result'),
    ],
  };
}

export interface DelegationProgressEvent {
  label: string;
  isError?: boolean;
  toolId?: string;
}

export interface DelegationProgressCardState {
  contextActionId?: string;
  taskId: string;
  backend: string;
  phase: DelegationProgressPhase;
  executionMetadata?: ExecutionMetadata;
  startedAt: number;
  ordinal: number;
  finishedAt?: number;
  objective?: string;
  inputRequest?: string;
  summary?: string;
  error?: string;
  /** Most recent bounded worker-visible text. Never contains raw reasoning or tool payloads. */
  latestText?: string;
  activity?: ActivityProgressInfo;
  currentToolName?: string;
  currentToolStartedAt?: number;
  /** Updated only by real tool use/result callbacks, never by text or card heartbeats. */
  lastToolActivityAt?: number;
  /** Receipt of real progress, not a render-time heartbeat or a liveness deadline. */
  lastActivityAt?: number;
  toolErrorCount?: number;
  activeToolCount: number;
  events: DelegationProgressEvent[];
  hiddenEventCount: number;
}

const DELEGATION_BACKEND_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  agy: 'AGY',
  opencode: 'OpenCode',
  kimi: 'Kimi Code',
  zcode: 'ZCode',
  dsh: 'DSH',
};

const DELEGATION_PROGRESS_STYLES: Record<DelegationProgressPhase, { color: string; label: string; terminal: boolean }> = {
  started: { color: 'blue', label: 'Starting', terminal: false },
  text: { color: 'blue', label: 'Running', terminal: false },
  tool_use: { color: 'blue', label: 'Running', terminal: false },
  tool_result: { color: 'blue', label: 'Running', terminal: false },
  waiting_input: { color: 'orange', label: 'Input needed', terminal: false },
  succeeded: { color: 'green', label: 'Completed', terminal: true },
  failed: { color: 'red', label: 'Failed', terminal: true },
  cancelled: { color: 'neutral', label: 'Cancelled', terminal: true },
  timed_out: { color: 'orange', label: 'Timed out', terminal: true },
  interrupted: { color: 'orange', label: 'Interrupted', terminal: true },
};

const FALLBACK_DELEGATION_PROGRESS_STYLE = { color: 'grey', label: 'Updating', terminal: false };
// Accept the entire negotiated 1200-byte snapshot, including its latest words.
const DELEGATION_CURRENT_ACTIVITY_LIMIT = 1200;
export const DELEGATION_PROGRESS_ELEMENT_COUNT = 4;

/** Escape untrusted worker text so it cannot become Feishu card markup. */
function literalWorkerText(value: string, limit: number): string {
  const characters = Array.from(value.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim());
  const shortened = characters.length > limit
    ? `${characters.slice(0, Math.max(0, limit - 1)).join('')}…`
    : characters.join('');
  return `<raw>${shortened.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</raw>`;
}

function delegationElapsed(startedAt: number, endedAt = Date.now()): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function lastWorkerActivity(timestamp?: number): string {
  if (timestamp === undefined) return 'waiting for output';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function delegatedCurrentActivity(state: DelegationProgressCardState): string {
  if (state.phase === 'waiting_input') return 'Waiting for user input';
  return state.phase === 'started' ? 'Starting…' : 'Waiting for output…';
}

interface DelegationContentSection {
  content: string;
  label?: string;
  labelColor?: string;
}

/** Keep fixed progress labels visually separate from untrusted worker Markdown. */
function createDelegationContentBody(sections: DelegationContentSection[]): FeishuCardElement {
  const elements = sections.flatMap(section => {
    const content = createMarkdownElement(section.content);
    if (!section.label) return [content];
    return [
      {
        tag: 'markdown',
        content: `<font color='${section.labelColor ?? 'grey'}'>${section.label}</font>`,
        text_size: 'notation',
      },
      content,
    ];
  });
  return limitCardTables({
    tag: 'column_set', flex_mode: 'none',
    columns: [{ tag: 'column', width: 'weighted', weight: 1, elements }],
  });
}

/** Four stable sibling slots: identity, visible content, metadata, folded diagnostics. */
export function createDelegationProgressElements(state: DelegationProgressCardState): FeishuCardElement[] {
  const style = DELEGATION_PROGRESS_STYLES[state.phase] ?? FALLBACK_DELEGATION_PROGRESS_STYLE;
  const backend = DELEGATION_BACKEND_LABELS[state.backend] ?? 'Agent';
  const ordinal = Number.isSafeInteger(state.ordinal) && state.ordinal > 0 ? state.ordinal : 1;
  const currentTool = state.currentToolName && !style.terminal
    ? `${literalWorkerText(state.currentToolName, 120)}${state.activeToolCount > 1 ? ` · ${state.activeToolCount} tools active` : ''}`
    : undefined;
  const primary: DelegationContentSection[] = [];
  const publicActivity = parseActivityProgress(state.activity);
  if (state.phase === 'waiting_input') {
    primary.push({
      label: 'Your input is needed', labelColor: 'orange',
      content: state.inputRequest ? formatWorkerResultMarkdown(state.inputRequest) : '_Check the input or approval request._',
    });
  }
  if (style.terminal && state.error) {
    primary.push({ label: 'Reason', labelColor: 'red', content: formatWorkerResultMarkdown(state.error) });
  }
  if (style.terminal && state.summary) {
    primary.push({ label: 'Result excerpt', content: formatWorkerResultMarkdown(state.summary) });
  } else if (publicActivity && state.phase !== 'waiting_input') {
    primary.push({ label: style.terminal ? 'Last activity · not a final result' : 'Activity',
      content: activityLiteral(publicActivity.text) });
  } else if (state.latestText && state.phase !== 'waiting_input') {
    primary.push({
      label: style.terminal ? 'Last activity · not a final result' : 'Latest update',
      content: formatWorkerResultMarkdown(state.latestText, DELEGATION_CURRENT_ACTIVITY_LIMIT, 'activity'),
    });
  } else if (!primary.length) {
    primary.push({ content: style.terminal ? '_No result text was received._' : currentTool || delegatedCurrentActivity(state) });
  }
  const updated = !style.terminal && state.lastActivityAt !== undefined
    ? ` · Updated ${lastWorkerActivity(state.lastActivityAt)}` : '';
  const metadata = [`${delegationElapsed(state.startedAt, state.finishedAt)}${updated}`];
  if (currentTool && (state.latestText || publicActivity) && state.phase !== 'waiting_input') metadata.push(currentTool);
  if (state.toolErrorCount) {
    const location = state.events.some(event => event.isError) ? 'see activity details' : 'earlier details omitted';
    metadata.push(`<font color='orange'>${state.toolErrorCount} tool issue${state.toolErrorCount === 1 ? '' : 's'} · ${location}</font>`);
  }
  const executionNote = state.executionMetadata?.backend === state.backend
    ? createExecutionMetadataElement(state.executionMetadata) : undefined;
  if (executionNote) metadata.push(executionNote.content);
  const activity = state.events.map(event => `- ${event.isError ? "<text_tag color='red'>Failed</text_tag> " : ''}${literalWorkerText(event.label, 220)}`);
  if (state.hiddenEventCount > 0) activity.push(`\n_${state.hiddenEventCount} earlier activities omitted._`);
  const toolDetails = currentTool
    ? `Current tool: ${currentTool}${state.currentToolStartedAt !== undefined ? ` · ${delegationElapsed(state.currentToolStartedAt)}` : ''}`
    : undefined;
  const elements: FeishuCardElement[] = [
    {
      // Stretch stacks these columns on phones; keep the status beside the identity.
      tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [
          { tag: 'markdown', content: `**${backend}** <font color='grey'>· #${ordinal}</font>`,
            icon: { tag: 'standard_icon', token: 'robot_outlined', color: 'purple' } },
        ] },
        { tag: 'column', width: 'auto', vertical_align: 'center', elements: [
          { tag: 'markdown', content: `<text_tag color='${style.color}'>${style.label}</text_tag>`, text_align: 'right' },
        ] },
      ],
    },
    createDelegationContentBody(primary),
    { tag: 'markdown', content: metadata.join('\n'), text_size: 'notation' },
    {
      tag: 'collapsible_panel', expanded: false,
      header: {
        title: { tag: 'markdown', content: 'Activity details' },
        vertical_align: 'center',
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '14px 14px' },
        icon_position: 'right', icon_expanded_angle: -180,
      },
      vertical_spacing: '8px', padding: '4px 8px',
      elements: [{ tag: 'markdown', content: [toolDetails, activity.join('\n') || '_No tool activity yet._'].filter(Boolean).join('\n\n'), text_size: 'notation' }],
    },
  ];
  if (state.contextActionId) {
    elements[3] = { tag: 'column_set', flex_mode: 'none', columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [elements[3], workerContextControl(state.contextActionId)] },
    ] };
  }
  for (const [index, suffix] of ['header', 'body', 'meta', 'details'].entries()) {
    elements[index].element_id = `dw_${ordinal}_${suffix}`;
  }
  return elements;
}

/**
 * Create a Feishu Card 2.0 redacted thinking element
 * Displays a user-friendly notification when AI reasoning is filtered by safety systems
 */
export function createRedactedThinkingElement(): FeishuCardElement[] {
  return [
    createDividerElement(),
    {
      tag: 'markdown',
      content: '💭 *Some reasoning was filtered by safety systems and is not displayed.*\n*(This does not affect the response quality - the AI can still use this reasoning internally)*',
    }
  ];
}

/**
 * Create a Feishu Card 2.0 background task notification element
 *
 * Rendered as a standalone card when a Claude Code 2.x background task
 * reaches a terminal state (completed/failed/stopped). The card is not part
 * of any streaming session — it is sent as a one-shot interactive message.
 * Keep task identity and status visible while collapsing detailed results.
 */
export function createTaskNotificationElement(info: TaskNotificationInfo, threadName?: string): FeishuCardElement[] {
  const { taskId, status, summary, outputFile } = info;
  const summaryLimit = 1500;
  // Bound UTF-16 input with a truncation signal, without retaining a split surrogate pair.
  const summarySource = summary.slice(0, (summaryLimit + 1) * 2).replace(/[\uD800-\uDBFF]$/, '');

  const statusConfig: Record<string, { color: string; text: string }> = {
    completed: { color: 'green', text: 'Completed' },
    failed: { color: 'red', text: 'Failed' },
    stopped: { color: 'orange', text: 'Stopped' },
  };
  // Unknown future statuses get a neutral label instead of being mislabeled
  const { color, text } = typeof status === 'string' && Object.prototype.hasOwnProperty.call(statusConfig, status)
    ? statusConfig[status] : { color: 'grey', text: 'Ended' };

  const elements: FeishuCardElement[] = [
    createMarkdownElement(`**🛰️ Background task** <text_tag color='${color}'>${text}</text_tag>`),
    { tag: 'markdown', text_size: 'notation',
      content: `${threadName ? `🧵 ${literalWorkerText(threadName, 60)} · ` : ''}Task ${literalWorkerText(taskId, 16)}` },
  ];

  if (status === 'failed') {
    // Bound parsing work, then remove Markdown structure from the visible preview.
    const preview = cardMarkdownParser.parse(summarySource, {}).flatMap(token => {
      if (token.type === 'inline') return [(token.children ?? []).map(child => {
        if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
        return ['text', 'code_inline', 'image', 'html_inline'].includes(child.type) ? child.content : '';
      }).join('')];
      return token.type === 'fence' || token.type === 'code_block' ? [token.content] : [];
    }).join(' ').trim();
    elements.push({ ...createMarkdownElement(`**Failure summary:** ${literalWorkerText(
      preview || 'No failure summary available in this preview. Open details for any output.', 120,
    )}`), text_size: 'notation' });
  }

  const bodyLines: string[] = [];
  bodyLines.push(summary.trim() ? formatWorkerResultMarkdown(summarySource, summaryLimit) : '_(no summary)_');
  if (typeof outputFile === 'string' && outputFile) {
    bodyLines.push(`\n**Output:** ${literalWorkerText(outputFile, 200)}`);
  }

  const collapsiblePanel: FeishuCardElement = {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'markdown',
        content: 'View details',
      },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '14px 14px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    vertical_spacing: '8px',
    padding: '4px 8px',
    elements: [
      limitCardTables(createMarkdownElement(bodyLines.join('\n'))),
    ],
  };

  elements.push(collapsiblePanel, {
    ...createMarkdownElement('💬 *Reply to this card to continue working in this thread.*'), text_size: 'notation',
  });
  return elements;
}

/**
 * Create a Feishu Card 2.0 plan mode element
 * Displays the plan Claude produced between EnterPlanMode and ExitPlanMode.
 * Execution is auto-approved; this element is for user visibility only.
 */
export function createPlanModeElement(planContent: string): FeishuCardElement[] {
  const headerTitle = `<text_tag color='blue'>📋 PLAN</text_tag> · *Auto-approved*`;

  const collapsiblePanel: FeishuCardElement = {
    tag: 'collapsible_panel',
    expanded: true,
    header: {
      title: {
        tag: 'markdown',
        content: headerTitle,
      },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '14px 14px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    vertical_spacing: '8px',
    padding: '4px 8px',
    elements: [
      createMarkdownElement(truncate(planContent, 2000)),
    ],
  };

  return [
    createDividerElement(),
    collapsiblePanel,
  ];
}

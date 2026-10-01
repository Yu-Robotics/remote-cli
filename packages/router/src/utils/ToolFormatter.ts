import { DelegationProgressPhase, ToolUseInfo, ToolResultInfo, TaskNotificationInfo } from '../types';
import { createDiffPanels, createEditPanels, createWritePanels } from './DiffFormatter';
import MarkdownIt from 'markdown-it';

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

export interface DelegationProgressEvent {
  label: string;
  isError?: boolean;
}

export interface DelegationProgressCardState {
  taskId: string;
  backend: string;
  phase: DelegationProgressPhase;
  startedAt: number;
  objective?: string;
  inputRequest?: string;
  summary?: string;
  error?: string;
  /** Most recent bounded worker-visible text. Never contains raw reasoning or tool payloads. */
  latestText?: string;
  currentToolName?: string;
  currentToolStartedAt?: number;
  /** Updated only by real tool use/result callbacks, never by text or card heartbeats. */
  lastToolActivityAt?: number;
  activeToolCount: number;
  events: DelegationProgressEvent[];
  hiddenEventCount: number;
}

const DELEGATION_BACKEND_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  pi: 'Pi',
  agy: 'AGY CLI',
  opencode: 'OpenCode',
  kimi: 'Kimi Code',
  zcode: 'ZCode',
};

const DELEGATION_PROGRESS_STYLES: Record<DelegationProgressPhase, { color: string; icon: string; label: string; terminal: boolean }> = {
  started: { color: 'blue', icon: '🤖', label: 'WORKER STARTED', terminal: false },
  text: { color: 'blue', icon: '🤖', label: 'WORKER RUNNING', terminal: false },
  tool_use: { color: 'blue', icon: '⚙️', label: 'WORKER RUNNING', terminal: false },
  tool_result: { color: 'blue', icon: '⚙️', label: 'WORKER RUNNING', terminal: false },
  waiting_input: { color: 'orange', icon: '⌨️', label: 'WAITING FOR INPUT', terminal: false },
  succeeded: { color: 'green', icon: '✅', label: 'WORKER COMPLETED', terminal: true },
  failed: { color: 'red', icon: '❌', label: 'WORKER FAILED', terminal: true },
  cancelled: { color: 'neutral', icon: '⏹️', label: 'WORKER CANCELLED', terminal: true },
  timed_out: { color: 'orange', icon: '⏱️', label: 'WORKER TIMED OUT', terminal: true },
  interrupted: { color: 'orange', icon: '⚠️', label: 'WORKER INTERRUPTED', terminal: true },
};

const FALLBACK_DELEGATION_PROGRESS_STYLE = { color: 'grey', icon: '🤖', label: 'WORKER UPDATE', terminal: false };

/** Escape untrusted worker text so it cannot become Feishu card markup. */
function literalWorkerText(value: string, limit: number): string {
  const characters = Array.from(value.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim());
  const shortened = characters.length > limit
    ? `${characters.slice(0, Math.max(0, limit - 1)).join('')}…`
    : characters.join('');
  return `<raw>${shortened.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</raw>`;
}

function delegationElapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function lastToolActivity(timestamp?: number): string {
  if (!timestamp) return 'no tool activity yet';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function delegatedCurrentActivity(state: DelegationProgressCardState, terminal: boolean): string {
  if (terminal) return 'Task finished';
  if (state.phase === 'waiting_input') return 'Waiting for user input';
  if (state.latestText) return state.latestText;
  if (state.currentToolName) {
    const duration = state.currentToolStartedAt ? ` · running for ${delegationElapsed(state.currentToolStartedAt)}` : '';
    return `${state.currentToolName}${duration}`;
  }
  return state.phase === 'started' ? 'Starting worker session' : 'Preparing the next step';
}

/** Render bounded worker progress inside the coordinator's card. */
export function createDelegationProgressElement(state: DelegationProgressCardState): FeishuCardElement {
  const style = DELEGATION_PROGRESS_STYLES[state.phase] ?? FALLBACK_DELEGATION_PROGRESS_STYLE;
  const backend = DELEGATION_BACKEND_LABELS[state.backend] ?? 'Agent';
  const status = state.activeToolCount > 0 && !style.terminal
    ? `${style.label} · ${state.activeToolCount} active tool${state.activeToolCount === 1 ? '' : 's'}`
    : style.label;
  const headerTitle = `<text_tag color='${style.color}'>${style.icon} ${style.label}</text_tag> · **${backend}** · Delegated task`;
  const body: string[] = [];

  if (!style.terminal) {
    const currentActivityLimit = state.latestText ? 1_200 : 260;
    body.push(`**Current activity:** ${literalWorkerText(delegatedCurrentActivity(state, style.terminal), currentActivityLimit)}`);
    if (state.latestText && state.currentToolName) {
      const duration = state.currentToolStartedAt ? ` · running for ${delegationElapsed(state.currentToolStartedAt)}` : '';
      body.push(`**Current tool:** ${literalWorkerText(`${state.currentToolName}${duration}`, 260)}`);
    }
    body.push(`**Elapsed:** ${delegationElapsed(state.startedAt)} · **Last tool activity:** ${lastToolActivity(state.lastToolActivityAt)}`);
  } else {
    body.push(`**Status:** ${literalWorkerText(status, 120)}`);
    body.push(`**Elapsed:** ${delegationElapsed(state.startedAt)}`);
  }

  if (state.events.length > 0) {
    body.push('\n**Recent activity:**');
    body.push(...state.events.map(event => `- ${event.isError ? '❌ ' : ''}${literalWorkerText(event.label, 220)}`));
    if (state.hiddenEventCount > 0) body.push(`- _${state.hiddenEventCount} earlier event${state.hiddenEventCount === 1 ? '' : 's'} hidden_`);
  }
  if (state.phase === 'waiting_input' && state.inputRequest) {
    body.push(`\n**Input request:** ${literalWorkerText(state.inputRequest, 1000)}`);
  }
  if (style.terminal && state.summary) {
    body.push(`\n**Result:** ${literalWorkerText(state.summary, 1000)}`);
  }
  if (style.terminal && state.error) {
    body.push(`\n**Reason:** ${literalWorkerText(state.error, 1000)}`);
  }

  return {
    tag: 'collapsible_panel',
    expanded: !style.terminal,
    header: {
      title: { tag: 'markdown', content: headerTitle },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '14px 14px' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    vertical_spacing: '8px',
    padding: '4px 8px',
    elements: [createMarkdownElement(body.join('\n'))],
  };
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
 * Expanded by default: this is the final result of the task, not noise.
 */
export function createTaskNotificationElement(info: TaskNotificationInfo, threadName?: string): FeishuCardElement[] {
  const { taskId, status, summary, outputFile } = info;

  const statusConfig: Record<string, { color: string; emoji: string; text: string }> = {
    completed: { color: 'green', emoji: '✅', text: 'TASK COMPLETED' },
    failed: { color: 'red', emoji: '❌', text: 'TASK FAILED' },
    stopped: { color: 'orange', emoji: '⏹️', text: 'TASK STOPPED' },
  };
  // Unknown future statuses get a neutral label instead of being mislabeled
  const { color, emoji, text } = statusConfig[status] || { color: 'grey', emoji: '⚪', text: 'TASK ENDED' };

  let headerTitle = `<text_tag color='${color}'>${emoji} ${text}</text_tag>`;
  if (threadName) {
    headerTitle += ` · **${threadName}**`;
  }
  headerTitle += ` · \`${truncate(taskId, 16)}\``;

  const bodyLines: string[] = [];
  bodyLines.push(summary.trim() ? truncate(summary, 1500) : '_(no summary)_');
  if (outputFile) {
    bodyLines.push(`\n**Output:** \`${truncate(outputFile, 200)}\``);
  }

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
      createMarkdownElement(bodyLines.join('\n')),
    ],
  };

  return [
    collapsiblePanel,
    createMarkdownElement('💬 *Reply to this card to continue working in this thread.*'),
  ];
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

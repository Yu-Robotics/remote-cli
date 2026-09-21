export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export interface PiLaunchOptions {
  command?: string;
  cwd?: string;
  /** Whether Pi should trust project-local resources for this non-interactive run. */
  approveProject?: boolean;
  sessionDir?: string;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  provider?: string;
  model?: string;
  thinking?: string;
}

export interface PiRpcResponse {
  type: 'response';
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: any;
}

export interface PiModel {
  id: string;
  name?: string;
  provider?: string;
  reasoning?: boolean;
  input?: string[];
}

export interface PiTransport {
  start(): Promise<void>;
  request(command: Record<string, unknown>, timeoutMs?: number): Promise<PiRpcResponse>;
  send(message: Record<string, unknown>): void;
  onEvent(handler: (event: Record<string, any>) => void): () => void;
  stop(): Promise<void>;
  isRunning(): boolean;
  updateLaunch?(partial: Partial<PiLaunchOptions>): void;
}

export function isPiThinkingLevel(value: string): value is PiThinkingLevel {
  return (PI_THINKING_LEVELS as readonly string[]).includes(value);
}

/** Parse `provider/id` when present; otherwise treat the whole string as a model id. */
export function parsePiModelRef(value: string): { provider?: string; modelId: string } {
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash > 0 && slash < trimmed.length - 1) {
    return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
  }
  return { modelId: trimmed };
}

export function formatPiModelRef(model: Pick<PiModel, 'id' | 'provider'>): string {
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

export function buildPiRpcArgs(options: PiLaunchOptions): { command: string; args: string[] } {
  const command = options.command ?? 'pi';
  const args = ['--mode', 'rpc'];
  if (options.approveProject === true) args.push('--approve');
  else if (options.approveProject === false) args.push('--no-approve');
  if (options.sessionFile) {
    args.push('--session', options.sessionFile);
  } else {
    if (options.sessionDir) args.push('--session-dir', options.sessionDir);
    if (options.sessionId) args.push('--session-id', options.sessionId);
  }
  if (options.sessionName) args.push('--name', options.sessionName);
  if (options.provider && !options.model?.includes('/')) {
    args.push('--provider', options.provider);
  }
  if (options.model) args.push('--model', options.model);
  if (options.thinking) args.push('--thinking', options.thinking);
  return { command, args };
}

/**
 * Split a JSONL buffer on LF only. Trailing CR is stripped so `\r\n` works,
 * but Unicode line separators stay inside the JSON record (pi RPC requirement).
 */
export function consumeJsonl(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buffer;
  while (true) {
    const newlineIndex = rest.indexOf('\n');
    if (newlineIndex === -1) break;
    let line = rest.slice(0, newlineIndex);
    rest = rest.slice(newlineIndex + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length > 0) lines.push(line);
  }
  return { lines, rest };
}

import { ChildProcess, spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { readFileSync } from 'fs';
import type { AcpEventCallbacks, AcpToolCallUpdate, AcpTransport } from '../acp/AcpClient';
import type { AcpConfigOption, AcpContentBlock, AcpPermissionOption, AcpSessionResult } from '../acp/AcpTypes';
import { resolveZCodeLaunch, type ZCodeLaunchSpec } from './ZCodeCommand';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActivePrompt {
  resolve: (value: { stopReason: string }) => void;
  reject: (error: Error) => void;
  turnId?: string;
  tools: Map<string, AcpToolCallUpdate>;
}

interface ZCodeModel {
  ref?: { providerId?: string; modelId?: string };
  reasoning?: { defaultLevel?: string; levels?: Array<{ value?: string }> };
}

interface SessionState {
  currentModel?: { providerId?: string; modelId?: string };
  currentThought?: string;
  models: ZCodeModel[];
}

interface PendingInteraction {
  ids: Array<number | string>;
  result?: Record<string, unknown>;
}

export interface ZCodeClientOptions {
  cwd: string;
  command?: string;
  autoApprove?: boolean;
  requestTimeoutMs?: number;
  compactPollIntervalMs?: number;
  launch?: ZCodeLaunchSpec;
}

const KILL_GRACE_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** Direct client for the official ZCode app-server line-delimited JSON protocol. */
export class ZCodeClient implements AcpTransport {
  private readonly child: ChildProcess;
  private readonly callbacks: AcpEventCallbacks;
  private readonly cwd: string;
  private readonly autoApprove: boolean;
  private readonly requestTimeoutMs: number;
  private readonly compactPollIntervalMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly prompts = new Map<string, ActivePrompt>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly interactions = new Map<string, PendingInteraction>();
  private readonly sequence = new Map<string, number>();
  private readonly reader: readline.Interface;
  private nextId = 1;
  private destroyed = false;
  private closed = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ZCodeClientOptions, callbacks: AcpEventCallbacks) {
    this.callbacks = callbacks;
    this.cwd = options.cwd;
    this.autoApprove = options.autoApprove ?? true;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.compactPollIntervalMs = options.compactPollIntervalMs ?? 2_000;
    const launch = options.launch ?? resolveZCodeLaunch(options.command);
    this.child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: launch.env,
      detached: process.platform !== 'win32',
    });
    this.child.stdin?.on('error', () => {});
    this.child.stdout?.on('error', () => {});
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trimEnd();
      if (message) console.error(`[ZCodeClient stderr] ${message}`);
    });
    this.reader = readline.createInterface({ input: this.child.stdout! });
    this.reader.on('line', (line) => this.handleLine(line));
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('close', (code, signal) => {
      this.closed = true;
      this.clearKillTimer();
      if (!this.destroyed) this.rejectAll(new Error(`ZCode app-server exited: code=${code} signal=${signal}`));
    });
  }

  async initialize(): Promise<unknown> {
    return {};
  }

  async newSession(cwd: string): Promise<AcpSessionResult> {
    const result = await this.request('session/create', {
      workspace: { workspacePath: cwd, workspaceKey: cwd },
      mode: this.autoApprove ? 'yolo' : 'build',
    });
    const sessionId = result?.session?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('ZCode did not return a session ID');
    return this.captureSession(sessionId, result);
  }

  async loadSession(sessionId: string, cwd: string): Promise<AcpSessionResult> {
    const result = await this.request('session/resume', {
      sessionId,
      workspace: { workspacePath: cwd, workspaceKey: cwd },
    });
    return this.captureSession(sessionId, result);
  }

  async prompt(sessionId: string, blocks: AcpContentBlock[]): Promise<{ stopReason: string }> {
    if (this.prompts.has(sessionId)) throw new Error('ZCode session is already running a prompt');
    const text = blocks.flatMap((block) => block.type === 'text' && 'text' in block ? [block.text] : []).join('\n');
    const images = blocks.flatMap((block) => block.type === 'image'
      && typeof block.data === 'string'
      && typeof block.mimeType === 'string'
      ? [{ data: block.data, mimeType: block.mimeType }]
      : []);
    const attachments = images.map((block, index) => ({
      kind: 'image',
      filename: `image-${index + 1}.${this.extensionForMime(block.mimeType)}`,
      mimeType: block.mimeType,
      dataBase64: block.data,
      sizeBytes: Math.floor(block.data.length * 3 / 4),
    }));
    if (!text && attachments.length === 0) throw new Error('Empty prompt');

    const subscribe = () => this.request('session/subscribe', {
      sessionId,
      deliveryKind: 'desktop-continuous',
      includeSnapshot: false,
      afterSeq: this.sequence.get(sessionId) ?? 0,
    });
    try {
      await subscribe();
    } catch (error) {
      if (!/session is not active/i.test(error instanceof Error ? error.message : String(error))) throw error;
      await this.loadSession(sessionId, this.cwd);
      await subscribe();
    }

    return new Promise((resolve, reject) => {
      this.prompts.set(sessionId, { resolve, reject, tools: new Map() });
      void this.request('session/send', {
        sessionId,
        content: text,
        ...(attachments.length > 0 ? { attachments } : {}),
      }, 15_000).then((result) => {
        if (!result?.accepted) this.failPrompt(sessionId, new Error('ZCode did not accept the prompt'));
      }).catch((error) => this.failPrompt(sessionId, error));
    });
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<AcpSessionResult> {
    const state = this.sessions.get(sessionId) ?? { models: [] };
    if (configId === 'model') {
      const model = this.findModel(state, value);
      if (!model?.ref?.modelId || !model.ref.providerId) throw new Error(`Unknown ZCode model: ${value}`);
      const selected: Record<string, unknown> = { ...model.ref };
      const defaultLevel = model.reasoning?.defaultLevel;
      if (defaultLevel) selected.options = { reasoningLevel: defaultLevel };
      await this.request('session/setModel', {
        sessionId,
        model: selected,
        persistAsWorkspaceLastUsed: false,
      }, 15_000);
      state.currentModel = { ...model.ref };
      state.currentThought = defaultLevel ?? state.currentThought;
    } else if (configId === 'thought') {
      await this.request('session/setThoughtLevel', { sessionId, thoughtLevel: value }, 15_000);
      state.currentThought = value;
    } else {
      throw new Error(`Unsupported ZCode config option: ${configId}`);
    }
    this.sessions.set(sessionId, state);
    const configOptions = this.configOptions(state);
    this.callbacks.onConfigOptions?.(configOptions);
    return { sessionId, configOptions };
  }

  async compactSession(sessionId: string): Promise<{ stopReason: string }> {
    await this.request('session/compact', { sessionId }, 30_000);
    await this.waitForInternalTurn(sessionId, 5 * 60 * 1000);
    return { stopReason: 'end_turn' };
  }

  async deleteSession(sessionId: string): Promise<void> {
    // ZCode exposes session/close for releasing the resident runtime. The
    // persisted conversation remains in ZCode's own history, while remote-cli
    // removes its pointer in AcpExecutor.deleteThreadData().
    this.notify('session/close', { sessionId });
    this.sessions.delete(sessionId);
    this.sequence.delete(sessionId);
  }

  sendCancel(sessionId: string): void {
    this.notify('session/stop', { sessionId });
    const prompt = this.prompts.get(sessionId);
    if (prompt) {
      this.prompts.delete(sessionId);
      prompt.resolve({ stopReason: 'cancelled' });
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rejectAll(new Error('ZCode client destroyed'));
    this.reader.close();
    try { this.child.stdin?.end(); } catch {}
    if (!this.child.killed) {
      if (process.platform !== 'win32' && this.child.pid) {
        try { process.kill(-this.child.pid, 'SIGTERM'); } catch { this.child.kill('SIGTERM'); }
      } else {
        this.child.kill('SIGTERM');
      }
      this.killTimer = setTimeout(() => {
        if (this.closed) return;
        if (process.platform !== 'win32' && this.child.pid) {
          try { process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); }
        } else {
          this.child.kill('SIGKILL');
        }
      }, KILL_GRACE_MS);
      this.killTimer.unref?.();
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ZCode request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  private respondError(id: number | string, message: string): void {
    this.write({ id, error: { code: -32601, message } });
  }

  private write(message: object): void {
    if (this.destroyed || !this.child.stdin) return;
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch {}
  }

  private handleLine(line: string): void {
    let message: Record<string, any>;
    try { message = JSON.parse(line) as Record<string, any>; } catch { return; }
    const id = message.id;
    const method = message.method;
    if (id !== undefined && method === undefined) {
      const pending = this.pending.get(Number(id));
      if (!pending) return;
      this.pending.delete(Number(id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(this.formatError(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (id !== undefined && typeof method === 'string') {
      void this.handleServerRequest(id, method, message.params ?? {});
      return;
    }
    if (method === 'session/event') this.handleSessionEvent(message.params ?? {});
    else if (method === 'state.updated') this.handleStateUpdate(message.params ?? {});
  }

  private async handleServerRequest(id: number | string, method: string, params: Record<string, any>): Promise<void> {
    if (method === 'session/requestRuntimePreferences') {
      this.respond(id, {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      });
      return;
    }
    if (method === 'interaction/requestProviderRuntimeHeaders') {
      const apiKey = this.codingPlanApiKey(params.modelSelection?.providerId ?? params.providerId);
      this.respond(id, apiKey
        ? { headersApplied: true, requestAuth: { apiKey } }
        : { headersApplied: false, errorMessage: 'The selected ZCode plan requires desktop-only runtime authentication.' });
      return;
    }
    if (method === 'interaction/requestPermission') {
      await this.handleInteraction(id, params, async () => {
        const options = this.permissionOptions(params.options);
        const selected = await this.askPermission(this.permissionTitle(params), options);
        const option = selected >= 0 ? options[selected] : undefined;
        return option?.kind.startsWith('allow')
          ? { decision: 'allow' }
          : { decision: 'deny', reason: selected < 0 ? 'cancelled by user' : 'rejected by user' };
      });
      return;
    }
    if (method === 'interaction/requestUserInput') {
      await this.handleInteraction(id, params, () => this.handleUserInput(params));
      return;
    }
    this.respondError(id, `Unsupported ZCode request: ${method}`);
  }

  private handleSessionEvent(event: Record<string, any>): void {
    const sessionId = String(event.sessionId ?? '');
    if (!sessionId) return;
    if (typeof event.seq === 'number') this.sequence.set(sessionId, Math.max(event.seq, this.sequence.get(sessionId) ?? 0));
    const prompt = this.prompts.get(sessionId);
    if (!prompt) return;
    const payload = event.payload ?? {};
    if (event.type === 'turn.started') {
      prompt.turnId = typeof payload.turnId === 'string' ? payload.turnId : prompt.turnId;
      return;
    }
    if (event.type === 'model.streaming') {
      this.handleStreaming(prompt, payload);
      return;
    }
    if (event.type === 'tool.updated') {
      this.handleToolUpdate(prompt, payload);
      return;
    }
    if (event.type === 'session.updated' && Array.isArray(payload.todos)) {
      this.callbacks.onPlan?.(payload.todos);
      return;
    }
    if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.terminal') {
      if (prompt.turnId && payload.turnId && prompt.turnId !== payload.turnId) return;
      this.prompts.delete(sessionId);
      if (event.type === 'turn.failed') prompt.reject(new Error(this.formatError(payload.error ?? payload)));
      else prompt.resolve({ stopReason: payload.resultType === 'cancelled' ? 'cancelled' : 'end_turn' });
    }
  }

  private handleStreaming(prompt: ActivePrompt, payload: Record<string, any>): void {
    if (payload.kind === 'text_delta' && typeof payload.delta === 'string') {
      this.callbacks.onTextChunk?.({ type: 'text', text: payload.delta });
    } else if (payload.kind === 'reasoning_delta' && typeof payload.delta === 'string') {
      this.callbacks.onThoughtChunk?.({ type: 'text', text: payload.delta });
    } else if (payload.kind === 'tool_call') {
      const id = String(payload.toolCallId ?? '');
      if (!id) return;
      prompt.tools.set(id, {
        toolCallId: id,
        title: String(payload.toolName ?? 'Tool'),
        kind: this.toolKind(payload.toolName),
        rawInput: payload.input,
      });
    }
  }

  private handleToolUpdate(prompt: ActivePrompt, payload: Record<string, any>): void {
    const id = String(payload.toolCallId ?? '');
    if (!id) return;
    const previous = prompt.tools.get(id);
    const tool: AcpToolCallUpdate = {
      ...previous,
      toolCallId: id,
      title: String(payload.toolName ?? previous?.title ?? 'Tool'),
      kind: this.toolKind(payload.toolName ?? previous?.title),
      rawInput: payload.input ?? previous?.rawInput,
    };
    prompt.tools.set(id, tool);
    if (payload.kind === 'scheduled' || payload.kind === 'started') {
      this.callbacks.onToolCall?.({ ...tool, status: payload.kind === 'started' ? 'in_progress' : 'pending' });
    } else if (payload.kind === 'result' || payload.kind === 'error') {
      this.callbacks.onToolResult?.({
        ...tool,
        status: payload.kind === 'error' ? 'failed' : 'completed',
        rawOutput: payload.kind === 'error' ? payload.error : payload.result,
      });
      prompt.tools.delete(id);
    }
  }

  private handleStateUpdate(params: Record<string, any>): void {
    const sessionId = String(params.sessionId ?? '');
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const patch = params.patch ?? {};
    if (patch.model?.current) state.currentModel = patch.model.current;
    if (typeof patch.thoughtLevel?.current === 'string') state.currentThought = patch.thoughtLevel.current;
    const options = this.configOptions(state);
    this.callbacks.onConfigOptions?.(options);
  }

  private captureSession(sessionId: string, result: Record<string, any>): AcpSessionResult {
    const settings = result.settings ?? result.session?.settings ?? {};
    const state: SessionState = {
      currentModel: settings.model?.current,
      currentThought: settings.thoughtLevel?.current,
      models: Array.isArray(settings.model?.available) ? settings.model.available : [],
    };
    this.sessions.set(sessionId, state);
    const configOptions = this.configOptions(state);
    this.callbacks.onConfigOptions?.(configOptions);
    return { sessionId, configOptions };
  }

  private configOptions(state: SessionState): AcpConfigOption[] {
    const counts = new Map<string, number>();
    for (const model of state.models) {
      const id = model.ref?.modelId;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const valueFor = (model: ZCodeModel): string => {
      const provider = model.ref?.providerId ?? '';
      const id = model.ref?.modelId ?? '';
      return (counts.get(id) ?? 0) > 1 ? `${provider}/${id}` : id;
    };
    const current = state.models.find((model) => model.ref?.providerId === state.currentModel?.providerId
      && model.ref?.modelId === state.currentModel?.modelId);
    const levels = current?.reasoning?.levels?.map((level) => level.value).filter((value): value is string => Boolean(value)) ?? [];
    const options: AcpConfigOption[] = [{
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: current ? valueFor(current) : state.currentModel?.modelId,
      options: state.models.flatMap((model) => model.ref?.modelId ? [{
        value: valueFor(model),
        name: model.ref.modelId,
        description: model.ref.providerId,
      }] : []),
    }];
    if (levels.length > 0) {
      options.push({
        id: 'thought',
        name: 'Reasoning effort',
        type: 'select',
        currentValue: state.currentThought ?? current?.reasoning?.defaultLevel,
        options: levels.map((value) => ({ value, name: value })),
      });
    }
    return options;
  }

  private findModel(state: SessionState, value: string): ZCodeModel | undefined {
    const exact = state.models.filter((model) => model.ref?.modelId === value);
    if (exact.length === 1) return exact[0];
    return state.models.find((model) => `${model.ref?.providerId}/${model.ref?.modelId}` === value
      || `${model.ref?.providerId}\\${model.ref?.modelId}` === value);
  }

  private permissionOptions(raw: unknown): AcpPermissionOption[] {
    const values = Array.isArray(raw) ? raw : [];
    const options = values.map((entry: any) => ({
      optionId: String(entry.optionId ?? entry.kind ?? ''),
      name: String(entry.name ?? entry.optionId ?? entry.kind ?? ''),
      kind: this.permissionKind(entry.kind),
    }));
    return options.length > 0 ? options : [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ];
  }

  private permissionKind(kind: unknown): AcpPermissionOption['kind'] {
    if (kind === 'allow_once' || kind === 'allow_always' || kind === 'reject_once' || kind === 'reject_always') return kind;
    if (kind === 'allow' || kind === 'allow_project') return 'allow_always';
    return 'reject_once';
  }

  private async askPermission(title: string, options: AcpPermissionOption[]): Promise<number> {
    if (!this.callbacks.onPermissionRequest) return this.autoApprove ? options.findIndex((option) => option.kind.startsWith('allow')) : -1;
    return this.callbacks.onPermissionRequest(title, options);
  }

  private async handleUserInput(params: Record<string, any>): Promise<Record<string, unknown>> {
    if (params.schema?.interaction === 'plan_approval') {
      const options: AcpPermissionOption[] = [
        { optionId: 'q0_opt_0', name: 'Approve plan', kind: 'allow_once' },
        { optionId: 'q0_skip', name: 'Reject plan', kind: 'reject_once' },
      ];
      const selected = await this.askPermission('Approve the proposed plan?', options);
      return selected === 0 ? { action: 'accept', content: { answer_0: 'approve' } } : { action: 'decline', reason: 'plan rejected' };
    }
    const questions = params.questions ?? params.input?.questions ?? [];
    const answers: Record<string, string> = {};
    for (let index = 0; index < questions.length; index++) {
      const question = questions[index];
      const choices = Array.isArray(question.options) ? question.options : [];
      if (question.multiSelect) {
        const picked: string[] = [];
        for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex++) {
          const choice = choices[choiceIndex];
          const label = String(choice.label ?? choice.value ?? `Option ${choiceIndex + 1}`);
          const selected = await this.askPermission(`${String(question.question ?? params.prompt ?? 'ZCode question')}\nInclude "${label}"?`, [
            { optionId: `q${index}_opt_${choiceIndex}_yes`, name: 'Include', kind: 'allow_once' },
            { optionId: `q${index}_opt_${choiceIndex}_no`, name: 'Skip', kind: 'reject_once' },
          ]);
          if (selected < 0) return { action: 'decline', reason: 'question cancelled' };
          if (selected === 0) picked.push(String(choice.value ?? choice.label ?? label));
        }
        answers[String(question.question ?? `question_${index}`)] = picked.join(', ');
        continue;
      }
      const options: AcpPermissionOption[] = choices.map((choice: any, optionIndex: number) => ({
        optionId: `q${index}_opt_${optionIndex}`,
        name: String(choice.label ?? choice.value ?? `Option ${optionIndex + 1}`),
        kind: 'allow_once',
      }));
      options.push({ optionId: `q${index}_skip`, name: 'Skip', kind: 'reject_once' });
      const selected = await this.askPermission(String(question.question ?? params.prompt ?? 'ZCode question'), options);
      if (selected < 0 || selected >= choices.length) return { action: 'decline', reason: 'question skipped or cancelled' };
      const choice = choices[selected];
      answers[String(question.question ?? `question_${index}`)] = String(choice.value ?? choice.label ?? options[selected].name);
    }
    return { action: 'accept', content: { answers } };
  }

  private async handleInteraction(
    id: number | string,
    params: Record<string, any>,
    resolve: () => Promise<Record<string, unknown>>,
  ): Promise<void> {
    const key = String(params.requestId ?? params.toolCallId ?? id);
    const existing = this.interactions.get(key);
    if (existing) {
      if (existing.result) this.respond(id, existing.result);
      else existing.ids.push(id);
      return;
    }
    const interaction: PendingInteraction = { ids: [id] };
    this.interactions.set(key, interaction);
    let result: Record<string, unknown>;
    try {
      result = await resolve();
    } catch (error) {
      result = { action: 'decline', reason: error instanceof Error ? error.message : 'interaction failed' };
    }
    interaction.result = result;
    for (const requestId of interaction.ids) this.respond(requestId, result);
    const timer = setTimeout(() => this.interactions.delete(key), 5 * 60 * 1000);
    timer.unref?.();
  }

  private permissionTitle(params: Record<string, any>): string {
    const tool = String(params.toolName ?? 'Tool');
    const input = params.input;
    if (!input || typeof input !== 'object') return tool;
    const detail = input.command ?? input.file_path ?? input.path ?? input.url;
    return detail ? `${tool}: ${String(detail).split('\n')[0].slice(0, 120)}` : tool;
  }

  private codingPlanApiKey(providerId: unknown): string | null {
    if (typeof providerId !== 'string') return null;
    const match = /^account:([a-z0-9]+)-individual-coding-plan$/.exec(providerId);
    if (!match) return null;
    try {
      const configPath = path.join(process.env.ZCODE_HOME ?? path.join(os.homedir(), '.zcode'), 'v2', 'config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, any>;
      const provider = config.provider?.[`builtin:${match[1]}-coding-plan`];
      const apiKey = provider?.options?.apiKey;
      return typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null;
    } catch {
      return null;
    }
  }

  private toolKind(name: unknown): string {
    const normalized = String(name ?? '').toLowerCase();
    if (normalized.includes('read')) return 'read';
    if (normalized.includes('write') || normalized.includes('edit')) return 'edit';
    if (normalized.includes('glob') || normalized.includes('search') || normalized.includes('list')) return 'search';
    return 'execute';
  }

  private extensionForMime(mime: string): string {
    return ({ 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' } as Record<string, string>)[mime] ?? 'png';
  }

  private async waitForInternalTurn(sessionId: string, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    let lockSeen = false;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        await this.request('session/goal', { sessionId, action: 'show' }, 10_000);
        if (lockSeen || Date.now() - startedAt >= 30_000) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/prompt is running/i.test(message)) {
          lockSeen = true;
        } else if (lockSeen) {
          return;
        } else if (/backend reader exited|app-server exited/i.test(message)) {
          throw error;
        } else if (Date.now() - startedAt >= 30_000) {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.compactPollIntervalMs));
    }
    throw new Error('ZCode compaction did not finish within 5 minutes');
  }

  private failPrompt(sessionId: string, error: unknown): void {
    const prompt = this.prompts.get(sessionId);
    if (!prompt) return;
    this.prompts.delete(sessionId);
    prompt.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const prompt of this.prompts.values()) prompt.reject(error);
    this.prompts.clear();
  }

  private formatError(error: any): string {
    if (typeof error === 'string') return error;
    const code = error?.code === undefined ? '' : ` ${error.code}`;
    return `ZCode error${code}: ${error?.message ?? error?.type ?? JSON.stringify(error)}`;
  }

  private clearKillTimer(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
  }
}

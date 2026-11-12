import { AcpClient, type AcpEventCallbacks } from '../acp/AcpClient';
import type { AcpContentBlock, AcpMcpServer, AcpPermissionOption, AcpSessionResult } from '../acp/AcpTypes';
import { createDshPrivacyLaunch } from './DshPrivacy';
import { randomUUID } from 'crypto';
import { sessionSchedulePatch } from '../../scheduling/dsh/sessionLaunch';
import { SessionScheduleClient } from '../../scheduling/dsh/SessionScheduleClient';
import { SESSION_EVENT, SESSION_VERSION } from '../../scheduling/dsh/sessionProtocol';
import type { AcpJsonRpcNotification } from '../acp/AcpTypes';

/** Provider errors can contain request headers; never relay them verbatim. */
export function dshErrorMessage(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|secret|password)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"<>]+/g, '[endpoint]')
    .slice(0, 500);
}

/** DSH's ACP dialect, without changing OpenCode/Kimi/ZCode transport behavior. */
export class DshAcpClient extends AcpClient {
  supportsImages = false;
  private stopped = false;
  private readonly permission: AcpEventCallbacks['onPermissionRequest'];
  private readonly scheduleClient?: SessionScheduleClient;
  private readonly scheduleScope: string;
  private foregroundSession?: string;
  private foregroundStopReason?: string;
  private scheduleEnabled = false;
  private projections = new Map<string, boolean>();

  constructor(command: string, cwd: string, callbacks: AcpEventCallbacks, private readonly controlTimeout = 30_000, delegationWorker = false, managedHistoryPatch = '') {
    if (managedHistoryPatch && !delegationWorker) throw new Error('DSH owned history requires a managed worker');
    const scope = randomUUID();
    const launch = createDshPrivacyLaunch(managedHistoryPatch, delegationWorker ? undefined : directory => sessionSchedulePatch(directory, scope));
    try {
      super(command, launch.args, cwd, {
        ...callbacks,
        // DSH reports generic "other" kinds; preserve its actual tool name in cards.
        onToolCall: tool => callbacks.onToolCall?.({ ...tool, kind: tool.kind === 'other' ? undefined : tool.kind }),
      }, true, { delegationWorker, env: launch.env, onStderr: () => { /* Provider diagnostics may contain credentials or conversation data. */ } });
    } catch (error) {
      launch.dispose();
      throw error;
    }
    this.permission = callbacks.onPermissionRequest;
    this.scheduleScope = scope;
    if (!delegationWorker) this.scheduleClient = new SessionScheduleClient(scope, (method, params) => this.sendNotification(method, params));
    void super.waitForExit().then(() => {
      this.scheduleClient?.close();
      this.stopped = true;
      try { launch.dispose(); } catch { console.warn('[DSH] Temporary privacy overlay cleanup failed.'); }
    });
  }

  async initialize(): Promise<unknown> {
    const result = await super.initialize() as {
      protocolVersion?: number;
      agentCapabilities?: { promptCapabilities?: { image?: boolean }; sessionCapabilities?: { resume?: unknown } };
    };
    if (result.protocolVersion !== 1 || !result.agentCapabilities?.sessionCapabilities?.resume) {
      this.destroy();
      throw new Error('DSH must support ACP v1 and session/resume. Install a compatible DeepSeek Harness release.');
    }
    this.supportsImages = result.agentCapabilities.promptCapabilities?.image === true;
    return result;
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: AcpMcpServer[] = []): Promise<AcpSessionResult> {
    return this.sendRequest('session/resume', { sessionId, cwd, mcpServers }) as Promise<AcpSessionResult>;
  }

  async prompt(sessionId: string, blocks: AcpContentBlock[]): Promise<{ stopReason: string }> {
    if (!this.supportsImages && blocks.some(block => block.type === 'image')) {
      throw new Error('This DSH ACP profile/model does not support image input. No part of this prompt was submitted. Send text or a supported document instead.');
    }
    this.foregroundSession = sessionId;
    this.foregroundStopReason = undefined;
    try {
      const result = await super.prompt(sessionId, blocks);
      return this.scheduleEnabled && this.foregroundStopReason ? { stopReason: this.foregroundStopReason } : result;
    } finally { this.foregroundSession = undefined; this.foregroundStopReason = undefined; }
  }

  createNativeSchedule(sessionId: string, input: import('../../scheduling/types').NativeScheduleInput,
    onEvent: (event: import('../../scheduling/types').NativeScheduleEvent) => void) {
    if (!this.scheduleClient) throw new Error('Worker sessions cannot create schedules.');
    this.scheduleEnabled = true;
    return this.scheduleClient.create(sessionId, input, onEvent);
  }

  protected handleNotification(message: AcpJsonRpcNotification): void {
    if (!this.scheduleClient) { super.handleNotification(message); return; }
    if (message.method === SESSION_EVENT) {
      const p = message.params as any;
      if (p?.scope !== this.scheduleScope || p.version !== SESSION_VERSION) return;
      if (p.kind === 'projection' && typeof p.sessionId === 'string' && typeof p.foreground === 'boolean') {
        const id = p.messageId ?? p.toolCallId;
        if (typeof id !== 'string') return;
        this.projections.set(`${p.sessionId}:${id}`, p.foreground);
        if (this.projections.size > 4096) this.projections.delete(this.projections.keys().next().value!);
      } else if (p.kind === 'foregroundEnd' && p.sessionId === this.foregroundSession
        && ['end_turn', 'cancelled', 'error'].includes(p.stopReason)) {
        this.foregroundStopReason = p.stopReason;
      } else this.scheduleClient.receive(p);
      return;
    }
    if (!this.scheduleEnabled) { super.handleNotification(message); return; }
    // Native ACP projections are async and can lag turn/end. Classify their
    // actual message/tool identity using the synchronous durable-event observation.
    const params = message.params as any;
    const update = params?.update;
    if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) {
      if (params.sessionId !== this.foregroundSession
        || this.projections.get(`${params.sessionId}:${update.messageId ?? update.toolCallId}`) !== true) return;
    }
    super.handleNotification(message);
  }

  /** DSH closes live sessions but intentionally retains its native history on disk. */
  async deleteSession(sessionId: string): Promise<void> {
    await this.sendRequest('session/close', { sessionId });
  }

  destroy(): void { this.stopped = true; super.destroy(); }

  protected async sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.stopped) throw new Error('DSH ACP process has exited. Retry to reconnect.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = super.sendRequest(method, params);
      if (method === 'session/prompt') return await request;
      return await Promise.race([request, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`DSH ${method} timed out. The process was stopped; retry to reconnect.`));
          this.destroy();
        }, this.controlTimeout);
      })]);
    } catch (error) {
      throw new Error(dshErrorMessage(error));
    } finally { if (timer) clearTimeout(timer); }
  }

  /** ACP v1 requires a nested outcome. Permission errors must deny, never grant. */
  protected async handlePermissionRequest(id: number, params: {
    toolCall?: { title?: string }; options?: AcpPermissionOption[];
  }): Promise<void> {
    const options = params.options ?? [];
    let index = -1;
    try { index = await this.permission?.(params.toolCall?.title ?? 'DSH tool request', options) ?? -1; } catch { /* Deny. */ }
    const selected = Number.isInteger(index) ? options[index] : undefined;
    this.sendResponse(id, { outcome: selected?.kind.startsWith('allow')
      ? { outcome: 'selected', optionId: selected.optionId }
      : { outcome: 'cancelled' } });
  }
}

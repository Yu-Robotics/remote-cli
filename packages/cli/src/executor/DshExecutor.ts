import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { DirectoryGuard } from '../security/DirectoryGuard';
import { AcpExecutor } from './AcpExecutor';
import type { AcpEventCallbacks, AcpTransport } from './acp/AcpClient';
import type { ExecuteOptions, ExecuteResult, ExecutorContextUsage, ExecutorModelInfo } from './IExecutor';
import { COMPACT_HANDOFF_PROMPT, seedPromptWithHandoff } from './compactHandoff';
import { DshAcpClient } from './dsh/DshAcpClient';
import { queryDshAccountUsage } from './dsh/DshAccountUsage';

export interface DshExecutorOptions {
  model?: string;
  effort?: string;
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  dshCommand?: string;
  threadId?: string;
  delegationWorker?: boolean;
  sessionBaseDir?: string;
  clientFactory?: (callbacks: AcpEventCallbacks, cwd: string) => AcpTransport;
  accountUsageQuery?: (command: string, cwd: string) => Promise<string | null>;
}

interface Handoff { text: string; cwd: string; sourceSessionId: string | null }
interface DshState {
  images: boolean;
  usage: ExecutorContextUsage | null;
  handoff?: Handoff;
  recoveryNotice: boolean;
  compacting: boolean;
  generation: number;
}

const COMPACT_CONTEXT_UNAVAILABLE = 'The saved DSH context cannot be resumed over ACP. No compact summary was created. Send a normal task to start fresh, or use /clear.';

/** DSH-specific compatibility policy; other ACP executors keep their existing defaults. */
export class DshExecutor extends AcpExecutor {
  private readonly state: DshState;
  private readonly handoffFile: string;
  private readonly dshCommand: string;
  private readonly accountUsageQuery: NonNullable<DshExecutorOptions['accountUsageQuery']>;

  constructor(guard: DirectoryGuard, options: DshExecutorOptions = {}) {
    // Do not silently launch a DSH task in a different workspace when admission fails.
    if (options.initialWorkingDirectory) guard.resolveWorkingDirectory(options.initialWorkingDirectory, process.cwd());
    const state: DshState = { images: false, usage: null, recoveryNotice: false, compacting: false, generation: 0 };
    const directory = options.sessionBaseDir ?? path.join(os.homedir(), '.remote-cli', 'dsh-sessions');
    const handoffFile = path.join(directory, `${options.threadId ?? 'default'}.handoff.json`);
    const clearHandoff = () => {
      fs.rmSync(handoffFile, { force: true });
      state.handoff = undefined;
    };
    super(guard, {
      ...options,
      acpCommand: options.dshCommand ?? 'dsh', acpArgs: ['acp'],
      backendLabel: 'DeepSeek Harness', sessionNamespace: 'dsh-sessions',
      effortConfigId: 'reasoning_effort', effortAutoValue: '',
      installCommand: 'npm install --global @deepseek-ai/dsh',
      authCommand: 'dsh web', preserveSessionOnResumeError: true, managedLifecycle: true,
      clientFactory: (callbacks, cwd) => {
        const wrapped: AcpEventCallbacks = { ...callbacks, onUsage: update => {
          if (Number.isSafeInteger(update.used) && Number.isSafeInteger(update.size)
            && Number(update.used) >= 0 && Number(update.size) > 0) {
            state.usage = { contextTokens: Number(update.used), contextWindow: Number(update.size),
              contextPercent: Number(update.used) / Number(update.size) * 100 };
          }
        } };
        const transport = options.clientFactory?.(wrapped, cwd)
          ?? new DshAcpClient(options.dshCommand ?? 'dsh', cwd, wrapped);
        return {
          initialize: async () => {
            const result = await transport.initialize() as { agentCapabilities?: { promptCapabilities?: { image?: boolean } } };
            state.images = result?.agentCapabilities?.promptCapabilities?.image === true;
            state.usage = null;
            return result;
          },
          newSession: (...args) => transport.newSession(...args),
          loadSession: async (...args) => {
            try { return await transport.loadSession(...args); }
            catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              // Match only DSH's known permanent error, not provider text or arbitrary RPC failures.
              if (/^(?:ACP error -32602:\s*)?session is not resumable(?:\s*:|$)/i.test(message)) {
                if (state.compacting) throw new Error(COMPACT_CONTEXT_UNAVAILABLE);
                state.recoveryNotice = true;
                throw new Error('Session not found: the saved DSH context cannot be resumed over ACP.');
              }
              if (/^(?:ACP error -32602:\s*)?session cwd does not match(?:\s*:|$)/i.test(message)) {
                throw new Error('The saved DSH session belongs to a different working directory. No context was reset. Use /clear to start fresh in the current directory, or /cd <directory> to change directories and start fresh. Changing directories does not automatically resume the original conversation.');
              }
              throw error;
            }
          },
          setConfigOption: (id, key, value) => transport.setConfigOption(id, key,
            key === 'reasoning_effort' && value === 'auto' ? '' : value),
          deleteSession: id => transport.deleteSession(id),
          sendCancel: id => transport.sendCancel(id),
          destroy: () => transport.destroy(),
          ...(transport.waitForExit ? { waitForExit: () => transport.waitForExit!() } : {}),
          prompt: async (id, blocks) => {
            if (!state.images && blocks.some(block => block.type === 'image')) {
              throw new Error('This DSH ACP profile/model does not support image input. No part of this prompt was submitted.');
            }
            if (state.recoveryNotice) {
              callbacks.onTextChunk?.({ type: 'text', text: '⚠️ The saved DSH context cannot be resumed over ACP. Continuing in a new session; remote-cli did not delete native DSH history.\n\n' });
              state.recoveryNotice = false;
            }
            const handoff = state.handoff;
            const result = await transport.prompt(id, handoff
              ? [{ type: 'text', text: seedPromptWithHandoff(handoff.text, '') }, ...blocks] : blocks);
            if (handoff && state.handoff === handoff && result.stopReason === 'end_turn') clearHandoff();
            return result;
          },
        };
      },
    });
    this.state = state;
    this.handoffFile = handoffFile;
    this.dshCommand = options.dshCommand ?? 'dsh';
    this.accountUsageQuery = options.accountUsageQuery ?? queryDshAccountUsage;
    try {
      const stat = fs.lstatSync(handoffFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 300_000) throw new Error('Invalid DSH handoff file');
      const saved = JSON.parse(fs.readFileSync(handoffFile, 'utf8')) as Handoff;
      if (typeof saved.text === 'string' && saved.text.trim() && saved.text.length <= 65_536
        && saved.cwd === this.getCurrentWorkingDirectory()
        && (typeof saved.sourceSessionId === 'string' || saved.sourceSessionId === null)) {
        state.handoff = saved;
        // Finish a reset interrupted after the summary was durably written.
        if (saved.sourceSessionId === this.getSessionId()) super.resetContext();
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') console.warn('[DSH] Pending compact summary could not be loaded.');
    }
  }

  execute(prompt: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    if (this.state.compacting) return Promise.resolve({ success: false, error: 'DSH is compacting. Try again after it finishes.' });
    if (/^\s*\/[a-z][\w-]*(?:\s|$)/i.test(prompt)) return Promise.resolve({ success: false,
      error: 'DSH ACP does not expose interactive slash commands. Use remote-cli built-ins or describe the task in plain text.' });
    return super.execute(prompt, options);
  }

  isBusy(): boolean { return this.state?.compacting === true || super.isBusy(); }
  getContextUsage(): ExecutorContextUsage | null { return this.state.usage; }
  getAccountUsage(): Promise<string | null> {
    return this.accountUsageQuery(this.dshCommand, this.getCurrentWorkingDirectory());
  }

  async listModels(): Promise<ExecutorModelInfo[]> {
    return (await super.listModels()).map(model => ({ ...model,
      supportedReasoningEfforts: model.supportedReasoningEfforts?.map(value => value === '' ? 'auto' : value),
      defaultReasoningEffort: model.isDefault ? 'auto' : undefined,
      // initialize advertises a connection capability, not a per-catalog-model promise.
      inputModalities: model.isDefault && this.state.images ? ['text', 'image'] : ['text'],
    }));
  }

  resetContext(): void {
    this.state.generation++;
    fs.rmSync(this.handoffFile, { force: true });
    this.state.handoff = undefined;
    this.state.usage = null;
    this.state.recoveryNotice = false;
    super.resetContext();
  }

  async setWorkingDirectory(target: string): Promise<void> {
    const previous = this.getCurrentWorkingDirectory();
    await super.setWorkingDirectory(target);
    if (this.getCurrentWorkingDirectory() !== previous) {
      this.state.generation++;
      fs.rmSync(this.handoffFile, { force: true });
      this.state.handoff = undefined;
      this.state.usage = null;
      this.state.recoveryNotice = false;
    }
  }

  async compactWhenFull(onStream?: (chunk: string) => void): Promise<ExecuteResult> {
    if (this.isBusy()) return { success: false, error: 'DSH is busy. Wait before compacting.' };
    if (this.state.recoveryNotice) return { success: false, error: COMPACT_CONTEXT_UNAVAILABLE };
    if (this.state.handoff) return { success: true, output: 'A compact summary is already saved for the next DSH turn.' };
    this.state.compacting = true;
    const generation = this.state.generation;
    try {
      onStream?.('Summarizing the DSH conversation before starting a fresh context...\n');
      const result = await super.execute(COMPACT_HANDOFF_PROMPT);
      if (generation !== this.state.generation) return { success: false, error: 'DSH compaction was cancelled or its context changed.' };
      if (!result.success || !result.output?.trim()) return { success: false,
        error: result.error ?? 'DSH returned no compact summary. The original context was preserved.' };
      const handoff: Handoff = { text: result.output.trim().slice(0, 65_536),
        cwd: this.getCurrentWorkingDirectory(), sourceSessionId: this.getSessionId() };
      const temporary = `${this.handoffFile}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(handoff), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, this.handoffFile);
      } finally { fs.rmSync(temporary, { force: true }); }
      this.state.handoff = handoff;
      super.resetContext();
      this.state.usage = null;
      await super.waitForExit();
      return { success: true, output: 'Context compacted by summary and reset. The saved summary will seed the next turn; native DSH history is retained.' };
    } catch {
      return { success: false, error: 'DSH compaction could not finish. A saved summary, if present, is retained; no task was replayed.' };
    } finally { this.state.compacting = false; }
  }

  /** Remove remote-cli pointers only; DSH ACP has no native history deletion API. */
  async deleteThreadData(_threadId: string): Promise<void> {
    this.resetContext();
    await this.waitForExit();
  }

  async abort(): Promise<boolean> {
    if (this.state.compacting) this.state.generation++;
    return super.abort();
  }

  async destroy(): Promise<void> {
    this.state.generation++;
    await super.destroy();
  }
}

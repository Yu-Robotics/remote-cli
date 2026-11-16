import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { kernelGate, type KernelGate } from '../delegation/OwnershipRuntime';
import type { UpdateReadiness } from '../update/AutomaticUpdater';
import { parseScheduleCommand } from '../scheduling/ScheduleCommand';
import { HostClient } from './HostClient';
import { fields, secret, payload, HostError, type FrontendLease, type HostAddress, type Json } from './HostProtocol';
import type { RuntimeBinding, RuntimeCommand } from './RuntimeJournal';

export interface RetainedConnection { address: HostAddress; secret: string; launcherSecret: string; directory: string }
/** The supervisor must return an independently owned, pinned host; never spawn under the frontend job. */
export interface RetainedLauncher { connect(): Promise<RetainedConnection> }
export interface RuntimeSnapshot {
  runtimeVersion: string; frontendVersion?: string; routerVersion?: string; ready: boolean; healthy: boolean;
  commands: RuntimeCommand[]; owners: RuntimeBinding[];
}
export function privateJson(file: string): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024
    || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Retained host descriptor must be a private regular file.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function descriptorLauncher(file: string): RetainedLauncher {
  return { connect: async () => {
    const value = privateJson(file);
    fields(value, ['address', 'secret', 'launcherSecret', 'directory']);
    fields(value.address, ['hostId', 'port', 'installationId']); secret(value.secret); secret(value.launcherSecret);
    if (typeof value.directory !== 'string' || !path.isAbsolute(value.directory)) throw new Error('Invalid retained host directory.');
    return value as unknown as RetainedConnection;
  } };
}

/** This parser is loaded from the newly installed frontend, not the pinned host. */
export function retainedIntent(command: RuntimeCommand, state: RuntimeSnapshot, version: string): { context: RuntimeBinding | null; intent: Json } {
  const text = command.command.trim();
  const own = state.owners.filter(owner => owner.openId === command.openId);
  const context = own.find(owner => owner.threadId === command.threadId) ?? (!command.threadId ? own[0] : undefined) ?? null;
  const reply = (output: string) => ({ context: null, intent: { kind: 'reply', output } as Json });
  if (text === '/host status') return reply(`Frontend ${version}; native runtime ${state.runtimeVersion}. Native sessions remain owned by the retained host.`);
  if (text === '/help') return reply('Retained-host commands: /thread new <name> <claude|agy|dsh> <directory>, /thread list, /t <name>, /schedule list|cancel|after|at|cron, /host status. Other context changes are not enabled.');
  if (text === '/thread list') return reply(own.map(owner => `${owner.name}: ${owner.threadId} (${owner.backend})`).join('\n') || 'No retained-host threads. Existing monolithic sessions are not imported.');
  const create = /^\/thread new ([A-Za-z0-9-]+) (claude|agy|dsh) (.+)$/.exec(text);
  if (create) return { context: null, intent: { kind: 'newThread', name: create[1], backend: create[2], cwd: create[3] } };
  const select = /^\/t ([A-Za-z0-9-]+)$/.exec(text);
  if (select) {
    const selected = own.find(owner => owner.name === select[1]);
    return selected ? { context: selected, intent: { kind: 'select' } } : reply('Retained-host thread not found.');
  }
  const schedule = parseScheduleCommand(text);
  if (schedule) {
    if (schedule.kind === 'invalid') return reply(schedule.message);
    if (!['create', 'list', 'cancel'].includes(schedule.kind)) return reply('This retained-host frontend supports schedule create, list and cancel. Other cleanup/context commands are not enabled.');
    return { context, intent: { kind: 'schedule', operation: schedule } as Json };
  }
  if (text.startsWith('/')) return reply('This command is not enabled in the retained-host frontend. No native context was changed. Use /help.');
  return { context, intent: { kind: 'prompt', prompt: command.command } };
}

/** Replaceable command plane. No Router socket, executor or native callback lives here. */
export class RetainedFrontend implements UpdateReadiness {
  private client!: HostClient;
  private lease!: FrontendLease;
  private gate?: KernelGate;
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private closed = false;
  private updating = false;
  private last?: RuntimeSnapshot;
  private sequence = 0;
  private cursor = 0;
  private fault?: Error;
  private pendingSubmission?: { sequence: number; method: string; args: Json };
  constructor(private readonly launcher: RetainedLauncher, readonly version: string,
    private readonly dispatch = retainedIntent, private readonly onVersion: (version: string) => void = () => {}) {}

  async start(pollMs = 250): Promise<void> {
    const connection = await this.launcher.connect();
    const admin = new HostClient(connection.address, connection.launcherSecret);
    this.client = new HostClient(connection.address, connection.secret);
    try {
      const hello = await admin.hello();
      if (!['sequenced-requests-v1', 'launcher-recovery-v1'].every(cap => hello.capabilities.includes(cap))) throw new Error('Retained host attachment capabilities are unavailable.');
      this.lease = await admin.recoverFrontend(randomUUID(), hello.epoch);
      this.gate = kernelGate(path.join(connection.directory, 'frontend.lock'));
      if (!this.gate) throw new Error('Another frontend acquired the launcher lease.');
      // A contender may have won between claim and lock; verify before dispatch.
      await this.client.inspect(this.lease, 'state');
      this.sequence = hello.acceptedThrough; this.cursor = hello.acknowledged;
      await this.submit('frontendVersion', this.version);
      await this.tick();
      this.timer = setInterval(() => { void this.tick().catch(error => { this.fault = error instanceof Error ? error : new Error('Retained frontend failed.'); }); }, pollMs);
    } catch (error) { this.gate?.close(); this.gate = undefined; this.client.close(); throw error; }
    finally { admin.close(); }
  }
  status(): { frontendVersion: string; runtimeVersion?: string; error?: string } {
    return { frontendVersion: this.version, runtimeVersion: this.last?.runtimeVersion, ...(this.fault ? { error: this.fault.message } : {}) };
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    const run = async () => {
      if (this.closed || this.updating) return;
      this.gate!.verify();
      // Resolve ambiguous acceptance before ACK can retire its receipt. The
      // original arguments and sequence survive any number of transport failures.
      if (this.pendingSubmission) await this.flushSubmission();
      const state = await this.client.inspect<RuntimeSnapshot>(this.lease, 'state'); this.last = state;
      if (!state.healthy) throw new Error('Retained runtime persistence is unavailable.');
      const events = await this.client.events(this.lease, this.cursor);
      if (events.events.some(event => event.status === 'unknown')) throw new Error('Host operation outcome is unknown; no native request was replayed.');
      // These are control receipts. Actual user output remains in the host's
      // Router-ACK outbox; acknowledging here cannot acknowledge a user result.
      try { await this.client.ack(this.lease, events.through); this.cursor = events.through; }
      catch (error) {
        if (error instanceof HostError && error.code === 'transport_outcome_unknown') {
          const hello = await this.client.hello();
          if (hello.epoch === this.lease.epoch) this.cursor = hello.acknowledged;
        }
        throw error;
      }
      for (const command of state.commands.slice(0, 16)) {
        if (this.updating || this.closed) break;
        const parsed = this.dispatch(command, state, this.version);
        let args: Json;
        try { args = payload({ messageId: command.messageId, ...parsed }); }
        catch {
          // Reject a nontransportable command explicitly instead of retaining it
          // forever at the head of ingress and blocking later frontend updates.
          args = { messageId: command.messageId, context: null, intent: { kind: 'reject',
            error: 'Command exceeds retained-host transport limits. No native work was dispatched.' } };
        }
        await this.submit('command', args);
      }
      if (state.routerVersion) this.onVersion(state.routerVersion);
      this.fault = undefined;
    };
    this.ticking = run().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  private async submit(method: string, args: Json): Promise<void> {
    if (this.pendingSubmission) throw new Error('A frontend request still has an unknown outcome.');
    this.pendingSubmission = { sequence: this.sequence + 1, method, args };
    await this.flushSubmission();
  }
  private async flushSubmission(): Promise<void> {
    const pending = this.pendingSubmission!;
    try { await this.client.submitSequenced(this.lease, pending.sequence, pending.method, pending.args); }
    catch (error) {
      // A lost acceptance reply must not assign a new sequence to the same input.
      if (!(error instanceof HostError) || error.code !== 'transport_outcome_unknown') throw error;
      const status = await this.client.status(this.lease, `sequenced-${pending.sequence}`).catch(() => undefined);
      if (!status) throw error;
    }
    this.sequence = pending.sequence;
    this.pendingSubmission = undefined;
  }
  tryBeginAutomaticUpdate(): boolean {
    if (this.closed || this.updating || this.fault || this.pendingSubmission || !this.last?.healthy) return false;
    this.updating = true; return true;
  }
  async prepareAutomaticUpdate(): Promise<void> {
    if (!this.updating || this.closed) throw new Error('Frontend update admission expired.');
    await this.ticking;
    this.gate!.verify();
    const state = await this.client.inspect<RuntimeSnapshot>(this.lease, 'state');
    if (!state.healthy) throw new Error('Retained native host is unavailable.');
    // No native list/cancel/load/recreate/suspend operation is used here.
  }
  async endAutomaticUpdate(): Promise<void> { this.updating = false; }
  async close(): Promise<void> {
    if (this.closed) return;
    this.updating = true;
    await this.ticking?.catch(() => {});
    try { await this.client.detach(this.lease); }
    catch (error) {
      const hello = error instanceof HostError && error.code === 'transport_outcome_unknown'
        ? await this.client.hello().catch(() => undefined) : undefined;
      if (!hello || hello.active || hello.epoch !== this.lease.epoch + 1) { this.updating = false; throw error; }
    }
    this.closed = true; if (this.timer) clearInterval(this.timer);
    this.client.close(); this.gate?.close(); this.gate = undefined;
  }
}

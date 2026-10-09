import { createHash, randomUUID } from 'crypto';
import type { ExecuteResult } from '../executor/IExecutor';
import type { SettingsActionMessage, SettingsBackend, SettingsBackendInfo, SettingsChoice, SettingsKind, SettingsMenu, SettingsResultMessage, SettingsScope } from '../types/Settings';
import { SettingsBusyError } from './SettingsAdmission';

export interface SettingsState {
  threadId: string;
  threadName: string;
  coordinatorBackend: SettingsBackend;
  followsGlobal: boolean;
  revision: string;
  configuredModels: Partial<Record<SettingsBackend, string>>;
  configuredEfforts: Partial<Record<SettingsBackend, string>>;
  delegationEnabled: boolean;
}

export interface SettingsCatalog {
  choices: SettingsChoice[];
  effectiveValue?: string;
  defaultValue?: string;
  effectiveSource: SettingsMenu['effectiveSource'];
  supportsReset: boolean;
  unavailableReason?: string;
}

export interface SettingsDependencies {
  state(threadId: string): SettingsState | undefined;
  backends(threadId?: string, kind?: SettingsKind): Promise<SettingsBackendInfo[]>;
  catalog(threadId: string, backend: SettingsBackend, kind: 'model' | 'effort'): Promise<SettingsCatalog>;
  busy(threadId: string, exceptRequest?: string, includeQueue?: boolean): boolean;
  threads(): string[];
  exclusive<T>(target: string, body: () => Promise<T>): Promise<T>;
  backend(threadId: string, backend: SettingsBackend, scope: SettingsScope, followGlobal: boolean): Promise<ExecuteResult>;
  preference(threadId: string, backend: SettingsBackend, kind: 'model' | 'effort', value: string | undefined): Promise<ExecuteResult>;
  delegation(threadId: string, enabled: boolean): Promise<ExecuteResult>;
  delegationSupported(threadId: string): boolean;
  now?(): number;
}

interface Snapshot { menu: SettingsMenu; owner: string; revision: string }
interface Receipt { digest: string; expiresAt: number; pending: boolean; delegation: boolean; result: Promise<SettingsResultMessage> }

const SNAPSHOT_TTL = 15 * 60_000;
const RECEIPT_TTL = 20 * 60_000;
const MAX_SNAPSHOTS = 200;
const MAX_RECEIPTS = 1_000;
const MAX_CHOICES = 512;
const BACKENDS: SettingsBackend[] = ['claude', 'codex', 'opencode', 'kimi', 'zcode', 'pi', 'agy', 'dsh'];
const validString = (value: unknown, max = 512): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const literal = (value: string, max = 240): string => Array.from(value.replace(/[\x00-\x1f\x7f]/g, ' ')).slice(0, max).join('');

class SettingsValidationError extends Error {}

/** Owns bounded, immutable choices and exactly identified settings actions. */
export class SettingsService {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly receipts = new Map<string, Receipt>();
  private openings = 0;
  private invalidationRevision = 0;
  private destroyed = false;
  private readonly now: () => number;

  constructor(private readonly dependencies: SettingsDependencies) { this.now = dependencies.now ?? Date.now; }

  invalidate(threadId?: string): void {
    this.invalidationRevision++;
    for (const [id, record] of this.snapshots) {
      if (!threadId || record.menu.threadId === threadId) this.snapshots.delete(id);
    }
  }

  destroy(): void { this.destroyed = true; this.invalidate(); this.receipts.clear(); }

  async open(kind: SettingsKind, threadId: string, owner: string, target?: SettingsBackend, requestId?: string): Promise<SettingsMenu> {
    this.prune();
    const invalidationRevision = this.invalidationRevision;
    if (this.destroyed) throw new SettingsValidationError('Settings are no longer available.');
    if (!validString(owner) || !validString(threadId, 100)) throw new SettingsValidationError('Invalid settings owner or thread.');
    if (this.snapshots.size + this.openings >= MAX_SNAPSHOTS) throw new SettingsValidationError('Too many settings cards are open. Please retry later.');
    const initial = this.dependencies.state(threadId);
    if (!initial) throw new SettingsValidationError('This thread no longer exists. Open a new settings card.');
    const initialRevision = initial.revision;
    const backend = target ?? initial.coordinatorBackend;
    if (!BACKENDS.includes(backend)) throw new SettingsValidationError('Invalid settings backend.');
    if (kind === 'delegation' && backend !== initial.coordinatorBackend) throw new SettingsValidationError('Delegation settings belong to the current thread, not another backend.');
    this.openings++;
    try {
      const backends = await this.dependencies.backends(threadId, kind);
      const installed = backends.find(entry => entry.value === backend)?.installed === true;
      const busy = this.dependencies.busy(threadId, requestId, kind !== 'backend');
      let catalog: SettingsCatalog = { choices: [], effectiveSource: 'unknown', supportsReset: false };
      if (kind === 'backend') {
        catalog = { choices: backends.map(entry => ({ value: entry.value, label: entry.label, disabled: !entry.installed, reason: entry.reason })),
          effectiveValue: initial.coordinatorBackend, effectiveSource: 'configured', supportsReset: true };
      } else if (kind === 'delegation') {
        const supported = this.dependencies.delegationSupported(threadId);
        catalog = { choices: [
          { value: 'on', label: 'On', disabled: !supported,
            reason: supported ? undefined : 'This backend cannot register delegation tools.' },
          { value: 'off', label: 'Off' },
        ], effectiveValue: initial.delegationEnabled ? 'on' : 'off', effectiveSource: 'configured', supportsReset: false };
      } else if (!installed) catalog.unavailableReason = 'This backend is not installed or its executable check failed.';
      else if (busy) catalog.unavailableReason = 'This thread is busy. Refresh after its work finishes.';
      else {
        try { catalog = await this.dependencies.catalog(threadId, backend, kind); }
        catch { catalog.unavailableReason = 'The backend did not provide a usable native catalog. Check backend capability/version, refresh or use a supported text command.'; }
      }
      const current = this.dependencies.state(threadId);
      if (this.destroyed || this.invalidationRevision !== invalidationRevision || !current || current.revision !== initialRevision) {
        throw new SettingsValidationError('Settings changed during the query. Open a new settings card.');
      }
      const seen = new Set<string>();
      const choices = catalog.choices.filter(choice => {
        if (!validString(choice.value) || !validString(choice.label, 4_096) || seen.has(choice.value)) return false;
        seen.add(choice.value); return true;
      });
      const menu: SettingsMenu = {
        snapshotId: randomUUID(), kind, threadId, threadName: literal(current.threadName, 80),
        coordinatorBackend: current.coordinatorBackend, targetBackend: backend,
        backends: backends.filter(entry => BACKENDS.includes(entry.value)).slice(0, 8)
          .map(entry => ({ ...entry, label: literal(entry.label, 80), reason: entry.reason ? literal(entry.reason) : undefined,
            version: entry.version ? literal(entry.version, 80) : undefined })),
        choices: choices.slice(0, MAX_CHOICES).map(choice => ({ ...choice, label: literal(choice.label, 120),
          description: choice.description ? literal(choice.description) : undefined, reason: choice.reason ? literal(choice.reason) : undefined })),
        configuredValue: kind === 'backend' ? current.coordinatorBackend
          : kind === 'delegation' ? current.delegationEnabled ? 'on' : 'off'
          : kind === 'model' ? current.configuredModels[backend] : current.configuredEfforts[backend],
        effectiveValue: catalog.effectiveValue, defaultValue: catalog.defaultValue,
        effectiveSource: catalog.effectiveSource, supportsReset: catalog.supportsReset && installed && !busy,
        followsGlobal: current.followsGlobal, busy, expiresAt: this.now() + SNAPSHOT_TTL,
        unavailableReason: catalog.unavailableReason ? literal(catalog.unavailableReason) : undefined,
        ...(choices.length > MAX_CHOICES ? { omittedChoices: choices.length - MAX_CHOICES } : {}),
      };
      if (!menu.choices.length && !menu.unavailableReason) menu.unavailableReason = 'No selectable options were returned by this backend.';
      this.snapshots.set(menu.snapshotId, { menu: structuredClone(menu), owner, revision: current.revision });
      return menu;
    } finally { this.openings--; }
  }

  async action(request: SettingsActionMessage, allowDelegation = true): Promise<SettingsResultMessage> {
    this.prune();
    const failure = (error: string): SettingsResultMessage => ({ type: 'settings_result', messageId: request.messageId,
      openId: request.openId, threadId: request.threadId, snapshotId: request.snapshotId, success: false, error, timestamp: this.now() });
    if (this.destroyed || !validString(request.messageId, 200) || !validString(request.openId) || !validString(request.threadId, 100)
      || !validString(request.snapshotId, 100) || !['view', 'apply', 'reset', 'follow_global'].includes(request.operation)) {
      return failure('Invalid settings action.');
    }
    const digest = createHash('sha256').update(JSON.stringify([request.openId, request.threadId, request.snapshotId,
      request.operation, request.targetBackend, request.value, request.scope])).digest('hex');
    const existing = this.receipts.get(request.messageId);
    const delegation = this.snapshots.get(request.snapshotId)?.menu.kind === 'delegation';
    if (!allowDelegation && (delegation || existing?.delegation)) return failure('Delegation cards were not negotiated with this Router.');
    if (existing) return existing.digest === digest ? existing.result : failure('This request ID belongs to a different settings action.');
    if (this.receipts.size >= MAX_RECEIPTS) return failure('Settings acknowledgement storage is full. Please retry later.');
    // Defer body by one microtask so every concurrent retry sees this reservation.
    const receipt: Receipt = { digest, expiresAt: this.now() + RECEIPT_TTL, pending: true, delegation, result: Promise.resolve(null as never) };
    receipt.result = Promise.resolve().then(async () => {
      try {
        const record = this.validate(request);
        const menu = record.menu;
        if (menu.kind === 'delegation' && !allowDelegation) throw new SettingsValidationError('Delegation cards were not negotiated with this Router.');
        if (request.operation === 'view') {
          if (request.value !== undefined || request.scope !== undefined) throw new SettingsValidationError('Invalid settings view action.');
          const target = request.targetBackend ?? menu.targetBackend;
          if (menu.kind === 'delegation' && request.targetBackend !== undefined) throw new SettingsValidationError('Delegation cards cannot select another backend.');
          if (menu.kind !== 'delegation' && !menu.backends.some(entry => entry.value === target && entry.installed)) throw new SettingsValidationError('This backend is unavailable.');
          const refreshed = await this.open(menu.kind, menu.threadId, request.openId, target);
          this.snapshots.delete(menu.snapshotId);
          return { ...failure(''), success: true, error: undefined, menu: refreshed };
        }
        if (request.targetBackend !== undefined) throw new SettingsValidationError('Only a settings view can change its target backend.');
        if (menu.busy) throw new SettingsValidationError('This card was opened while the thread was busy. Refresh before applying settings.');
        if (request.operation === 'follow_global' && (menu.kind !== 'backend' || request.scope === 'all' || request.value !== undefined)) throw new SettingsValidationError('Invalid follow-global action.');
        if (request.operation === 'reset' && (!menu.supportsReset || menu.kind === 'backend' || request.value !== undefined || request.scope !== undefined)) throw new SettingsValidationError('Reset is not available for this setting.');
        if (request.operation === 'apply' && !menu.choices.some(choice => choice.value === request.value && !choice.disabled)) throw new SettingsValidationError('This choice is not available on the original settings card.');
        if (menu.kind !== 'backend' && request.scope !== undefined) throw new SettingsValidationError('This setting only affects the original thread.');
        if (request.scope !== undefined && request.scope !== 'thread' && request.scope !== 'all') throw new SettingsValidationError('Invalid settings scope.');
        const scope = menu.kind === 'backend' && request.scope === 'all' ? 'all' : 'thread';
        const result = await this.dependencies.exclusive(scope === 'all' ? '*' : menu.threadId, async () => {
          this.validate(request);
          const affected = scope === 'all' ? this.dependencies.threads() : [menu.threadId];
          if (affected.some(id => this.dependencies.busy(id, undefined, menu.kind !== 'backend'))) throw new SettingsValidationError('An affected thread is busy. Retry when its work is finished.');
          const installed = await this.dependencies.backends(menu.threadId, menu.kind);
          this.validate(request);
          if (affected.some(id => this.dependencies.busy(id, undefined, menu.kind !== 'backend'))) throw new SettingsValidationError('An affected thread became busy. No setting was applied.');
          const backend = menu.kind === 'backend' && request.operation === 'apply' ? request.value as SettingsBackend : menu.targetBackend;
          if (menu.kind !== 'delegation' && request.operation !== 'follow_global' && !installed.some(entry => entry.value === backend && entry.installed)) throw new SettingsValidationError('This backend is no longer available.');
          try {
            return menu.kind === 'backend'
              ? await this.dependencies.backend(menu.threadId, backend, scope, request.operation === 'follow_global')
              : menu.kind === 'delegation' ? await this.dependencies.delegation(menu.threadId, request.value === 'on')
              : await this.dependencies.preference(menu.threadId, backend, menu.kind, request.operation === 'reset' ? undefined : request.value);
          } finally { this.invalidate(scope === 'all' ? undefined : menu.threadId); }
        });
        if (!result.success) return failure('The setting was not confirmed as applied. Check backend state and refresh before retrying.');
        // Applied state is durable before this optional refresh; a catalog error cannot reverse it.
        let fresh: SettingsMenu | undefined;
        try { fresh = await this.open(menu.kind, menu.threadId, request.openId,
          menu.kind === 'backend' ? undefined : menu.targetBackend); } catch { /* Preserve the positive acknowledgement. */ }
        return { ...failure(''), success: true, error: undefined,
          notice: menu.kind === 'delegation' ? 'Delegation setting applied to this thread. Future commands will use the updated setting.'
            : 'Setting applied. Future commands and worker launches will use the updated preference.', menu: fresh };
      } catch (error) {
        return failure(error instanceof SettingsValidationError || error instanceof SettingsBusyError
          ? literal(error.message) : 'Settings could not be confirmed. Refresh and check backend state before retrying.');
      } finally { receipt.pending = false; }
    });
    this.receipts.set(request.messageId, receipt);
    return receipt.result;
  }

  private validate(request: SettingsActionMessage): Snapshot {
    const record = this.snapshots.get(request.snapshotId);
    const state = this.dependencies.state(request.threadId);
    if (!record || record.menu.expiresAt <= this.now() || record.owner !== request.openId
      || record.menu.threadId !== request.threadId || !state || state.revision !== record.revision) {
      throw new SettingsValidationError('This settings card is stale or belongs to another thread. Open a new settings card.');
    }
    return record;
  }

  private prune(): void {
    for (const [id, record] of this.snapshots) if (record.menu.expiresAt <= this.now()) this.snapshots.delete(id);
    for (const [id, record] of this.receipts) if (!record.pending && record.expiresAt <= this.now()) this.receipts.delete(id);
  }
}

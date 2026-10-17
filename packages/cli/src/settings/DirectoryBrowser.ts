import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import * as fs from 'fs/promises';
import path from 'path';
import type { DirectoryGuard } from '../security/DirectoryGuard';
import type { ExecuteResult } from '../executor/IExecutor';
import type { SettingsActionMessage, SettingsBackend, SettingsMenu, SettingsResultMessage } from '../types/Settings';

interface State { threadName: string; cwd: string; revision: string; backend: SettingsBackend }
interface Identity { path: string; dev: number; ino: number }
interface Selection { path: string; chain: Identity[] }
interface Snapshot {
  menu: SettingsMenu; owner: string; revision: string; policy: string;
  roots: Identity[]; targets: Map<string, Selection | 'roots'>;
}
interface Receipt { digest: string; pending: boolean; expires: number; result: Promise<SettingsResultMessage> }
export interface DirectoryBrowserDependencies {
  guard: DirectoryGuard;
  state(threadId: string): State | undefined;
  busy(threadId: string, exceptRequest?: string): boolean;
  exclusive<T>(threadId: string, body: () => Promise<T>): Promise<T>;
  apply(threadId: string, target: string): Promise<ExecuteResult>;
  now?(): number;
}

export const DIRECTORY_LIMITS = { entries: 4096, choices: 128, snapshots: 32, receipts: 256, ttl: 10 * 60_000 } as const;
const stale = 'This directory listing is stale or unavailable. Open /cd again.';
const display = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, ' ');
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/** Read-only navigation snapshots; only Apply acquires command admission and changes context. */
export class DirectoryBrowser {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly active = new Set<string>();
  private openings = 0;
  private epoch = 0;
  private destroyed = false;
  private readonly now: () => number;

  constructor(private readonly deps: DirectoryBrowserDependencies) { this.now = deps.now ?? Date.now; }

  invalidate(threadId?: string): void {
    this.epoch++;
    for (const [id, snapshot] of this.snapshots) if (!threadId || snapshot.menu.threadId === threadId) this.snapshots.delete(id);
  }

  destroy(): void { this.destroyed = true; this.invalidate(); this.receipts.clear(); }

  private policy(): string { return JSON.stringify(this.deps.guard.getAllowedDirectories()); }

  private async identity(target: string): Promise<Identity> {
    const info = await fs.lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || !Number.isSafeInteger(info.ino) || info.ino <= 0
      || !Number.isSafeInteger(info.dev) || info.dev < 0) throw new Error(stale);
    return { path: target, dev: info.dev, ino: info.ino };
  }

  private async verify(identity: Identity): Promise<void> {
    const actual = await this.identity(identity.path);
    if (actual.dev !== identity.dev || actual.ino !== identity.ino || await fs.realpath(identity.path) !== identity.path) throw new Error(stale);
  }

  private async selection(target: string, roots: Identity[]): Promise<Selection> {
    // Validate both lexical and canonical destinations. A directory alias is not a separate project.
    if (!this.deps.guard.isSafePath(target) || await fs.realpath(target) !== target) throw new Error(stale);
    const root = roots.filter(entry => inside(entry.path, target)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) throw new Error(stale);
    await this.verify(root);
    const chain = [root];
    let cursor = root.path;
    for (const component of path.relative(root.path, target).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      chain.push(await this.identity(cursor));
    }
    return { path: target, chain };
  }

  private async verifySelection(selection: Selection, roots: Identity[]): Promise<void> {
    await this.selection(selection.path, roots);
    for (const identity of selection.chain) await this.verify(identity);
    await fs.access(selection.path, constants.R_OK | constants.X_OK);
  }

  private validate(record: Snapshot): State {
    const state = this.deps.state(record.menu.threadId);
    if (this.destroyed || !state || record.menu.expiresAt <= this.now() || state.revision !== record.revision
      || this.policy() !== record.policy || this.snapshots.get(record.menu.snapshotId) !== record) throw new Error(stale);
    return state;
  }

  async open(threadId: string, owner: string, requestId?: string): Promise<SettingsMenu> {
    this.prune();
    const state = this.deps.state(threadId);
    if (!state || !owner || owner.length > 512 || this.destroyed) throw new Error(stale);
    // A newly opened card supersedes that owner's prior browser, just as Router presentation does.
    // Do not accumulate cancelled/superseded snapshots until the global limit blocks navigation.
    for (const [id, record] of this.snapshots) {
      if (record.owner === owner && record.menu.threadId === threadId && !this.active.has(id)) this.snapshots.delete(id);
    }
    const roots: Identity[] = [];
    for (const entry of this.deps.guard.getAllowedDirectories().slice(0, 32)) {
      try {
        const normalized = this.deps.guard.normalizePath(entry, state.cwd);
        if (!this.deps.guard.isSafePath(normalized) || await fs.realpath(normalized) !== normalized) continue;
        roots.push(await this.identity(normalized));
      } catch { /* Unavailable roots are described below, never enumerated. */ }
    }
    if (!roots.length) throw new Error('No readable, non-symbolic allowed directory roots are available. Check the directory allowlist.');
    let target: Selection | 'roots' = 'roots';
    try { target = await this.selection(state.cwd, roots); } catch { /* An unauthorized or missing cwd opens the allowed-root chooser. */ }
    return this.build(threadId, owner, state, roots, target, requestId);
  }

  private async build(threadId: string, owner: string, initial: State, roots: Identity[], target: Selection | 'roots', requestId?: string, replacing?: string): Promise<SettingsMenu> {
    this.prune();
    const replacement = replacing && this.snapshots.has(replacing) ? 1 : 0;
    if (this.snapshots.size + this.openings - replacement >= DIRECTORY_LIMITS.snapshots) throw new Error('Too many directory cards are open. Retry after older cards expire.');
    this.openings++;
    const epoch = this.epoch;
    const policy = this.policy();
    try {
      for (const root of roots) await this.verify(root);
      const targets = new Map<string, Selection | 'roots'>();
      const token = (selection: Selection | 'roots') => { const id = randomUUID(); targets.set(id, selection); return id; };
      const directory: NonNullable<SettingsMenu['directory']> = {
        currentPath: display(initial.cwd), browsingPath: target === 'roots' ? 'Allowed directories' : display(target.path),
        roots: token('roots'), refresh: token(target),
      };
      const choices: SettingsMenu['choices'] = [];
      let omitted = false;
      let skipped = 0;
      if (target === 'roots') {
        for (const root of roots) {
          try { choices.push({ value: token(await this.selection(root.path, roots)), label: display(root.path) }); }
          catch { skipped++; }
        }
      } else {
        await this.verifySelection(target, roots);
        directory.apply = token(target);
        const root = roots.filter(entry => inside(entry.path, target.path)).sort((a, b) => b.path.length - a.path.length)[0];
        if (target.path !== root.path) directory.parent = token(await this.selection(path.dirname(target.path), roots));
        const handle = await fs.opendir(target.path);
        const started = this.now();
        let scanned = 0;
        try {
          for await (const entry of handle) {
            if (++scanned > DIRECTORY_LIMITS.entries || choices.length >= DIRECTORY_LIMITS.choices || this.now() - started > 5_000) { omitted = true; break; }
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            try {
              const selected = await this.selection(path.join(target.path, entry.name), roots);
              choices.push({ value: token(selected), label: display(entry.name) });
            } catch { skipped++; }
          }
        } finally { await handle.close().catch(() => undefined); }
        await this.verifySelection(target, roots);
        choices.sort((a, b) => a.label.localeCompare(b.label));
      }
      directory.notice = 'Symbolic-link directories are not listed. Parent stops at the nearest allowed root.'
        + (omitted ? ' Partial listing: the scan limit was reached. Use /cd <path> for an unlisted directory.' : '')
        + (skipped ? ` ${skipped} unavailable or changed directories were skipped.` : '')
        + (this.deps.guard.getAllowedDirectories().length > roots.length ? ' Some configured roots are unavailable, symbolic or exceed the root limit.' : '');
      const current = this.deps.state(threadId);
      if (this.destroyed || epoch !== this.epoch || !current || current.revision !== initial.revision || policy !== this.policy()) throw new Error(stale);
      const menu: SettingsMenu = {
        snapshotId: `directory-${randomUUID()}`, kind: 'directory', threadId, threadName: display(current.threadName),
        coordinatorBackend: current.backend, targetBackend: current.backend,
        backends: [{ value: current.backend, label: current.backend, installed: true }], choices,
        effectiveSource: 'configured', supportsReset: false, busy: this.deps.busy(threadId, requestId),
        expiresAt: this.now() + DIRECTORY_LIMITS.ttl, directory,
      };
      this.snapshots.set(menu.snapshotId, { menu: structuredClone(menu), owner, revision: current.revision, roots, targets, policy });
      return menu;
    } finally { this.openings--; }
  }

  async action(request: SettingsActionMessage): Promise<SettingsResultMessage> {
    this.prune();
    const failure = (error: string): SettingsResultMessage => ({ type: 'settings_result', messageId: request.messageId,
      openId: request.openId, threadId: request.threadId, snapshotId: request.snapshotId, success: false, error, timestamp: this.now() });
    if (typeof request.messageId !== 'string' || request.messageId.length > 200 || !request.messageId
      || typeof request.snapshotId !== 'string' || typeof request.value !== 'string'
      || request.targetBackend !== undefined || request.scope !== undefined || !['view', 'apply'].includes(request.operation)) return failure('Invalid directory action.');
    const digest = createHash('sha256').update(JSON.stringify([request.openId, request.threadId, request.snapshotId, request.operation, request.value])).digest('hex');
    const existing = this.receipts.get(request.messageId);
    if (existing) return existing.digest === digest ? existing.result : failure('This request ID belongs to a different directory action.');
    if (this.receipts.size >= DIRECTORY_LIMITS.receipts) return failure('Directory acknowledgement storage is full. Retry later.');
    const receipt: Receipt = { digest, pending: true, expires: this.now() + 20 * 60_000, result: Promise.resolve(null as never) };
    receipt.result = Promise.resolve().then(async () => {
      const record = this.snapshots.get(request.snapshotId);
      if (!record || record.owner !== request.openId || record.menu.threadId !== request.threadId) return failure(stale);
      if (this.active.has(request.snapshotId)) return failure('Another directory action is pending. Retry after it finishes.');
      this.active.add(request.snapshotId);
      let mutationStarted = false;
      try {
        const state = this.validate(record);
        const target = record.targets.get(request.value!);
        if (!target) throw new Error('This directory was not present on the original card.');
        if (request.operation === 'view') {
          if (request.value === record.menu.directory?.apply) throw new Error('Invalid directory navigation.');
          if (target !== 'roots') await this.verifySelection(target, record.roots);
          this.validate(record);
          const menu = await this.build(request.threadId, request.openId, state, record.roots, target, undefined, request.snapshotId);
          this.snapshots.delete(request.snapshotId);
          return { ...failure(''), success: true, error: undefined, menu };
        }
        if (request.value !== record.menu.directory?.apply || target === 'roots') throw new Error('Invalid directory selection.');
        const result = await this.deps.exclusive(request.threadId, async () => {
          this.validate(record);
          if (this.deps.busy(request.threadId)) throw new Error('This thread has active or queued work. Retry after it finishes.');
          await this.verifySelection(target, record.roots);
          this.validate(record);
          if (this.deps.busy(request.threadId)) throw new Error('The thread became busy. No directory was changed.');
          mutationStarted = true;
          try { return await this.deps.apply(request.threadId, target.path); }
          finally { this.invalidate(request.threadId); }
        });
        if (!result.success) return failure('Directory change was not confirmed. Check /status and reopen /cd before retrying.');
        return { ...failure(''), success: true, error: undefined, notice: result.output ?? 'Working directory applied.' };
      } catch {
        return failure(mutationStarted
          ? 'Directory change was not confirmed and may have partially cleared conversation bindings. Check /status and reopen /cd before retrying.'
          : 'The directory listing is stale, inaccessible, or the thread is busy. No directory change was started. Reopen /cd and retry when idle.');
      } finally { this.active.delete(request.snapshotId); }
    }).finally(() => { receipt.pending = false; });
    this.receipts.set(request.messageId, receipt);
    return receipt.result;
  }

  private prune(): void {
    for (const [id, record] of this.snapshots) if (record.menu.expiresAt <= this.now()) this.snapshots.delete(id);
    for (const [id, receipt] of this.receipts) if (!receipt.pending && receipt.expires <= this.now()) this.receipts.delete(id);
  }
}

import type { IExecutor } from '../executor/IExecutor';
import type { BackendKey } from '../types/config';
import type { SessionCatalog, SessionCatalogCandidate } from './SessionCatalog';
import type { PiSessionLocator } from './adapters/PiSessionCatalog';
import {
  CATALOG_BACKENDS,
  NATIVE_RESUME_BACKENDS,
  catalogTarget,
  formatCatalog,
  sessionBackendLabel,
  sessionResumeGate,
  sessionSharingDenied,
} from './SessionResumeService';
import {
  SESSION_MENU_PAGE_SIZE,
  SessionMenuStore,
  parseSessionBindingCommand,
  parseSessionMenuCommand,
  sessionMenuPageCount,
  type SessionMenuCommand,
  type SessionMenuScope,
  type SessionMenuSnapshot,
} from './SessionMenu';

export interface SessionControlResponse {
  success: boolean;
  output?: string;
  error?: string;
}

/** Local binding state recorded in the thread's Pi pointer. */
export interface PiBindingState {
  id?: string;
  adopted: boolean;
}

/** Everything the service needs from the daemon; injected for isolated tests. */
export interface SessionControlDeps {
  sharingConfig(): unknown;
  backendOf(threadId: string): BackendKey;
  /** Canonical, allowed thread workspace, or undefined when unavailable. */
  workingDirectory(threadId: string): string | undefined;
  threadName(threadId: string): string | undefined;
  isBusy(threadId: string): boolean;
  setBusy(threadId: string, busy: boolean): void;
  executor(threadId: string): IExecutor;
  readCatalog(backend: BackendKey, workingDirectory: string): SessionCatalog | undefined;
  resolvePi(workingDirectory: string, id: string): PiSessionLocator | undefined;
  piHolder(file: string, threadId: string): string | undefined;
  piBinding(threadId: string): PiBindingState | undefined;
}

export interface SessionControlContext {
  openId?: string;
  threadId: string;
}

const NOTHING_SENT = 'No task was sent.';

function describe(candidate: SessionCatalogCandidate): string {
  const title = candidate.name ?? `Session ${candidate.id.slice(0, 8)}`;
  const updated = new Date(candidate.modifiedAt).toISOString().slice(0, 16).replace('T', ' ');
  const count = candidate.countComplete ? `${candidate.messageCount} messages` : 'messages unavailable';
  return `${title} \u00b7 \`${candidate.id}\` \u00b7 ${count} \u00b7 updated ${updated} UTC`;
}

/**
 * Owns `/resume` and `/session`. Listing and paging are read-only; only a
 * confirmed, scope-bound, single-use token reaches executor adoption, and only
 * for backends whose strict native resume is implemented.
 */
export class SessionControl {
  private readonly menus: SessionMenuStore;
  /** In-flight native files, including quarantined outcomes, shared across this daemon's threads. */
  private readonly sessionReservations = new Map<string, string>();

  constructor(private readonly deps: SessionControlDeps, menus = new SessionMenuStore()) {
    this.menus = menus;
  }

  async handle(content: string, context: SessionControlContext): Promise<SessionControlResponse> {
    const { threadId } = context;
    const backend = this.deps.backendOf(threadId);
    const cwd = this.deps.workingDirectory(threadId);
    const scope: SessionMenuScope = { openId: context.openId, threadId, workingDirectory: cwd ?? '' };

    const binding = parseSessionBindingCommand(content);
    if (binding) {
      if (binding.kind === 'invalid') return { success: false, error: binding.error };
      return this.handleBinding(binding.kind, 'token' in binding ? binding.token : undefined, backend, scope, content);
    }

    const menu = parseSessionMenuCommand(content);
    if (menu) return this.handleMenu(menu, backend, cwd, scope);

    const result = sessionResumeGate(content, backend, this.deps.sharingConfig());
    const target = catalogTarget(content, backend);
    if (result.code !== 'native_capability_unavailable' || !target || !CATALOG_BACKENDS.includes(target)) {
      return { success: false, error: result.error };
    }
    const catalog = cwd ? this.deps.readCatalog(target, cwd) : undefined;
    if (!cwd || !catalog) {
      return { success: false, error: 'The thread working directory is not allowed or not set. No session was loaded or task sent.' };
    }
    return { success: true, output: this.render(this.menus.create(target, scope, catalog), 1, backend) };
  }

  private render(snapshot: SessionMenuSnapshot, page: number, threadBackend: BackendKey): string {
    return formatCatalog(snapshot.catalog, snapshot.backend, {
      token: snapshot.token, page, pageSize: SESSION_MENU_PAGE_SIZE, query: snapshot.query,
      connectable: NATIVE_RESUME_BACKENDS.includes(snapshot.backend) && snapshot.backend === threadBackend,
    });
  }

  private async handleMenu(command: SessionMenuCommand, backend: BackendKey, cwd: string | undefined,
    scope: SessionMenuScope): Promise<SessionControlResponse> {
    if (command.kind === 'invalid') return { success: false, error: command.error };
    const expired = 'This session menu has expired or belongs to another thread, workspace or user. Send /resume to list sessions again.';

    if (command.kind === 'confirm' || command.kind === 'cancel') {
      const pending = this.menus.take(command.token, scope, 'resume');
      if (!pending) return { success: false, error: 'This confirmation has expired, was already used, or belongs to another thread, workspace or user. Nothing was changed.' };
      if (command.kind === 'cancel') return { success: true, output: 'Cancelled. Nothing was changed.' };
      return this.adopt(pending.sessionId, pending.revision!, backend, cwd, scope, pending.replaces);
    }

    if (command.kind === 'id') {
      const denied = sessionSharingDenied(backend, this.deps.sharingConfig());
      if (denied) return { success: false, error: denied.error };
      if (!NATIVE_RESUME_BACKENDS.includes(backend) || !cwd) return this.prepare(backend, backend, undefined, cwd, scope);
      const catalog = this.deps.readCatalog(backend, cwd);
      const candidate = catalog?.candidates.find(item => item.id === command.id);
      if (!candidate) return { success: false, error: `No ${sessionBackendLabel(backend)} session with that ID was found for this workspace. Send /resume to list sessions.` };
      return this.prepare(backend, backend, candidate, cwd, scope);
    }

    const source = this.menus.get(command.token, scope);
    if (!source) return { success: false, error: expired };
    const denied = sessionSharingDenied(source.backend, this.deps.sharingConfig());
    if (denied) return { success: false, error: denied.error };

    if (command.kind === 'select') {
      const candidate = source.catalog.candidates[command.row - 1];
      if (!candidate) return { success: false, error: `Row ${command.row} is not in this session menu.` };
      return this.prepare(source.backend, backend, candidate, cwd, scope);
    }

    const snapshot = command.kind === 'search' ? this.menus.search(command.token, scope, command.text)! : source;
    const pages = sessionMenuPageCount(snapshot);
    if (command.kind === 'page' && command.page > pages) {
      return { success: false, error: `This session menu has ${pages} page${pages === 1 ? '' : 's'}.` };
    }
    return { success: true, output: this.render(snapshot, command.kind === 'page' ? command.page : 1, backend) };
  }

  /** Validate a selection and issue a mutation-free confirmation. */
  private prepare(target: BackendKey, threadBackend: BackendKey, candidate: SessionCatalogCandidate | undefined,
    cwd: string | undefined, scope: SessionMenuScope): SessionControlResponse {
    if (!NATIVE_RESUME_BACKENDS.includes(target)) {
      return { success: false, error: `${sessionBackendLabel(target)} native resume is not available in this release. Only Pi sessions can be connected so far. No session was loaded or task sent.` };
    }
    if (threadBackend !== target) {
      return { success: false, error: `This thread uses ${sessionBackendLabel(threadBackend)}. Switch this thread to ${sessionBackendLabel(target)} with \`/backend <index> @\` first, then send /resume again. Nothing was changed.` };
    }
    if (!cwd || !candidate) return { success: false, error: 'The thread working directory is not allowed or not set. Nothing was changed.' };
    const checked = this.checkTarget(candidate.id, scope.threadId, cwd);
    if ('error' in checked) return { success: false, error: checked.error };
    const replaces = this.deps.piBinding(scope.threadId);
    const replaced = replaces?.adopted && replaces.id && replaces.id !== candidate.id ? replaces.id : undefined;
    const pending = this.menus.confirm({ action: 'resume', backend: target, scope, sessionId: candidate.id, revision: checked.locator.revision, replaces: replaced });
    return {
      success: true,
      output: [
        `Connect this thread to the ${sessionBackendLabel(target)} session below?`,
        '',
        describe(candidate),
        '',
        ...(replaced ? [`- This replaces this thread's current connection to session \`${replaced}\`; that session's history is kept.`, ''] : []),
        '- Its existing history is kept. Later /clear or /thread delete in this thread will not delete it.',
        '- Connecting sends no task. Your next message continues this session.',
        '- Local Pi may stay open, but keep it idle while this thread runs. Resume the same file locally before switching back; concurrent writes can create separate branches.',
        '- This thread\'s model or effort override, if set, applies to new turns.',
        '',
        `Confirm: \`/resume confirm ${pending.token}\``,
        `Cancel: \`/resume cancel ${pending.token}\` (expires in 5 minutes)`,
      ].join('\n'),
    };
  }

  private checkTarget(id: string, threadId: string, cwd: string): { locator: PiSessionLocator } | { error: string } {
    const locator = this.deps.resolvePi(cwd, id);
    if (!locator) return { error: 'This session is no longer listed for this workspace. Send /resume to list sessions again. Nothing was changed.' };
    if (this.sessionReservations.has(locator.file)) {
      return { error: 'This Pi session is being connected or requires process cleanup. Retry after the operation finishes; uncertain cleanup requires restarting the client after Pi exits.' };
    }
    const holder = this.deps.piHolder(locator.file, threadId);
    if (holder) {
      const name = this.deps.threadName(holder);
      return { error: `This session is already used by ${name ? `thread "${name}"` : 'another remote-cli thread'}. Detach it there first. Nothing was changed.` };
    }
    const current = this.deps.piBinding(threadId);
    if (current?.adopted && current.id === id) {
      return { error: 'This thread is already connected to that session. Send your next instruction to continue it.' };
    }
    return { locator };
  }

  /** Execute a confirmed adoption after revalidating everything the confirmation captured. */
  private async adopt(sessionId: string, revision: string, backend: BackendKey, cwd: string | undefined,
    scope: SessionMenuScope, replaces?: string): Promise<SessionControlResponse> {
    const denied = sessionSharingDenied(backend, this.deps.sharingConfig());
    if (denied) return { success: false, error: denied.error };
    if (!NATIVE_RESUME_BACKENDS.includes(backend) || !cwd) {
      return { success: false, error: 'This thread can no longer connect that session (its backend or workspace changed). Nothing was changed.' };
    }
    if (this.deps.isBusy(scope.threadId)) {
      return { success: false, error: 'This thread is running a task. Wait for it to finish (or send /abort), then select the session again. Nothing was changed.' };
    }
    const checked = this.checkTarget(sessionId, scope.threadId, cwd);
    if ('error' in checked) return { success: false, error: checked.error };
    if (checked.locator.revision !== revision) {
      return { success: false, error: 'The session changed after you selected it (for example a local Pi wrote to it). Wait for local work to finish, send /resume and select it again. Nothing was changed.' };
    }
    const executor = this.deps.executor(scope.threadId);
    if (!executor.adoptNativeSession) return { success: false, error: 'This backend cannot connect native sessions. Nothing was changed.' };
    // Reserve before the first asynchronous native operation, not after pointer publication.
    this.sessionReservations.set(checked.locator.file, scope.threadId);
    let releaseReservation = false;
    try {
      this.deps.setBusy(scope.threadId, true);
      const result = await executor.adoptNativeSession({ sessionId, sessionFile: checked.locator.file });
      releaseReservation = result.success || !result.recoveryRequired;
      if (!result.success) return { success: false, error: result.error };
    } finally {
      if (releaseReservation) this.sessionReservations.delete(checked.locator.file);
      this.deps.setBusy(scope.threadId, false);
    }
    return {
      success: true,
      output: [
        `\u2705 Connected to Pi session \`${sessionId}\`. ${NOTHING_SENT}`,
        ...(replaces ? [`The previous connection to \`${replaces}\` was replaced; its history is kept.`] : []),
        'Send your next instruction to continue it.',
        'Remote turns reload this session automatically. Before local work, wait for this thread to finish and resume the same file locally.',
      ].join('\n'),
    };
  }

  private async handleBinding(kind: 'status' | 'detach' | 'confirm' | 'cancel', token: string | undefined,
    backend: BackendKey, scope: SessionMenuScope, content: string): Promise<SessionControlResponse> {
    // An existing binding stays inspectable and detachable even if sharing was disabled later.
    const state = backend === 'pi' ? this.deps.piBinding(scope.threadId) : undefined;
    if (!state?.adopted) {
      const denied = sessionSharingDenied(backend, this.deps.sharingConfig());
      if (kind === 'status' || denied) return { success: false, error: (denied ?? sessionResumeGate(content, backend, this.deps.sharingConfig())).error };
      if (kind === 'confirm' || kind === 'cancel') this.menus.take(token!, scope, 'detach');
      return { success: false, error: 'This thread is not connected to a native session. Send /resume to list sessions.' };
    }
    const id = state.id ?? 'unknown';
    if (kind === 'status') {
      return { success: true, output: [
        `This thread is connected to Pi session \`${id}\` (reloads before every remote turn).`,
        'Local Pi may stay open. Use only one side at a time; resume the same file locally before the next local turn.',
        'Send /session detach to start a fresh conversation here without deleting native history.',
        'On this computer, run \`remote-cli session show --thread <thread-name> --backend pi\` for local reopen guidance.',
      ].join('\n') };
    }
    if (kind === 'detach') {
      const pending = this.menus.confirm({ action: 'detach', backend, scope, sessionId: id });
      return {
        success: true,
        output: [
          `Stop using Pi session \`${id}\` in this thread?`,
          'Its history stays on the computer and is not deleted. The next message here starts a fresh conversation.',
          '',
          `Confirm: \`/session confirm ${pending.token}\``,
          `Cancel: \`/session cancel ${pending.token}\` (expires in 5 minutes)`,
        ].join('\n'),
      };
    }
    if (kind === 'confirm' || kind === 'cancel') {
      const pending = this.menus.take(token!, scope, 'detach');
      if (!pending || pending.sessionId !== id) {
        return { success: false, error: 'This confirmation has expired, was already used, or no longer matches this thread. Nothing was changed.' };
      }
      if (kind === 'cancel') return { success: true, output: 'Cancelled. Nothing was changed.' };
    }
    if (this.deps.isBusy(scope.threadId)) {
      return { success: false, error: 'This thread is running a task. Wait for it to finish (or send /abort) first. Nothing was changed.' };
    }
    const executor = this.deps.executor(scope.threadId);
    const operation = executor.detachNativeSession;
    if (!operation) return { success: false, error: 'This backend cannot detach native sessions. Nothing was changed.' };
    this.deps.setBusy(scope.threadId, true);
    try {
      const result = await operation.call(executor);
      if (!result.success) return { success: false, error: result.error };
    } finally {
      this.deps.setBusy(scope.threadId, false);
    }
    return {
      success: true,
      output: `Detached Pi session \`${id}\`. Its history is kept on the computer; the next message here starts a fresh conversation.`,
    };
  }
}

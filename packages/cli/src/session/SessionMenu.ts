import { randomBytes } from 'crypto';
import type { BackendKey } from '../types/config';
import { safeSessionLabel, type SessionCatalog } from './SessionCatalog';

/** Initial UI limits from the session handoff specification. */
export const SESSION_MENU_PAGE_SIZE = 8;
export const SESSION_MENU_TTL_MS = 5 * 60 * 1000;
/** Bounded number of live snapshots kept in memory per CLI process. */
export const SESSION_MENU_LIMIT = 64;
const TOKEN = /^[A-Za-z0-9_-]{12}$/;

/** Who may use a snapshot: the original requester, thread and workspace. */
export interface SessionMenuScope {
  openId?: string;
  threadId: string;
  workingDirectory: string;
}

export interface SessionMenuSnapshot {
  token: string;
  backend: BackendKey;
  scope: SessionMenuScope;
  catalog: SessionCatalog;
  /** Sanitized search text that produced this snapshot, if any. */
  query?: string;
  createdAt: number;
}

export type SessionMenuCommand =
  | { kind: 'page'; token: string; page: number }
  | { kind: 'search'; token: string; text: string }
  | { kind: 'select'; token: string; row: number }
  | { kind: 'id'; id: string }
  | { kind: 'confirm' | 'cancel'; token: string }
  | { kind: 'invalid'; error: string };

/** `/session` subcommands; a bare `/session` is the status view. */
export type SessionBindingCommand =
  | { kind: 'status' }
  | { kind: 'detach' }
  | { kind: 'confirm' | 'cancel'; token: string }
  | { kind: 'invalid'; error: string };

/** A pending, single-use confirmation. Locators stay local to the CLI. */
export interface SessionConfirmation {
  token: string;
  action: 'resume' | 'detach';
  backend: BackendKey;
  scope: SessionMenuScope;
  sessionId: string;
  /** Adapter revision captured at selection; a later change requires reselection. */
  revision?: string;
  /** Session this confirmation replaces on the same thread, when it had one. */
  replaces?: string;
  createdAt: number;
}

const NATIVE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Parse snapshot-bound chooser commands. Returns undefined for anything that is
 * not a menu command so the regular session gate keeps handling it.
 */
export function parseSessionMenuCommand(content: string): SessionMenuCommand | undefined {
  const parts = content.trim().split(/\s+/);
  if (!/^\/(?:resume|r)$/i.test(parts[0]) || !['page', 'search', 'select', 'id', 'confirm', 'cancel'].includes(parts[1])) return undefined;
  if (parts[1] === 'id') {
    if (parts.length !== 3 || !NATIVE_ID.test(parts[2])) return { kind: 'invalid', error: 'Expected /resume id <native-session-id>.' };
    return { kind: 'id', id: parts[2] };
  }
  const token = parts[2];
  if (!token || !TOKEN.test(token)) return { kind: 'invalid', error: 'Expected a menu token from a /resume list.' };
  if (parts[1] === 'confirm' || parts[1] === 'cancel') {
    if (parts.length !== 3) return { kind: 'invalid', error: `Expected /resume ${parts[1]} <token>.` };
    return { kind: parts[1], token };
  }
  if (parts[1] === 'select') {
    if (parts.length !== 4 || !/^[1-9]\d{0,3}$/.test(parts[3])) return { kind: 'invalid', error: 'Expected /resume select <menu-token> <row-number>.' };
    return { kind: 'select', token, row: Number(parts[3]) };
  }
  if (parts[1] === 'page') {
    if (parts.length !== 4 || !/^[1-9]\d{0,3}$/.test(parts[3])) return { kind: 'invalid', error: 'Expected /resume page <menu-token> <page-number>.' };
    return { kind: 'page', token, page: Number(parts[3]) };
  }
  const text = safeSessionLabel(parts.slice(3).join(' '));
  if (!text) return { kind: 'invalid', error: 'Expected /resume search <menu-token> <text>.' };
  return { kind: 'search', token, text };
}

/** Parse `/session [detach|confirm <token>|cancel <token>]`. */
export function parseSessionBindingCommand(content: string): SessionBindingCommand | undefined {
  const parts = content.trim().split(/\s+/);
  if (!/^\/session$/i.test(parts[0])) return undefined;
  if (parts.length === 1) return { kind: 'status' };
  if (parts[1] === 'detach' && parts.length === 2) return { kind: 'detach' };
  if ((parts[1] === 'confirm' || parts[1] === 'cancel') && parts.length === 3 && TOKEN.test(parts[2])) return { kind: parts[1], token: parts[2] };
  return { kind: 'invalid', error: 'Expected /session, /session detach, /session confirm <token> or /session cancel <token>.' };
}

function sameScope(a: SessionMenuScope, b: SessionMenuScope): boolean {
  return a.openId === b.openId && a.threadId === b.threadId && a.workingDirectory === b.workingDirectory;
}

/**
 * In-memory, read-only chooser snapshots. Tokens are unguessable, expire after
 * five minutes, and only resolve for the original requester, thread and
 * workspace, so an old list never redirects to another context. Snapshots never
 * authorize a native action; they only fix the rows a user is paging through.
 */
export class SessionMenuStore {
  private readonly snapshots = new Map<string, SessionMenuSnapshot>();
  private readonly confirmations = new Map<string, SessionConfirmation>();

  constructor(private readonly now: () => number = Date.now) {}

  create(backend: BackendKey, scope: SessionMenuScope, catalog: SessionCatalog, query?: string): SessionMenuSnapshot {
    this.evict();
    const token = randomBytes(9).toString('base64url');
    const snapshot: SessionMenuSnapshot = { token, backend, scope: { ...scope }, catalog, query, createdAt: this.now() };
    this.snapshots.set(token, snapshot);
    while (this.snapshots.size > SESSION_MENU_LIMIT) this.snapshots.delete(this.snapshots.keys().next().value!);
    return snapshot;
  }

  /** Resolve a token for the same scope; any mismatch is indistinguishable from expiry. */
  get(token: string, scope: SessionMenuScope): SessionMenuSnapshot | undefined {
    this.evict();
    const snapshot = this.snapshots.get(token);
    return snapshot && sameScope(snapshot.scope, scope) ? snapshot : undefined;
  }

  /** Search returns a new snapshot; the original rows and token stay unchanged. */
  search(token: string, scope: SessionMenuScope, text: string): SessionMenuSnapshot | undefined {
    const source = this.get(token, scope);
    if (!source) return undefined;
    const needle = text.toLowerCase();
    const candidates = source.catalog.candidates.filter(item =>
      item.id.toLowerCase().includes(needle) || (item.name ?? '').toLowerCase().includes(needle));
    return this.create(source.backend, scope, { ...source.catalog, candidates }, text);
  }

  get size(): number { return this.snapshots.size; }

  /** Issue a confirmation; any earlier pending confirmation for the same thread is superseded. */
  confirm(pending: Omit<SessionConfirmation, 'token' | 'createdAt'>): SessionConfirmation {
    this.evict();
    for (const [token, existing] of this.confirmations) {
      if (existing.scope.threadId === pending.scope.threadId) this.confirmations.delete(token);
    }
    const confirmation: SessionConfirmation = { ...pending, scope: { ...pending.scope },
      token: randomBytes(9).toString('base64url'), createdAt: this.now() };
    this.confirmations.set(confirmation.token, confirmation);
    while (this.confirmations.size > SESSION_MENU_LIMIT) this.confirmations.delete(this.confirmations.keys().next().value!);
    return confirmation;
  }

  /** Single use: a matching confirmation is removed whether it is confirmed or cancelled. */
  take(token: string, scope: SessionMenuScope, action: SessionConfirmation['action']): SessionConfirmation | undefined {
    this.evict();
    const confirmation = this.confirmations.get(token);
    if (!confirmation || confirmation.action !== action || !sameScope(confirmation.scope, scope)) return undefined;
    this.confirmations.delete(token);
    return confirmation;
  }

  get pendingConfirmations(): number { return this.confirmations.size; }

  private evict(): void {
    const cutoff = this.now() - SESSION_MENU_TTL_MS;
    for (const [token, snapshot] of this.snapshots) if (snapshot.createdAt <= cutoff) this.snapshots.delete(token);
    for (const [token, pending] of this.confirmations) if (pending.createdAt <= cutoff) this.confirmations.delete(token);
  }
}

export function sessionMenuPageCount(snapshot: SessionMenuSnapshot): number {
  return Math.max(1, Math.ceil(snapshot.catalog.candidates.length / SESSION_MENU_PAGE_SIZE));
}

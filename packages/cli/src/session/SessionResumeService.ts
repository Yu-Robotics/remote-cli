import type { SessionSharingConfig, BackendKey } from '../types/config';
import type { SessionCatalog } from './SessionCatalog';
import { SESSION_CATALOG_READERS } from './adapters';

export const SESSION_BACKENDS = ['claude', 'codex', 'agy', 'opencode', 'kimi', 'zcode', 'pi', 'dsh'] as const;

export interface ResumeGateResult {
  success: false;
  code: 'sharing_disabled' | 'invalid_session_configuration' | 'native_capability_unavailable' | 'invalid_session_command';
  error: string;
}

const BACKEND_LABELS: Record<BackendKey, string> = {
  claude: 'Claude Code', codex: 'Codex', agy: 'AGY', opencode: 'OpenCode',
  kimi: 'Kimi', zcode: 'ZCode', pi: 'Pi', dsh: 'DSH',
};

/** User-facing backend name. */
export function sessionBackendLabel(backend: BackendKey): string {
  return BACKEND_LABELS[backend];
}

/** Backends whose strict native resume is verified and implemented. */
export const NATIVE_RESUME_BACKENDS: readonly BackendKey[] = ['pi'];

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the opt-in without resetting unrelated configuration on malformed input. */
export function validateSessionSharing(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).some(key => !['enabled', 'backends'].includes(key))) return 'Invalid session-sharing configuration.';
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return 'Session-sharing enabled must be a boolean.';
  if (value.backends === undefined) return undefined;
  if (!object(value.backends)) return 'Session-sharing backends must be an object.';
  for (const [backend, options] of Object.entries(value.backends)) {
    if (!SESSION_BACKENDS.includes(backend as BackendKey) || !object(options)
      || Object.keys(options).some(key => key !== 'enabled')
      || (options.enabled !== undefined && typeof options.enabled !== 'boolean')) {
      return 'Invalid session-sharing backend configuration.';
    }
  }
  return undefined;
}

/** Backends whose read-only catalog has been implemented; connecting remains unavailable. */
export const CATALOG_BACKENDS: readonly BackendKey[] = Object.keys(SESSION_CATALOG_READERS) as BackendKey[];

const CATALOG_LABELS: Partial<Record<BackendKey, string>> = { pi: 'Pi', codex: 'Codex', claude: 'Claude Code' };

/** Optional paging view for a tokenized snapshot. */
export interface CatalogView {
  token: string;
  page: number;
  pageSize: number;
  query?: string;
  /** Rows can be selected for a confirmed native connection. */
  connectable?: boolean;
}

/** Read-only menu rendering shared by the implemented catalog backends. */
export function formatCatalog(catalog: SessionCatalog, backend: BackendKey, view?: CatalogView): string {
  const label = CATALOG_LABELS[backend] ?? BACKEND_LABELS[backend];
  const pageSize = view?.pageSize ?? 8;
  const pages = Math.max(1, Math.ceil(catalog.candidates.length / pageSize));
  const page = Math.min(Math.max(view?.page ?? 1, 1), pages);
  const offset = (page - 1) * pageSize;
  const rows = catalog.candidates.slice(offset, offset + pageSize).map((item, index) => {
    const title = item.name ?? `Session ${item.id.slice(0, 8)}`;
    const updated = new Date(item.modifiedAt).toISOString().slice(0, 16).replace('T', ' ');
    const count = item.countComplete ? `${item.messageCount} messages` : 'messages unavailable';
    return `${offset + index + 1}. ${title} · \`${item.id}\` · ${count} · ${item.source} · updated ${updated} UTC`;
  });
  const hidden = catalog.candidates.length - (offset + rows.length);
  const more = !view && hidden > 0 ? [`… ${hidden} more not shown.`] : [];
  const body = rows.length ? rows.join('\n')
    : view?.query ? `No ${label} sessions match "${view.query}".` : `No ${label} sessions were found for this workspace.`;
  const coverage = catalog.complete ? [] : ['Coverage may be incomplete.'];
  const navigation = view ? [
    `Page ${page}/${pages}${view.query ? ` · search "${view.query}"` : ''} · menu \`${view.token}\` (expires in 5 minutes).`,
    ...(view.connectable && rows.length ? [`Select: \`/resume select ${view.token} <row-number>\``] : []),
    ...(page < pages ? [`Next: \`/resume page ${view.token} ${page + 1}\``] : []),
    `Search: \`/resume search ${view.token} <text>\``,
  ] : [];
  const footer = [...more, ...navigation, ...coverage, ...catalog.notes.map(note => `Note: ${note}`)];
  return [`🗂️ ${label} sessions in this workspace (read-only):`, '', body,
    ...(footer.length ? ['', ...footer] : []), '', view?.connectable
      ? 'Selecting a row only shows a confirmation; nothing is loaded and no task is sent until you confirm.'
      : 'Connecting to a session is not available yet: ownership and history-preserving handoff are still being verified. No session was loaded or task sent.']
    .join('\n');
}

/** Re-check local opt-in for a backend without parsing a command (menu actions). */
export function sessionSharingDenied(backend: BackendKey, configuration: unknown): ResumeGateResult | undefined {
  const invalid = validateSessionSharing(configuration);
  if (invalid) return { success: false, code: 'invalid_session_configuration', error: invalid };
  const config = configuration as SessionSharingConfig | undefined;
  if (config?.enabled !== true) {
    return { success: false, code: 'sharing_disabled', error: 'Session sharing is disabled. Native resume is not yet available; enabling configuration does not certify an adapter.' };
  }
  if (config.backends?.[backend]?.enabled === false) {
    return { success: false, code: 'sharing_disabled', error: `Session sharing is disabled for ${BACKEND_LABELS[backend]}.` };
  }
  return undefined;
}

/** Backwards-compatible alias for the Pi-only renderer used by earlier releases. */
export function formatPiCatalog(catalog: SessionCatalog): string {
  return formatCatalog(catalog, 'pi');
}

/** Return the target backend for a bare chooser request, or undefined for other session controls. */
export function catalogTarget(content: string, currentBackend: BackendKey): BackendKey | undefined {
  const parts = content.trim().split(/\s+/);
  if (!/^\/(?:resume|r)$/i.test(parts[0])) return undefined;
  if (parts.length === 1) return currentBackend;
  if (parts.length === 3 && parts[1] === 'backend' && SESSION_BACKENDS.includes(parts[2] as BackendKey)) return parts[2] as BackendKey;
  return undefined;
}

/** Recognize session controls before executor construction or slash passthrough. */
export function isSessionControl(content: string): boolean {
  return /^\/(?:resume|r|session)(?:\s|$)/i.test(content.trim());
}

/** Fail closed until discovery, ownership, preservation and native identity are certified. */
export function sessionResumeGate(content: string, currentBackend: BackendKey, configuration: unknown): ResumeGateResult {
  const invalid = validateSessionSharing(configuration);
  if (invalid) return { success: false, code: 'invalid_session_configuration', error: invalid };
  const config = configuration as SessionSharingConfig | undefined;
  if (config?.enabled !== true) {
    return { success: false, code: 'sharing_disabled', error: 'Session sharing is disabled. Native resume is not yet available; enabling configuration does not certify an adapter.' };
  }
  const parts = content.trim().split(/\s+/);
  let backend = currentBackend;
  const sessionStatus = /^\/session$/i.test(parts[0]);
  if (/^\/(?:resume|r)$/i.test(parts[0]) && parts[1] === 'backend') {
    if (!parts[2] || !SESSION_BACKENDS.includes(parts[2] as BackendKey)) {
      return { success: false, code: 'invalid_session_command', error: `Expected a backend key: ${SESSION_BACKENDS.join(', ')}.` };
    }
    backend = parts[2] as BackendKey;
  }
  if (config?.backends?.[backend]?.enabled === false) {
    return { success: false, code: 'sharing_disabled', error: `Session sharing is disabled for ${BACKEND_LABELS[backend]}.` };
  }
  if (sessionStatus) {
    return {
      success: false, code: 'native_capability_unavailable',
      error: `No native session is bound to this thread. ${BACKEND_LABELS[backend]} session status and detach become available after native resume is verified. No session was loaded or task sent.\n\nOn this computer, run \`remote-cli session show --thread <thread-name> --backend ${backend}\` for local-only reopen guidance; it never starts a backend.`,
    };
  }
  return {
    success: false, code: 'native_capability_unavailable',
    error: `${BACKEND_LABELS[backend]} native resume is not available in this release. Session discovery, ownership and history-preserving handoff are still being verified. No session was loaded or task sent.`,
  };
}

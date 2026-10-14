import type { BackendKey } from '../../types/config';
import type { SessionCatalog, SessionCatalogOptions } from '../SessionCatalog';
import { listClaudeSessions } from './ClaudeSessionCatalog';
import { listCodexSessions } from './CodexSessionCatalog';
import { listPiSessions } from './PiSessionCatalog';

/**
 * Implemented read-only catalogs, keyed by stable backend key. Adding a backend
 * here is what enables `/resume` discovery for it and what `CATALOG_BACKENDS`
 * reports; connecting to a session stays unavailable until strict native resume
 * is verified separately.
 */
export type SessionCatalogReader = (workingDirectory: string, options?: SessionCatalogOptions) => SessionCatalog;

export const SESSION_CATALOG_READERS: Partial<Record<BackendKey, SessionCatalogReader>> = {
  claude: listClaudeSessions,
  codex: listCodexSessions,
  pi: listPiSessions,
};

/** List one workspace's native sessions for an implemented backend; undefined when unsupported. */
export function readSessionCatalog(backend: BackendKey, workingDirectory: string,
  options?: SessionCatalogOptions): SessionCatalog | undefined {
  return SESSION_CATALOG_READERS[backend]?.(workingDirectory, options);
}

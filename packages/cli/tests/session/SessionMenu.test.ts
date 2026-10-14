import { describe, expect, it } from 'vitest';
import {
  SESSION_MENU_LIMIT,
  SESSION_MENU_PAGE_SIZE,
  SESSION_MENU_TTL_MS,
  SessionMenuStore,
  parseSessionMenuCommand,
  sessionMenuPageCount,
} from '../../src/session/SessionMenu';
import { formatCatalog, sessionSharingDenied } from '../../src/session/SessionResumeService';
import type { SessionCatalog } from '../../src/session/SessionCatalog';

const catalogOf = (count: number): SessionCatalog => ({
  candidates: Array.from({ length: count }, (_, i) => ({
    id: `session-${String(i).padStart(2, '0')}`, name: i % 2 ? `Refactor ${i}` : undefined,
    source: 'native-local' as const, modifiedAt: 1_700_000_000_000 - i, messageCount: 0, countComplete: false,
  })),
  complete: true,
  notes: [],
});
const scope = { openId: 'owner-example', threadId: 'thread-example', workingDirectory: '/workspace/example' };

describe('session menu commands', () => {
  it('parses page and search commands and leaves other session controls alone', () => {
    expect(parseSessionMenuCommand('/resume page abcdefghijkl 2')).toEqual({ kind: 'page', token: 'abcdefghijkl', page: 2 });
    expect(parseSessionMenuCommand('/r search abcdefghijkl  Fix **auth** ')).toEqual({ kind: 'search', token: 'abcdefghijkl', text: 'Fix auth' });
    for (const command of ['/resume', '/resume backend pi', '/session', '/resume pagex abc']) {
      expect(parseSessionMenuCommand(command)).toBeUndefined();
    }
  });

  it.each([
    '/resume page', '/resume page short 1', '/resume page abcdefghijkl', '/resume page abcdefghijkl 0',
    '/resume page abcdefghijkl 1 extra', '/resume page abcdefghijkl x', '/resume search abcdefghijkl',
    '/resume search abcdefghijkl ```', '/resume search ../../etc 1',
  ])('rejects malformed menu command %s', command => {
    expect(parseSessionMenuCommand(command)).toMatchObject({ kind: 'invalid' });
  });
});

describe('session menu snapshots', () => {
  it('issues unguessable tokens that resolve only for the original scope', () => {
    const menus = new SessionMenuStore();
    const first = menus.create('pi', scope, catalogOf(3));
    const second = menus.create('pi', scope, catalogOf(3));
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(first.token).not.toBe(second.token);
    expect(menus.get(first.token, scope)?.backend).toBe('pi');
    for (const other of [{ ...scope, openId: 'someone-else' }, { ...scope, openId: undefined },
      { ...scope, threadId: 'another-thread' }, { ...scope, workingDirectory: '/workspace/other' }]) {
      expect(menus.get(first.token, other)).toBeUndefined();
    }
    expect(menus.get('unknownToken', scope)).toBeUndefined();
  });

  it('expires snapshots after the menu TTL', () => {
    let now = 1_000;
    const menus = new SessionMenuStore(() => now);
    const snapshot = menus.create('codex', scope, catalogOf(1));
    now += SESSION_MENU_TTL_MS - 1;
    expect(menus.get(snapshot.token, scope)).toBeDefined();
    now += 1;
    expect(menus.get(snapshot.token, scope)).toBeUndefined();
    expect(menus.size).toBe(0);
  });

  it('bounds live snapshots and evicts the oldest first', () => {
    const menus = new SessionMenuStore();
    const first = menus.create('pi', scope, catalogOf(1));
    for (let i = 0; i < SESSION_MENU_LIMIT; i++) menus.create('pi', scope, catalogOf(1));
    expect(menus.size).toBe(SESSION_MENU_LIMIT);
    expect(menus.get(first.token, scope)).toBeUndefined();
  });

  it('searches into a new snapshot without changing the original rows', () => {
    const menus = new SessionMenuStore();
    const source = menus.create('claude', scope, catalogOf(20));
    const found = menus.search(source.token, scope, 'refactor 1')!;
    expect(found.token).not.toBe(source.token);
    expect(found.query).toBe('refactor 1');
    expect(found.catalog.candidates.map(c => c.name)).toEqual(['Refactor 1', 'Refactor 11', 'Refactor 13', 'Refactor 15', 'Refactor 17', 'Refactor 19']);
    expect(menus.search(source.token, scope, 'SESSION-03')!.catalog.candidates.map(c => c.id)).toEqual(['session-03']);
    expect(menus.get(source.token, scope)!.catalog.candidates).toHaveLength(20);
    expect(menus.search(source.token, { ...scope, threadId: 'other' }, 'x')).toBeUndefined();
  });

  it('counts pages with an eight-row page size', () => {
    const menus = new SessionMenuStore();
    expect(SESSION_MENU_PAGE_SIZE).toBe(8);
    expect(sessionMenuPageCount(menus.create('pi', scope, catalogOf(0)))).toBe(1);
    expect(sessionMenuPageCount(menus.create('pi', scope, catalogOf(8)))).toBe(1);
    expect(sessionMenuPageCount(menus.create('pi', scope, catalogOf(17)))).toBe(3);
  });
});

describe('paged catalog rendering', () => {
  it('numbers rows globally and offers next/search navigation bound to the token', () => {
    const text = formatCatalog(catalogOf(20), 'pi', { token: 'abcdefghijkl', page: 2, pageSize: 8 });
    expect(text).toContain('9. Session session-');
    expect(text).toContain('16. Refactor 15');
    expect(text).not.toContain('17. ');
    expect(text).toContain('Page 2/3');
    expect(text).toContain('`/resume page abcdefghijkl 3`');
    expect(text).toContain('`/resume search abcdefghijkl <text>`');
    expect(text).not.toContain('more not shown');
    const last = formatCatalog(catalogOf(20), 'pi', { token: 'abcdefghijkl', page: 3, pageSize: 8 });
    expect(last).toContain('Page 3/3');
    expect(last).not.toContain('Next:');
  });

  it('reports an empty search explicitly and clamps an out-of-range page', () => {
    const empty = formatCatalog({ candidates: [], complete: true, notes: [] }, 'codex', { token: 'abcdefghijkl', page: 1, pageSize: 8, query: 'missing' });
    expect(empty).toContain('No Codex sessions match "missing"');
    expect(empty).toContain('search "missing"');
    expect(formatCatalog(catalogOf(3), 'pi', { token: 'abcdefghijkl', page: 9, pageSize: 8 })).toContain('Page 1/1');
  });

  it('keeps the unpaged renderer unchanged for existing callers', () => {
    const text = formatCatalog(catalogOf(10), 'pi');
    expect(text).toContain('2 more not shown');
    expect(text).not.toContain('Page ');
  });

  it('re-checks local opt-in for menu actions', () => {
    expect(sessionSharingDenied('pi', { enabled: true })).toBeUndefined();
    expect(sessionSharingDenied('pi', undefined)?.code).toBe('sharing_disabled');
    expect(sessionSharingDenied('pi', { enabled: true, backends: { pi: { enabled: false } } })?.code).toBe('sharing_disabled');
    expect(sessionSharingDenied('pi', { enabled: 'yes' })?.code).toBe('invalid_session_configuration');
  });
});

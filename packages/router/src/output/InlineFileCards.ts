import fs from 'fs/promises';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { PrivateOutputRoot } from './PrivateOutputRoot';
import { durableJson } from './Durable';
import { formatOutputFileSize, formatOutputExpiry } from './OutputFileCards';

export interface InlineIdentity { messageId: string; openId: string; deviceId: string; epoch: string; threadId: string; generation?: number }
export interface InlineOwner extends InlineIdentity { rootId: string }
export interface InlineFileRow extends InlineIdentity { size?: number; expiresAt?: number; id: string; name: string; generation: number; status: string; op?: 'get' | 'retry'; revision?: number }
export type HintStatus = 'disabled' | 'approval' | 'upgrade' | 'unavailable' | 'ready';
interface Parent extends InlineOwner {
  token: string; expiresAt: number; generation?: number; cardId?: string; base?: string;
  verified?: boolean;
  display?: { hash: string; attempts: number; confirmed: boolean };
  names: string[]; status: HintStatus; page: number;
}
interface Dependencies {
  owns(owner: InlineOwner): Promise<boolean>;
  rows(identity: InlineIdentity): InlineFileRow[];
  status?(owner: InlineOwner): HintStatus | undefined;
  patch(cardId: string, content: string): Promise<void>;
}
const TTL = 86_400_000, MAX_BYTES = 8 * 1024 * 1024, PANEL = 'output_files_inline';
const label = (v: unknown, max = 200): v is string => typeof v === 'string' && !!v && v.length <= max;
const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 120);
export const sameInlineIdentity = (a: InlineIdentity, b: InlineIdentity): boolean =>
  ['messageId', 'openId', 'deviceId', 'epoch', 'threadId'].every(k => a[k as keyof InlineIdentity] === b[k as keyof InlineIdentity])
  && (a.generation === undefined || b.generation === undefined || a.generation === b.generation);
const same = (a: InlineOwner, b: InlineOwner) => a.rootId === b.rootId && sameInlineIdentity(a, b);
const nodes = (v: any): number => !v || typeof v !== 'object' ? 0 : (typeof v.tag === 'string' ? 1 : 0)
  + Object.values(v).reduce<number>((sum, child) => sum + (Array.isArray(child) ? child.reduce((n, c) => n + nodes(c), 0) : nodes(child)), 0);
function baseCard(content: string): string {
  const card = JSON.parse(content);
  if (card.schema !== '2.0' || !Array.isArray(card.body?.elements)) throw new Error('Invalid assistant card body.');
  card.body.elements = card.body.elements.filter((e: any) => e.element_id !== PANEL);
  const text = JSON.stringify(card);
  if (Buffer.byteLength(text) > 2_850_000 || nodes(card) > 168) throw new Error('Assistant card body exceeds reserved capacity.');
  return text;
}
const valid = (p: Parent) => p && ['messageId', 'openId', 'deviceId', 'epoch', 'threadId'].every(k => label(p[k as keyof Parent]))
  && label(p.rootId, 512) && /^[a-f0-9]{64}$/.test(p.token) && Number.isSafeInteger(p.expiresAt)
  && (p.generation === undefined || Number.isSafeInteger(p.generation) && p.generation >= 0)
  && Array.isArray(p.names) && p.names.length <= 16 && p.names.every(n => label(n, 120) && clean(n) === n && !/[\\/]/.test(n))
  && ['disabled', 'approval', 'upgrade', 'unavailable', 'ready'].includes(p.status)
  && (p.verified === undefined || typeof p.verified === 'boolean')
  && (p.display === undefined || /^[a-f0-9]{64}$/.test(p.display.hash) && Number.isInteger(p.display.attempts) && p.display.attempts >= 0 && p.display.attempts <= 3 && typeof p.display.confirmed === 'boolean')
  && Number.isInteger(p.page) && p.page >= 0 && p.page < 30
  && (p.cardId === undefined && p.base === undefined || label(p.cardId, 512) && typeof p.base === 'string' && baseCard(p.base) === p.base);

/** A bounded private body journal. Routing identities alone never authorize replacing a card. */
export class InlineFileCards {
  private readonly storage: PrivateOutputRoot;
  private parents = new Map<string, Parent>();
  private bodies = new Map<string, { rootId: string; base: string; at: number }>();
  private tails = new Map<string, Promise<unknown>>();
  private saveTail: Promise<void> = Promise.resolve();
  private loading?: Promise<void>;
  private stopped = false;
  private healthy = true;
  private hashes = new Map<string, string>();
  constructor(root: string, private readonly deps: Dependencies) { this.storage = new PrivateOutputRoot(root); }
  initialize(): Promise<void> {
    return this.loading ??= (async () => {
      await this.storage.initialize();
      try {
        const file = path.join(this.storage.path, 'parents.json'), s = await fs.lstat(file);
        if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_BYTES) throw new Error('Invalid inline card journal.');
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.parents) || data.parents.length > 100 || !data.parents.every(valid)
          || new Set(data.parents.map((p: Parent) => p.messageId)).size !== data.parents.length
          || new Set(data.parents.map((p: Parent) => p.rootId)).size !== data.parents.length
          || new Set(data.parents.filter((p: Parent) => p.cardId).map((p: Parent) => p.cardId)).size !== data.parents.filter((p: Parent) => p.cardId).length) throw new Error('Invalid inline card journal.');
        for (const parent of data.parents) this.retain(parent);
        this.parents = new Map(data.parents.filter((p: Parent) => p.expiresAt > Date.now()).map((p: Parent) => [p.messageId, p]));
      } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    })();
  }
  private rows(owner: InlineIdentity): InlineFileRow[] {
    const rows = this.deps.rows(owner).filter(row => sameInlineIdentity(owner, row));
    return owner.generation === undefined && new Set(rows.map(row => row.generation)).size > 1 ? [] : rows;
  }
  private retain(parent: Parent): void {
    // Receipt expiry is fixed at capture. Never renew from a click or restart clock.
    const rows = this.rows(parent).filter(row => Number.isSafeInteger(row.expiresAt)
      && row.expiresAt! > Date.now() && row.expiresAt! <= Date.now() + TTL + 5000);
    if (!rows.length) return;
    parent.generation ??= rows[0].generation; parent.verified = true;
    parent.expiresAt = Math.max(parent.expiresAt, ...rows.map(row => row.expiresAt!));
  }
  async identityStatus(owner: InlineIdentity): Promise<'match' | 'conflict' | 'unknown'> {
    await this.initialize(); const parent = this.parents.get(owner.messageId);
    if (!parent) return 'unknown';
    return sameInlineIdentity(parent, owner) ? 'match' : 'conflict';
  }
  private evictDormant(): boolean {
    const entry = [...this.parents].find(([, p]) => !p.verified && !this.tails.has(p.rootId) && !this.rows(p).length);
    if (!entry) return false;
    this.parents.delete(entry[0]); if (entry[1].cardId) this.hashes.delete(entry[1].cardId);
    return true;
  }
  private save(): Promise<void> {
    const work = this.saveTail.then(async () => {
      if (!this.healthy) throw new Error('Inline card journal unavailable.');
      this.storage.check();
      let data = { version: 1, parents: [...this.parents.values()].filter(p => p.expiresAt > Date.now()) };
      while (Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES) {
        if (!this.evictDormant()) throw new Error('Inline card journal quota reached.');
        data = { version: 1, parents: [...this.parents.values()].filter(p => p.expiresAt > Date.now()) };
      }
      await durableJson(path.join(this.storage.path, 'parents.json'), data, this.storage.check);
    }).catch(error => { if (error.message !== 'Inline card journal quota reached.') this.healthy = false; throw error; });
    this.saveTail = work.catch(() => {}); return work;
  }
  private serial<T>(root: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopped || this.tails.size >= 100 && !this.tails.has(root)) return Promise.reject(new Error('Inline card admission closed.'));
    const next = (this.tails.get(root) ?? Promise.resolve()).then(operation, operation);
    this.tails.set(root, next);
    void next.finally(() => { if (this.tails.get(root) === next) this.tails.delete(root); }).catch(() => {});
    return next;
  }
  async admit(owner: InlineOwner, replacePending = false): Promise<void> {
    await this.initialize();
    if (!await this.deps.owns(owner)) return;
    await this.serial(owner.rootId, async () => {
      if (!await this.deps.owns(owner)) return;
      const prior = this.parents.get(owner.messageId);
      if (prior) {
        this.retain(prior);
        if (!same(prior, owner)) {
          if (!replacePending || prior.cardId || prior.base || !same(prior, { ...owner, rootId: prior.rootId })
            || [...this.parents.values()].some(p => p !== prior && (p.rootId === owner.rootId || p.cardId === owner.rootId))) throw new Error('Inline parent identity changed.');
          const rootId = prior.rootId;
          prior.rootId = owner.rootId;
          try { await this.save(); } catch (error) { prior.rootId = rootId; throw error; }
        }
        return;
      }
      for (const [id, p] of this.parents) if (p.expiresAt <= Date.now()) this.parents.delete(id);
      while (this.parents.size >= 100 && this.evictDormant()) { /* Prefer verified file parents over dormant reply bodies. */ }
      if (this.parents.size >= 100 || [...this.parents.values()].some(p => p.rootId === owner.rootId || p.cardId === owner.rootId)) return;
      const p = { ...owner, token: randomBytes(32).toString('hex'), names: [], status: 'unavailable' as const, page: 0, expiresAt: Date.now() + TTL };
      if (!valid(p)) return;
      this.retain(p);
      this.parents.set(owner.messageId, p);
      try { await this.save(); } catch (error) { this.parents.delete(owner.messageId); throw error; }
    });
  }
  rootFor(cardId: string): string | undefined { return [...this.parents.values()].find(p => p.cardId === cardId && p.expiresAt > Date.now())?.rootId; }
  hasRoot(rootId: string): boolean { return [...this.parents.values()].some(p => p.rootId === rootId && p.expiresAt > Date.now()); }
  remember(cardId: string, rootId: string, content: string): void {
    if (!this.hasRoot(rootId)) return;
    try {
      const base = baseCard(content); this.hashes.set(cardId, this.hash(content)); this.bodies.delete(cardId); this.bodies.set(cardId, { rootId, base, at: Date.now() });
      let bytes = [...this.bodies.values()].reduce((sum, v) => sum + Buffer.byteLength(v.base), 0);
      while (bytes > MAX_BYTES || this.bodies.size > 100) {
        const first = this.bodies.entries().next().value!; bytes -= Buffer.byteLength(first[1].base); this.bodies.delete(first[0]); this.hashes.delete(first[0]);
      }
    } catch { /* Missing complete bodies hold inline updates; no guessed replacement. */ }
  }
  async write(cardId: string, rootId: string, content: string, send: (body: string) => Promise<any>): Promise<any> {
    return this.serial(rootId, async () => {
      const p = [...this.parents.values()].find(p => p.cardId === cardId);
      if (p) this.retain(p);
      if (p && p.rootId !== rootId || this.bodies.has(cardId) && this.bodies.get(cardId)!.rootId !== rootId) throw new Error('Inline card ownership changed.');
      if (!p) { const result = await send(content); if (result?.code === 0) this.remember(cardId, rootId, content); return result; }
      if (p.expiresAt <= Date.now() || !await this.deps.owns(p)) throw new Error('Inline card ownership changed.');
      const previous = p.base; p.base = baseCard(content);
      try { await this.save(); } catch (error) { p.base = previous; throw error; }
      const body = this.compose(p);
      if (p.expiresAt <= Date.now() || !await this.deps.owns(p)) throw new Error('Inline card ownership changed.');
      const result = await send(body);
      if (result?.code === 0) { this.remember(cardId, rootId, p.base); this.hashes.set(cardId, this.hash(body)); }
      return result;
    });
  }
  async bind(rootId: string, cardId: string): Promise<void> {
    await this.serial(rootId, async () => {
      const p = [...this.parents.values()].find(p => p.rootId === rootId);
      if (p) this.retain(p);
      const body = this.bodies.get(cardId);
      if (!p || p.expiresAt <= Date.now() || !body || body.rootId !== rootId || body.at < Date.now() - TTL || !await this.deps.owns(p)) return;
      if (p.cardId && p.cardId !== cardId || [...this.parents.values()].some(q => q !== p && (q.cardId === cardId || q.rootId === cardId))) return;
      const previous = { cardId: p.cardId, base: p.base, verified: p.verified };
      p.cardId = cardId; p.base = body.base; p.verified = this.rows(p).length > 0;
      try { await this.save(); } catch { Object.assign(p, previous); return; }
      await this.patch(p);
    });
  }
  async hints(deviceId: string, value: any, status: HintStatus): Promise<void> {
    await this.initialize();
    const p = this.parents.get(value?.messageId);
    if (!p || p.deviceId !== deviceId || p.threadId !== value.threadId || !Number.isSafeInteger(value.generation) || value.generation < 0
      || !Array.isArray(value.names) || !value.names.length || value.names.length > 16
      || value.names.some((n: unknown) => !label(n, 120) || clean(n) !== n || /[\\/]/.test(n as string))) return;
    await this.serial(p.rootId, async () => {
      const generation = p.generation ?? this.rows(p)[0]?.generation;
      if (p.expiresAt <= Date.now() || !await this.deps.owns(p) || generation !== undefined && generation !== value.generation) return;
      p.generation = value.generation; p.names = [...new Set<string>(value.names)]; p.status = status;
      await this.save(); await this.patch(p);
    });
  }
  async refresh(messageId: string): Promise<void> {
    await this.initialize(); const p = this.parents.get(messageId); if (!p) return;
    await this.serial(p.rootId, () => { this.retain(p); return this.patch(p); });
  }
  async allows(identity: InlineIdentity, cardId: string): Promise<boolean> {
    await this.initialize(); const p = this.parents.get(identity.messageId);
    if (!Number.isSafeInteger(identity.generation) || identity.generation! < 0
      || !p || !sameInlineIdentity(p, identity) || p.generation !== identity.generation) return false;
    return this.healthy && p.cardId === cardId && !!p.base && p.expiresAt > Date.now() && await this.deps.owns(p);
  }
  async page(openId: string, cardId: string, action: any): Promise<string> {
    await this.initialize(); const p = [...this.parents.values()].find(p => p.token === action?.id);
    if (!p || p.openId !== openId || p.cardId !== cardId || p.expiresAt <= Date.now() || !Number.isInteger(action.page) || action.page < 0 || action.page >= 30 || !await this.deps.owns(p)) return 'File controls are unavailable.';
    return this.serial(p.rootId, async () => {
      if (p.expiresAt <= Date.now() || !await this.deps.owns(p)) return 'File controls are unavailable.';
      p.page = action.page; await this.save(); await this.patch(p); return 'File list updated.';
    });
  }
  private hash(content: string): string { return createHash('sha256').update(content).digest('hex'); }
  private compose(p: Parent): string {
    const card = JSON.parse(p.base!); const ready = this.rows(p).filter(r => p.generation === undefined || r.generation === p.generation);
    p.generation ??= ready[0]?.generation; p.verified ||= ready.length > 0;
    const names = new Set(ready.map(r => clean(r.name)));
    const statuses = { disabled: 'File retrieval disabled', approval: 'File approval required', upgrade: 'CLI file support required', unavailable: 'Attachment unavailable', ready: 'Attachment not prepared' };
    const status = this.deps.status?.(p) ?? p.status;
    const available = status !== 'disabled' && status !== 'approval';
    const rows: Array<InlineFileRow | { name: string; status: string }> = [...ready.map(r => available ? r : { ...r, op: undefined, status: statuses[status] }), ...p.names.filter(n => !names.has(n)).map(name => ({ name, status: statuses[status] }))];
    if (!rows.length) return p.base!;
    const pageSize = Math.max(1, Math.min(4, Math.floor((180 - nodes(card) - 8) / 4)));
    const pages = Math.ceil(rows.length / pageSize); p.page = Math.min(p.page, pages - 1);
    const elements: any[] = [{ tag: 'markdown', text_size: 'notation', content: `Files · ${p.page + 1}/${pages}` }];
    for (const row of rows.slice(p.page * pageSize, p.page * pageSize + pageSize)) {
      const size = 'size' in row && typeof row.size === 'number' ? ` · ${formatOutputFileSize(row.size)}` : '';
      const expiry = 'expiresAt' in row && typeof row.expiresAt === 'number' ? `\nExpires ${formatOutputExpiry(row.expiresAt)}` : '';
      elements.push({ tag: 'div', text: { tag: 'plain_text', content: `${clean(row.name)}${size} · ${row.status}${expiry}` } });
      const op = 'op' in row ? row.op : undefined;
      elements.push({ tag: 'button', type: op ? 'primary' : 'default', disabled: !op,
        text: { tag: 'plain_text', content: op === 'retry' ? 'Retry' : 'Get file' },
        ...(op && 'id' in row ? { behaviors: [{ type: 'callback', value: { action: 'output_file', id: row.id, op, ...(op === 'retry' ? { rev: row.revision } : {}) } }] } : {}) });
    }
    for (const [name, page] of [['Previous', p.page - 1], ['Next', p.page + 1]] as const) if (page >= 0 && page < pages) {
      elements.push({ tag: 'button', type: 'default', text: { tag: 'plain_text', content: name },
        behaviors: [{ type: 'callback', value: { action: 'output_page', id: p.token, page } }] });
    }
    card.body.elements.push({ tag: 'collapsible_panel', element_id: PANEL, expanded: false,
      header: { title: { tag: 'plain_text', content: `Files (${rows.length})` } }, elements });
    const result = JSON.stringify(card);
    if (nodes(card) > 180 || Buffer.byteLength(result) > 2_900_000) throw new Error('Inline file panel exceeds card capacity.');
    return result;
  }
  private async patch(p: Parent): Promise<void> {
    if (!this.healthy || !p.cardId || !p.base || p.expiresAt <= Date.now() || !await this.deps.owns(p)) return;
    const body = this.compose(p), hash = this.hash(body);
    if (this.hashes.get(p.cardId) === hash || p.display?.hash === hash && (p.display.confirmed || p.display.attempts >= 3)) return;
    p.display = { hash, attempts: p.display?.hash === hash ? p.display.attempts + 1 : 1, confirmed: false };
    await this.save();
    if (!await this.deps.owns(p)) return;
    await this.deps.patch(p.cardId, body); this.hashes.set(p.cardId, hash);
    p.display.confirmed = true; await this.save();
  }
  async destroy(): Promise<void> { this.stopped = true; await Promise.allSettled([...this.tails.values(), this.saveTail]); this.bodies.clear(); }
}

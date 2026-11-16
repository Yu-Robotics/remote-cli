import { createHash, randomUUID } from 'crypto';
import { validateScheduleId } from './ScheduleCommand';

export interface NativeCleanupDefinition {
  id: string; prompt: string; cron: string; recurring?: boolean; durable?: boolean;
  [key: string]: unknown;
}
export interface NativeCleanupSession {
  /** Opaque binding to one process, native session, cwd and configuration epoch. */
  binding: string;
  sessionId: string;
  /** Framework-captured location and retirement proof, never model arguments. */
  cwd?: string;
  retirementConfirmed?(ownerToken?: string): boolean;
  /** Unsettled mutation receipts retain their operational record. */
  mutationPending?(): boolean;
  current(): boolean;
  inventory(): Promise<NativeCleanupDefinition[]>;
  remove(target: NativeCleanupDefinition): Promise<void>;
}
export interface NativeCleanupReview {
  token: string; expiresAt: string; sessionId: string; digest: string;
  candidates: NativeCleanupDefinition[];
  blockedIds: string[];
  warning: string;
}
export const CLEANUP_WARNING = 'Deletion only in this bound native session. Predecessor or already-started work remains unknown; this does not authorize execution recovery. Legacy catalog rows without session attribution remain unchanged. Only session-only definitions (durable: false) are eligible; project-persisted definitions lack session attribution in native inventory.';
export function cleanupCanonical(value: unknown): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}
/** CronList advances this forecast after a timer fires, even when admission is
 * denied. Preserve it in the review, but compare every actual definition field. */
function inventoryIdentity(entries: NativeCleanupDefinition[]): string {
  return cleanupCanonical(entries.map(({ nextFireAt: _forecast, ...definition }) => definition));
}
export function cleanupInventory(value: unknown): NativeCleanupDefinition[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'jobs')) {
    throw new Error('Complete structured native inventory is unavailable.');
  }
  const jobs = (value as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs) || jobs.length > 100 || Buffer.byteLength(JSON.stringify(jobs)) > 1024 * 1024) {
    throw new Error('Complete structured native inventory is unavailable or exceeds the review limit.');
  }
  for (const job of jobs) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error('Invalid native definition.');
    validateScheduleId(job.id);
    if (typeof job.prompt !== 'string' || !job.prompt || job.prompt.includes('\0') || Buffer.byteLength(job.prompt) > 16384
      || typeof job.cron !== 'string' || !job.cron || job.cron.length > 256
      || ('durable' in job && typeof job.durable !== 'boolean')
      || ('nextFireAt' in job && (typeof job.nextFireAt !== 'number' || !Number.isFinite(job.nextFireAt)))
      || ('recurring' in job && typeof job.recurring !== 'boolean')) {
      throw new Error('Invalid native definition fields.');
    }
  }
  if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error('Ambiguous native definition IDs.');
  return structuredClone(jobs).sort((a, b) => a.id.localeCompare(b.id));
}
interface Review {
  scope: string; binding: string; sessionId: string; expires: number;
  inventory: NativeCleanupDefinition[]; candidates: NativeCleanupDefinition[];
  attempted: Set<string>; absent: Set<string>; selection?: string; requestId?: string;
}
/** Ephemeral owner authorization, deliberately not an execution or recovery receipt. */
export class ReviewedNativeCleanup {
  private reviews = new Map<string, Review>();
  private requests = new Map<string, { digest: string; token: string }>();
  constructor(private readonly now = Date.now, private readonly ttl = 5 * 60_000) {}
  private check(host: NativeCleanupSession, review?: Review, scope?: string): void {
    if (!host.current() || review && (review.expires <= this.now() || review.scope !== scope
      || review.binding !== host.binding || review.sessionId !== host.sessionId)) {
      throw new Error('Cleanup review expired or owner/session/host changed. Run /schedule cleanup review again.');
    }
  }
  async prepare(scope: string, requestId: string, host: NativeCleanupSession, ids?: string[]): Promise<NativeCleanupReview> {
    this.check(host);
    validateScheduleId(requestId);
    ids?.forEach(validateScheduleId);
    for (const [token, review] of this.reviews) if (review.expires <= this.now()) this.reviews.delete(token);
    for (const [key, value] of this.requests) if (!this.reviews.has(value.token)) this.requests.delete(key);
    const key = cleanupCanonical([scope, requestId]);
    const digest = cleanupCanonical(ids?.slice().sort() ?? []);
    const previous = this.requests.get(key);
    if (previous && previous.digest !== digest) throw new Error('Cleanup requestId was reused with different arguments.');
    const inventory = await host.inventory(); this.check(host);
    if (previous) {
      const review = this.reviews.get(previous.token)!; this.check(host, review, scope);
      if (inventoryIdentity(review.inventory) !== inventoryIdentity(inventory)) throw new Error('Native inventory changed. Request a new cleanup review.');
      return this.public(previous.token, review);
    }
    if (this.reviews.size >= 100) throw new Error('Cleanup review capacity reached. Let old reviews expire.');
    if (ids && (new Set(ids).size !== ids.length || ids.some(id => !inventory.some(entry => entry.id === id)))) {
      throw new Error('Selected native ID is not in the bound session inventory. Review this session; no other sessions are searched.');
    }
    const candidates = ids?.length ? inventory.filter(entry => ids.includes(entry.id)) : inventory;
    if (Buffer.byteLength(JSON.stringify(candidates)) > 40000) {
      throw new Error(`Inventory is too large to display completely. Use /schedule cleanup review <native-id,...>. Available IDs: ${inventory.map(entry => entry.id).join(',')}`);
    }
    const token = randomUUID();
    const review: Review = { scope, binding: host.binding, sessionId: host.sessionId, expires: this.now() + this.ttl,
      inventory, candidates, attempted: new Set(), absent: new Set() };
    this.reviews.set(token, review); this.requests.set(key, { digest, token });
    return this.public(token, review);
  }
  private public(token: string, review: Review): NativeCleanupReview {
    return { token, expiresAt: new Date(review.expires).toISOString(), sessionId: review.sessionId,
      digest: createHash('sha256').update(inventoryIdentity(review.inventory)).digest('hex'),
      candidates: structuredClone(review.candidates),
      blockedIds: review.candidates.filter(entry => entry.durable !== false).map(entry => entry.id), warning: CLEANUP_WARNING };
  }
  async confirm(scope: string, requestId: string, token: string, ids: string[], host: NativeCleanupSession,
    observe?: (targets: NativeCleanupDefinition[], absent: boolean) => Promise<void>): Promise<{ absentIds: string[]; warning: string }> {
    const review = this.reviews.get(token);
    if (!review) throw new Error('Unknown cleanup review. Run /schedule cleanup review in the bound session.');
    this.check(host, review, scope); validateScheduleId(requestId); ids.forEach(validateScheduleId);
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !review.candidates.some(entry => entry.id === id))) {
      throw new Error('Confirm exact native IDs from the reviewed candidates; no wildcard deletion is allowed.');
    }
    if (review.candidates.some(entry => ids.includes(entry.id) && entry.durable !== false)) {
      throw new Error('Selected project-persisted native definitions lack session attribution. Only durable: false definitions can be deleted through this bound-session cleanup.');
    }
    const selection = cleanupCanonical(ids.slice().sort());
    if (review.selection && (review.selection !== selection || review.requestId !== requestId)) {
      throw new Error('Confirmation already started. Retry the same token, requestId and selected IDs.');
    }
    review.selection = selection; review.requestId = requestId;
    const targets = review.candidates.filter(entry => ids.includes(entry.id));
    const inspect = async () => {
      this.check(host, review, scope);
      const entries = await host.inventory(); this.check(host, review, scope);
      const expected = review.inventory.filter(entry => !review.absent.has(entry.id) && (!review.attempted.has(entry.id) || entries.some(current => current.id === entry.id)));
      if (inventoryIdentity(entries) !== inventoryIdentity(expected)) {
        throw new Error('Native inventory changed since review. No further deletion is authorized; request a new review.');
      }
      return entries;
    };
    await inspect();
    await observe?.(targets, false); this.check(host, review, scope);
    for (const target of targets) {
      const entries = await inspect();
      if (!entries.some(entry => entry.id === target.id)) { review.absent.add(target.id); continue; }
      review.attempted.add(target.id);
      try { await host.remove(target); }
      catch (error) {
        // Only authoritative fresh absence can reconcile an error-after-commit.
        if ((await inspect()).some(entry => entry.id === target.id)) throw error;
      }
      if ((await inspect()).some(entry => entry.id === target.id)) throw new Error('Native deletion is not confirmed. Retry this exact confirmation.');
      review.absent.add(target.id);
    }
    if ((await inspect()).some(entry => ids.includes(entry.id))) throw new Error('Native absence is not confirmed.');
    await observe?.(targets, true); this.check(host, review, scope);
    return { absentIds: ids.slice().sort(), warning: CLEANUP_WARNING };
  }
}

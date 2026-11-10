import type { SnapshotContext } from './OutputSnapshots';
import { OutputLinks } from './OutputLinks';
import { OutputFiles } from './OutputFiles';
import { OUTPUT_LIMITS } from './Protocol';

interface Intent { paths: string[]; context: SnapshotContext; expires: number; current(): boolean }

/** Process-local metadata only. Losing this map must never trigger path reconstruction or basename search. */
export class PendingOutputFiles {
  private revisions = new Map<string, object>();
  private intents = new Map<string, Intent>();
  invalidateThread(threadId: string): void {
    this.revisions.delete(threadId);
    for (const [id, intent] of this.intents) if (intent.context.threadId === threadId) this.intents.delete(id);
  }
  remember(links: OutputLinks, context: SnapshotContext, current: () => boolean): void {
    for (const [id, intent] of this.intents) if (intent.expires <= Date.now() || !intent.current()) this.intents.delete(id);
    const parsed = links.finish(undefined, 'attachments');
    if (!context.owner || !current() || !parsed.paths.length || this.intents.size >= 100 && !this.intents.has(context.messageId)) return;
    const copy = { ...context, omitted: parsed.omitted, exports: context.exports?.map(entry => ({ ...entry })) };
    // Bound metadata independently of byte/snapshot quotas. No filesystem APIs are used here.
    if (Buffer.byteLength(JSON.stringify({ paths: parsed.paths, context: copy })) > 64 * 1024) return;
    const existing = this.intents.get(context.messageId);
    if (existing) {
      if (existing.context.owner !== copy.owner || existing.context.threadId !== copy.threadId
        || existing.context.generation !== copy.generation || existing.context.cwd !== copy.cwd) return;
      const combined = [...new Set([...existing.paths, ...parsed.paths])];
      if (combined.length > OUTPUT_LIMITS.candidates
        || Buffer.byteLength(JSON.stringify({ paths: combined, context: copy })) > 64 * 1024) return;
      existing.paths = combined;
      existing.context.exports = copy.exports;
      existing.context.omitted ||= parsed.omitted;
      return;
    }
    // Tokens are bounded as well as intents. Eviction invalidates any older in-flight work.
    while (this.revisions.size >= 100) this.revisions.delete(this.revisions.keys().next().value!);
    const revision = {};
    this.revisions.set(context.threadId, revision);
    this.intents.set(context.messageId, { paths: [...parsed.paths], context: copy,
      current: () => this.revisions.get(context.threadId) === revision && current(), expires: Date.now() + OUTPUT_LIMITS.ttl });
  }
  async prepare(request: any, files: OutputFiles | undefined): Promise<boolean> {
    const intent = this.intents.get(request?.messageId);
    if (!intent || !files?.canPrepare() || intent.expires <= Date.now() || !intent.current()
      || request.openId !== intent.context.owner || request.threadId !== intent.context.threadId
      || request.generation !== intent.context.generation) return false;
    // Consume before any await: repeated requests cannot capture changing bytes twice.
    this.intents.delete(request.messageId);
    const connected = files.preparationLease();
    const current = () => connected() && intent.expires > Date.now() && intent.current();
    const result = await files.capturePaths(intent.paths, { ...intent.context, expiresAt: intent.expires, current });
    return result.unavailable === 0;
  }
  clear(): void {
    this.revisions.clear();
    this.intents.clear();
  }
}

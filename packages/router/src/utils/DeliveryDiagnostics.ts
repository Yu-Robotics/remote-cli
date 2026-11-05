import { createHash, createHmac, randomBytes } from 'crypto';

/** Shared with the CLI: only hash the existing opaque task identifier, never content. */
export function taskCorrelation(id: unknown): string | undefined {
  try {
    return typeof id === 'string' && id.length <= 512
      ? createHash('sha256').update('remote-cli-task-v1:').update(id).digest('hex').slice(0, 24) : undefined;
  } catch { return undefined; }
}

/** Callers supply fixed event names and allowlisted metadata, never arbitrary error objects. */
export function deliveryEvent(event: string, fields: Record<string, unknown> = {}): void {
  try { console.info('[DeliveryDiagnostics]', { event, ...fields }); } catch { /* Diagnostics cannot fail delivery. */ }
}

export function safeCardError(error: any): { httpStatus?: number; apiCode?: number; subCode?: number; traceId?: string; category?: string } {
  try {
    const detail = error?.response?.data ?? error;
    const numeric = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
    const trace = [detail?.error?.log_id, detail?.log_id, error?.error?.log_id, error?.log_id]
      .find(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value));
    const category = ['AxiosError', 'TypeError', 'SyntaxError', 'Error'].includes(error?.name) ? error.name
      : ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE'].includes(error?.code) ? error.code : undefined;
    return {
      category, httpStatus: numeric(error?.response?.status), apiCode: numeric(detail?.code),
      subCode: typeof detail?.msg === 'string' ? Number(/ErrCode:\s*(\d{1,9})\b/.exec(detail.msg)?.[1]) || undefined : undefined,
      traceId: trace,
    };
  } catch { return {}; }
}

/** SDK logging runs before our catch; do not let it print Axios config.data or response bodies. */
export function safeSdkLogger() {
  let count = 0;
  let last = -Infinity;
  const error = (...args: unknown[]) => {
    try {
      count++;
      if (Date.now() - last < 30_000) return;
      let candidate: unknown = args;
      for (let depth = 0; depth < 4 && Array.isArray(candidate); depth++) candidate = candidate[0];
      deliveryEvent('sdk_error', { ...safeCardError(candidate), count });
      count = 0; last = Date.now();
    } catch { /* The SDK's diagnostic callback must never throw. */ }
  };
  return { error, warn: error, info: () => {}, debug: () => {}, trace: () => {} };
}

export interface CardDiagnosticContext {
  operation: 'create' | 'update' | 'finalize' | 'tail-clear' | 'controls';
  taskId?: string;
  cardId?: string;
  rootId?: string;
  index?: number;
}
interface Component {
  path: string; type: string; jsonUtf8Bytes: number; structure: string; fingerprint: string;
}
interface Manifest {
  utf8Bytes: number; utf16Units: number; fingerprint?: string; schema: string;
  components: Component[]; taggedNodes: number; maxDepth: number; truncated: boolean;
  tags: Record<string, number>; fontTags: number; fences: number; diffLines: number;
  copyableDiffPreviews: number; markdownTableRows: number;
}
interface CardState {
  touched: number; success?: Manifest; successAt?: number; successSequence?: number;
  failure?: { signature: string; count: number; firstAt: number; lastAt: number; firstSequence: number; lastSequence: number; emittedAt: number; traceId?: string };
  skips: number;
}
const TAGS = new Set(['markdown', 'plain_text', 'collapsible_panel', 'column_set', 'column', 'button',
  'hr', 'div', 'table', 'img', 'form', 'action', 'note', 'standard_icon', 'select_static', 'input']);
const KEYS = new Set(['schema', 'tag', 'body', 'elements', 'columns', 'text', 'content', 'header', 'title',
  'icon', 'behaviors', 'value', 'type', 'expanded', 'disabled', 'color', 'text_size', 'padding']);

/** Bounded metadata only; no payload, source text, filename, URL or raw identifier is retained. */
export class CardDeliveryDiagnostics {
  private readonly key: Buffer | undefined;
  private sequence = 0;
  private detailedInFlight = 0;
  private readonly cards = new Map<string, CardState>();
  private readonly bindings = new Map<string, { task: string; touched: number }>();
  constructor() { try { this.key = randomBytes(32); } catch { /* Disable fingerprints if entropy is unavailable. */ } }

  bind(cardId: string, taskId: string): void {
    try {
      this.expire();
      const card = taskCorrelation(cardId), task = taskCorrelation(taskId);
      if (!card || !task) return;
      const unchanged = this.bindings.get(card)?.task === task;
      this.bindings.delete(card); this.bindings.set(card, { task, touched: Date.now() });
      if (this.bindings.size > 64) this.bindings.delete(this.bindings.keys().next().value!);
      if (!unchanged) deliveryEvent('card_task_bound', { card, task });
    } catch { /* Metadata is optional. */ }
  }

  private fingerprint(text: string): string {
    return this.key ? createHmac('sha256', this.key).update(text).digest('hex').slice(0, 24) : 'unavailable';
  }

  private manifest(content: string, detailed = true): Manifest {
    const result: Manifest = { utf8Bytes: Buffer.byteLength(content, 'utf8'), utf16Units: content.length,
      schema: 'unknown', components: [], taggedNodes: 0, maxDepth: 0, truncated: false,
      tags: {}, fontTags: 0, fences: 0, diffLines: 0, copyableDiffPreviews: 0, markdownTableRows: 0 };
    // Byte counting is linear in the already-created request. Parsing/hashing has a strict input cap.
    if (!detailed || content.length > 4 * 1024 * 1024) { result.truncated = true; return result; }
    result.fingerprint = this.fingerprint(content);
    const root = JSON.parse(content);
    result.schema = root?.schema === '2.0' ? '2.0' : root?.schema === '1.0' || root?.schema === undefined ? 'legacy' : 'unknown';
    let visited = 0;
    const walk = (value: any, location: string, depth: number): { bytes: number; shape: string; digest: string } => {
      if (++visited > 4096 || depth > 32) {
        result.truncated = true;
        return { bytes: 0, shape: 'truncated', digest: 'truncated' };
      }
      result.maxDepth = Math.max(result.maxDepth, depth);
      if (value === null || typeof value !== 'object') {
        const serialized = JSON.stringify(value);
        return { bytes: Buffer.byteLength(serialized), shape: typeof value, digest: this.fingerprint(serialized) };
      }
      const array = Array.isArray(value);
      const entries = Object.keys(value);
      const shape: string[] = [array ? 'array' : 'object'];
      const digests: string[] = [];
      let bytes = 2;
      const count = Math.min(entries.length, 4096 - visited);
      if (count < entries.length) result.truncated = true;
      for (let i = 0; i < count; i++) {
        const key = entries[i];
        const child = walk(value[key], `${location}.${i}`, depth + 1);
        bytes += (i ? 1 : 0) + child.bytes + (array ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1);
        shape.push(array ? child.shape : `${KEYS.has(key) ? key : 'other'}:${child.shape}`);
        digests.push(this.fingerprint(key), child.digest);
        if (visited >= 4096) { if (i + 1 < entries.length) result.truncated = true; break; }
      }
      if (typeof value.tag === 'string') {
        const type = TAGS.has(value.tag) ? value.tag : 'other';
        result.taggedNodes++; result.tags[type] = (result.tags[type] ?? 0) + 1;
        shape.push(type);
        if (type === 'markdown' && typeof value.content === 'string') {
          const text = value.content;
          result.fontTags += (text.match(/<font\b/gi) ?? []).length;
          result.fences += (text.match(/^[ \t]*`{3,}/gm) ?? []).length;
          result.diffLines += (text.match(/^(?:[+-]|@@|diff --git )/gm) ?? []).length;
          result.markdownTableRows += (text.match(/^[ \t]*\|[^\r\n]*\|[ \t]*\r?$/gm) ?? []).length;
          if (text.startsWith('**Copyable diff preview')) result.copyableDiffPreviews++;
        }
      }
      const structure = createHash('sha256').update(shape.join('|')).digest('hex').slice(0, 24);
      const fingerprint = this.fingerprint(digests.join('|'));
      if (typeof value.tag === 'string') {
        if (result.components.length < 256) result.components.push({ path: location,
          type: TAGS.has(value.tag) ? value.tag : 'other', jsonUtf8Bytes: bytes, structure, fingerprint });
        else result.truncated = true;
      }
      return { bytes, shape: structure, digest: fingerprint };
    };
    walk(root, '0', 0);
    return result;
  }

  private summary(manifest?: Manifest) {
    if (!manifest) return undefined;
    const { components, ...summary } = manifest;
    return { ...summary, largestBlocks: [...components].sort((a, b) => b.jsonUtf8Bytes - a.jsonUtf8Bytes).slice(0, 3) };
  }

  private flush(key: string, state: CardState): void {
    if (state.failure?.count) deliveryEvent('card_failure_summary', { card: key, ...state.failure });
    if (state.skips) deliveryEvent('card_hash_skips', { card: key, count: state.skips });
    state.skips = 0;
    if (state.failure) state.failure.count = 0;
  }

  private expire(): void {
    const now = Date.now();
    for (const [key, state] of this.cards) if (now - state.touched > 30 * 60_000) {
      this.flush(key, state); this.cards.delete(key);
    }
    for (const [key, value] of this.bindings) if (now - value.touched > 30 * 60_000) this.bindings.delete(key);
  }

  private state(context: CardDiagnosticContext) {
    this.expire();
    const card = taskCorrelation(context.cardId);
    const root = taskCorrelation(context.rootId);
    const task = taskCorrelation(context.taskId) ?? (card ? this.bindings.get(card)?.task : undefined)
      ?? (root ? this.bindings.get(root)?.task : undefined);
    for (const id of [card, root]) {
      const binding = id && this.bindings.get(id);
      if (binding) binding.touched = Date.now();
    }
    const key = card ?? `${task ?? 'unbound'}:${context.index ?? 0}`;
    let state = this.cards.get(key);
    if (!state) {
      if (this.cards.size >= 64) {
        const oldest = this.cards.entries().next().value!;
        this.flush(...oldest); this.cards.delete(oldest[0]);
      }
      state = { touched: Date.now(), skips: 0 }; this.cards.set(key, state);
    }
    state.touched = Date.now();
    return { key, task, state };
  }

  skip(context: CardDiagnosticContext): void {
    try {
      const { key, task, state } = this.state(context);
      state.skips++;
      if (state.skips === 1) deliveryEvent('card_hash_skip', { card: key, task, operation: context.operation });
    } catch { /* Never affect the existing hash decision. */ }
  }

  async deliver<T>(context: CardDiagnosticContext, content: string, send: () => Promise<T>): Promise<T> {
    const sequence = ++this.sequence, started = Date.now();
    let manifest: Manifest | undefined;
    const detailed = this.detailedInFlight < 64;
    if (detailed) this.detailedInFlight++;
    try { manifest = this.manifest(content, detailed); } catch { /* Invalid or oversized diagnostic input cannot block sending. */ }
    try {
      const { key, task, state } = this.state(context);
      // Repeated failed attempts are summarized below; do not emit a payload manifest per retry.
      if (!state.failure || Date.now() - state.failure.emittedAt >= 30_000) {
        deliveryEvent('card_attempt', { sequence, card: key, task, operation: context.operation, index: context.index,
          utf8Bytes: manifest?.utf8Bytes, utf16Units: manifest?.utf16Units, schema: manifest?.schema });
      }
    } catch { /* Diagnostics cannot prevent the request. */ }
    const outcome = (value: unknown, rejected: boolean) => {
      try {
        const error = safeCardError(value);
        const status = rejected || (error.apiCode !== undefined && error.apiCode !== 0) ? 'failure'
          : error.apiCode === 0 ? 'success' : 'unknown';
        // A created message gets its own history immediately, rather than sharing an anonymous slot.
        const created = context.operation === 'create' && (value as any)?.data?.message_id;
        if (typeof created === 'string' && context.taskId) this.bind(created, context.taskId);
        const { key, task, state } = this.state(typeof created === 'string' ? { ...context, cardId: created } : context);
        const fields = { sequence, card: key, task, operation: context.operation, index: context.index,
          status, elapsedMs: Math.max(0, Date.now() - started), ...error, payload: this.summary(manifest) };
        if (status === 'failure') {
          const signature = `${context.operation}:${error.httpStatus}:${error.apiCode}:${error.subCode}:${error.category}`;
          const previous = state.failure;
          if (previous?.signature === signature) {
            previous.count++; previous.lastAt = Date.now(); previous.lastSequence = sequence; previous.traceId = error.traceId;
            if (Date.now() - previous.emittedAt >= 30_000) {
              this.flush(key, state); previous.emittedAt = Date.now();
            }
            return;
          }
          this.flush(key, state);
          state.failure = { signature, count: 1, firstAt: Date.now(), lastAt: Date.now(), firstSequence: sequence, lastSequence: sequence, emittedAt: Date.now(), traceId: error.traceId };
          const before = new Map(state.success?.components.map(c => [c.path, c]) ?? []);
          const changed = (manifest?.components ?? []).filter(c => before.get(c.path)?.fingerprint !== c.fingerprint);
          const after = new Set(manifest?.components.map(c => c.path) ?? []);
          changed.push(...(state.success?.components.filter(c => !after.has(c.path)) ?? []));
          deliveryEvent('card_delivery', { ...fields, lastSuccess: this.summary(state.success), lastSuccessAt: state.successAt, lastSuccessSequence: state.successSequence,
            changedComponents: changed.sort((a, b) => b.jsonUtf8Bytes - a.jsonUtf8Bytes).slice(0, 8), changedCount: changed.length });
        } else {
          this.flush(key, state); state.failure = undefined;
          if (status === 'success') { state.success = manifest; state.successAt = Date.now(); state.successSequence = sequence; }
          deliveryEvent('card_delivery', fields);
        }
      } catch { /* Never turn successful API delivery into a failure. */ }
    };
    try { const result = await send(); outcome(result, false); return result; }
    catch (error) { outcome(error, true); throw error; }
    finally { if (detailed) this.detailedInFlight--; }
  }

  close(): void {
    try { for (const [key, state] of this.cards) this.flush(key, state); this.cards.clear(); this.bindings.clear(); } catch { /* Best effort. */ }
  }
}

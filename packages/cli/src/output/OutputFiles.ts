import http from 'http';
import https from 'https';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { fileOrigin } from '../files/DeviceIdentity';
import { OutputLinks } from './OutputLinks';
import { OutputSnapshots, SnapshotContext } from './OutputSnapshots';
import { OPAQUE_ID, OUTPUT_LIMITS } from './Protocol';

/** Discovery and HTTP upload never invoke an executor or consume a model turn. */
export class OutputFiles {
  private origin: string;
  private connected = false;
  private acknowledged = new Set<string>();
  private active = new Map<string, AbortController>();
  private tasks = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  constructor(readonly snapshots: OutputSnapshots, serverUrl: string, private send: (message: object) => unknown) {
    this.origin = fileOrigin(serverUrl);
  }
  async initialize(): Promise<void> { await this.snapshots.initialize(); }
  connect(): void {
    this.connected = true; this.acknowledged.clear(); this.advertise();
    clearInterval(this.timer); this.timer = setInterval(() => this.advertise(), 15_000); this.timer.unref();
  }
  disconnect(): void {
    this.connected = false; clearInterval(this.timer);
    for (const controller of this.active.values()) controller.abort();
  }
  private advertise(): void {
    if (!this.connected) return;
    const references = this.snapshots.references();
    const live = new Set(references.map(reference => reference.id));
    for (const id of this.acknowledged) if (!live.has(id)) this.acknowledged.delete(id);
    for (const reference of references) if (!this.acknowledged.has(reference.id)) {
      try { this.send({ type: 'output_offer', reference }); } catch { /* Re-offer after reconnect. */ }
    }
  }
  async capture(links: OutputLinks, context: SnapshotContext, final?: string): Promise<{ unavailable: number; omitted: boolean }> {
    const parsed = links.finish(final); let unavailable = 0;
    for (const candidate of parsed.paths) {
      try { await this.snapshots.snapshot(candidate, { ...context, omitted: parsed.omitted }); } catch { unavailable++; }
    }
    if (context.source !== 'worker') this.advertise();
    if (context.source !== 'worker' && this.connected && (unavailable || parsed.omitted)) {
      try { this.send({ type: 'output_discovery', messageId: context.messageId, taskId: context.taskId,
        unavailable, omitted: parsed.omitted }); } catch { /* Discovery notices never alter the assistant response. */ }
    }
    return { unavailable, omitted: parsed.omitted };
  }
  handle(message: any): void {
    if (message.type === 'output_registered' && OPAQUE_ID.test(message.id)) {
      if (this.snapshots.references().some(ref => ref.id === message.id)) this.acknowledged.add(message.id);
      return;
    }
    if (message.type !== 'output_grant' || !this.connected || !OPAQUE_ID.test(message.id) || !OPAQUE_ID.test(message.transferId)
      || !this.snapshots.references().some(ref => ref.id === message.id)
      || !/^[a-f0-9]{64}$/.test(message.token) || !Number.isSafeInteger(message.expiresAt)
      || message.expiresAt <= Date.now() || message.expiresAt > Date.now() + OUTPUT_LIMITS.transfer + 5000
      || this.active.size || this.active.has(message.transferId)) return;
    const controller = new AbortController(); this.active.set(message.transferId, controller);
    const task = this.upload(message, controller).catch(() => {
      try { this.send({ type: 'output_transfer_failed', transferId: message.transferId }); } catch { /* Router expires grants. */ }
    }).finally(() => { this.active.delete(message.transferId); this.tasks.delete(task); });
    this.tasks.add(task);
  }
  private async upload(message: any, controller: AbortController): Promise<void> {
    const timer = setTimeout(() => controller.abort(), Math.min(OUTPUT_LIMITS.transfer, message.expiresAt - Date.now())); timer.unref();
    try {
      await this.snapshots.read(message.id, async (source, reference) => {
        const url = new URL(`/api/output-files/${message.transferId}`, this.origin);
        const request = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', signal: controller.signal,
          headers: { authorization: `Bearer ${message.token}`, 'content-type': 'application/octet-stream', 'content-length': reference.size } });
        const response = new Promise<void>((resolve, reject) => {
          request.on('error', reject);
          request.once('response', incoming => {
            incoming.resume();
            incoming.once('end', () => incoming.statusCode === 204 ? resolve() : reject(new Error('Output upload rejected.')));
            incoming.once('error', reject);
          });
        });
        request.setTimeout(OUTPUT_LIMITS.idle, () => request.destroy(new Error('Output upload stalled.')));
        await Promise.all([pipeline(Readable.from(source), request, { signal: controller.signal }), response]);
      });
    } finally { clearTimeout(timer); }
  }
  async destroy(): Promise<void> { this.disconnect(); await Promise.allSettled([...this.tasks]); await this.snapshots.destroy(); }
}

/** Fixed public-ingress budgets, independent of client-supplied forwarding headers. */
export const INGRESS_LIMITS = Object.freeze({
  payloadBytes: 16 * 1024 * 1024,
  preauthBytes: 16 * 1024,
  registrationMs: 30_000,
  pending: 512,
  pendingPerPeer: 64,
  connectionsPerMinute: 4096,
  connectionsPerPeerMinute: 256,
  preauthFrames: 64,
  preauthFramesPerSecond: 16,
  bindingWindowMs: 5 * 60_000,
  bindings: 4096,
  bindingsPerPeer: 128,
  bindingsPerDevice: 3,
  rateKeys: 8192,
});

export class IngressLimitError extends Error {
  readonly status = 429;
  readonly retryAfter = 300;
  constructor() { super('Public ingress capacity exceeded. Retry later.'); }
}

/** Never evict live counters: key churn must not reset a consumed budget. */
class WindowBudget {
  private readonly entries = new Map<string, { count: number; until: number }>();
  take(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    for (const [name, entry] of this.entries) if (entry.until <= now) this.entries.delete(name);
    const entry = this.entries.get(key);
    if (entry) {
      if (entry.count >= limit) return false;
      entry.count++;
    } else {
      if (this.entries.size >= INGRESS_LIMITS.rateKeys) return false;
      this.entries.set(key, { count: 1, until: now + windowMs });
    }
    return true;
  }
}

export interface PendingAdmission {
  active(): boolean;
  receive(bytes: number): boolean;
  release(): void;
}

export class IngressAdmission {
  private readonly rates = new WindowBudget();
  private readonly peers = new Map<string, number>();
  private pending = 0;

  admit(peer: string): PendingAdmission | undefined {
    const l = INGRESS_LIMITS;
    if (this.pending >= l.pending || (this.peers.get(peer) ?? 0) >= l.pendingPerPeer
      || !this.rates.take(`connection:${peer}`, l.connectionsPerPeerMinute, 60_000)
      || !this.rates.take('connections', l.connectionsPerMinute, 60_000)) return;
    this.pending++;
    this.peers.set(peer, (this.peers.get(peer) ?? 0) + 1);
    const deadline = Date.now() + l.registrationMs;
    let released = false;
    let count = 0;
    let second = Date.now();
    let perSecond = 0;
    return {
      active: () => !released && Date.now() < deadline,
      receive: bytes => {
        if (released || Date.now() >= deadline || bytes > l.preauthBytes || ++count > l.preauthFrames) return false;
        if (Date.now() - second >= 1000) { second = Date.now(); perSecond = 0; }
        return ++perSecond <= l.preauthFramesPerSecond;
      },
      release: () => {
        if (released) return;
        released = true;
        this.pending--;
        const left = (this.peers.get(peer) ?? 1) - 1;
        if (left) this.peers.set(peer, left); else this.peers.delete(peer);
      },
    };
  }

  bindingPeer(peer: string): boolean {
    return this.rates.take(`binding:${peer}`, INGRESS_LIMITS.bindingsPerPeer, INGRESS_LIMITS.bindingWindowMs)
      && this.rates.take('bindings', INGRESS_LIMITS.bindings, INGRESS_LIMITS.bindingWindowMs);
  }

  bindingDevice(device: string): boolean {
    return this.rates.take(`device:${device}`, INGRESS_LIMITS.bindingsPerDevice, INGRESS_LIMITS.bindingWindowMs);
  }
}

/** Count wire frames using only the public TCP stream; never retain payload bytes.
 * ws remains the protocol validator and owns fragmented-message assembly limits.
 */
export class PendingFrameBudget {
  private readonly header = Buffer.alloc(14);
  private headerBytes = 0;
  private headerLength = 2;
  private remaining = 0;
  private assembled = 0;
  constructor(private readonly take: (bytes: number) => boolean) {}

  receive(chunk: Buffer): boolean {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remaining) {
        const skip = Math.min(this.remaining, chunk.length - offset);
        offset += skip; this.remaining -= skip;
        continue;
      }
      const needed = this.headerLength - this.headerBytes;
      const copied = Math.min(needed, chunk.length - offset);
      chunk.copy(this.header, this.headerBytes, offset, offset + copied);
      offset += copied; this.headerBytes += copied;
      if (this.headerBytes < this.headerLength) continue;
      if (this.headerLength === 2) {
        const marker = this.header[1] & 127;
        this.headerLength = 2 + (marker === 126 ? 2 : marker === 127 ? 8 : 0) + (this.header[1] & 128 ? 4 : 0);
        if (this.headerBytes < this.headerLength) continue;
      }
      const marker = this.header[1] & 127;
      const length = marker === 127 ? this.header.readBigUInt64BE(2)
        : BigInt(marker === 126 ? this.header.readUInt16BE(2) : marker);
      if (length > BigInt(INGRESS_LIMITS.preauthBytes) || !this.take(Number(length))) return false;
      if ((this.header[0] & 15) <= 2) {
        this.assembled += Number(length);
        if (this.assembled > INGRESS_LIMITS.preauthBytes) return false;
        if (this.header[0] & 128) this.assembled = 0;
      }
      this.remaining = Number(length);
      this.headerBytes = 0; this.headerLength = 2;
    }
    return true;
  }
}

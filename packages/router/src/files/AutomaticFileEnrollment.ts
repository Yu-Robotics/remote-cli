import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { BindingManager } from '../binding/BindingManager';
import { DeviceAuth } from './DeviceAuth';
import { privateDirectory, readPrivateJson } from './FileIO';
import { durableJson } from '../output/Durable';

interface Request {
  id: string; deviceId: string; openId: string; epoch: string; publicKey: string;
  explicit?: boolean; expires: number; uuid: string; state: 'intent' | 'known' | 'uncertain' | 'approved' | 'conflict'; cardId?: string;
}
interface Dependencies {
  bindings: BindingManager; auth: DeviceAuth;
  create: (openId: string, content: string, uuid: string) => Promise<string>;
  approve: (openId: string, deviceId: string, publicKey: string) => Promise<void>;
}

export interface EnrollmentAuthority { readonly openId: string; readonly epoch: string }

/** Pending requests never authenticate a device. Only the exact owner's card can enroll its key. */
export class AutomaticFileEnrollment {
  private records: Request[] = [];
  private loading?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private healthy = true;
  private stopped = false;
  private admitted = 0;
  constructor(private readonly filename: string, private readonly deps: Dependencies) {}

  private async ready(): Promise<void> {
    await (this.loading ??= (async () => {
      await privateDirectory(path.dirname(this.filename));
      try {
        const value = await readPrivateJson(this.filename);
        if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid enrollment requests.');
        const ids = new Set<string>();
        for (const item of value) {
          if (!item || !/^[a-f0-9]{64}$/.test(item.id) || ids.has(item.id)
            || typeof item.deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(item.deviceId)
            || typeof item.openId !== 'string' || !item.openId || item.openId.length > 200
            || typeof item.epoch !== 'string' || !item.epoch || item.epoch.length > 100
            || !DeviceAuth.validKey(item.publicKey) || !Number.isSafeInteger(item.expires)
            || typeof item.uuid !== 'string' || !/^[a-f0-9-]{36}$/.test(item.uuid)
            || (item.explicit !== undefined && item.explicit !== true)
            || !['intent', 'known', 'uncertain', 'approved', 'conflict'].includes(item.state)
            || (item.cardId !== undefined && (typeof item.cardId !== 'string' || !item.cardId || item.cardId.length > 200))
            || (item.state === 'known' && !item.cardId)) throw new Error('Invalid enrollment request.');
          ids.add(item.id);
        }
        // A crash after admitting a create cannot establish that no card was sent.
        this.records = value.map(item => ({ ...item, state: item.state === 'intent' ? 'uncertain' : item.state }));
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    })());
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped || this.admitted >= 64) return Promise.reject(new Error('Automatic enrollment is unavailable.'));
    this.admitted++;
    const result = this.tail.then(async () => {
      if (this.stopped || !this.healthy) throw new Error('Automatic enrollment is unavailable.');
      await this.ready();
      return operation();
    }).finally(() => { this.admitted--; });
    this.tail = result.catch(() => {});
    return result;
  }

  private async save(): Promise<void> {
    try { await durableJson(this.filename, this.records); }
    catch { this.healthy = false; throw new Error('Automatic enrollment could not be saved.'); }
  }

  async request(deviceId: string, proof: any, authority?: EnrollmentAuthority,
    admit: () => boolean = () => true): Promise<string> {
    if (!admit()) return 'unbound';
    const offered = Object.freeze({ publicKey: proof?.publicKey, nonce: proof?.nonce, signature: proof?.signature });
    // Production supplies the authority of the registered socket. Direct callers must
    // also capture before joining the global queue, never after authentication awaits.
    const binding = authority ? undefined : await this.deps.bindings.getDeviceBinding(deviceId);
    const original = Object.freeze({ openId: authority?.openId ?? binding?.openId ?? '',
      epoch: authority?.epoch ?? (binding && this.deps.bindings.getCardThreadEpoch(binding.openId, deviceId)) ?? '' });
    if (!admit() || !original.openId || !original.epoch) return 'unbound';
    const owns = () => this.deps.bindings.getCardThreadEpoch(original.openId, deviceId) === original.epoch;
    return this.run(async () => {
      if (!DeviceAuth.validKey(offered.publicKey)
        || !DeviceAuth.verifyProof(offered.publicKey, deviceId, offered.nonce, offered.signature)) return 'invalid';
      if (!owns()) return 'unbound';
      // Includes revoked records: automatic enrollment must never rotate or resurrect a key.
      if (await this.deps.auth.get(deviceId)) return 'already-enrolled';
      if (!owns()) return 'unbound';
      const { openId, epoch } = original;
      const existing = this.records.find(item => item.deviceId === deviceId && item.epoch === epoch);
      if (existing) {
        if (existing.publicKey !== offered.publicKey) {
          existing.state = 'conflict'; await this.save(); return 'conflict';
        }
        return existing.expires <= Date.now() ? 'expired' : existing.state;
      }
      if (this.records.length >= 64 || this.records.filter(item => item.openId === openId).length >= 8) return 'limited';
      const request: Request = { id: createHash('sha256').update(`${deviceId}\n${epoch}\n${offered.publicKey}`).digest('hex'),
        deviceId, openId, epoch, publicKey: offered.publicKey,
        expires: Date.now() + 24 * 60 * 60 * 1000, uuid: randomUUID(), state: 'intent' };
      if (Buffer.byteLength(JSON.stringify([...this.records, request])) > 60 * 1024) return 'limited';
      this.records.push(request);
      await this.save();
      return this.deliver(request);
    });
  }

  /** Only a previously proven key can recover from an explicit, owner-bound click. */
  canRecover(deviceId: string, openId: string, epoch: string): boolean {
    return this.healthy && !this.stopped && this.records.some(r => r.deviceId === deviceId && r.openId === openId
      && r.epoch === epoch && r.state === 'known');
  }

  async requestExplicit(deviceId: string, openId: string, epoch: string): Promise<string> {
    return this.run(async () => {
      if (this.deps.bindings.getCardThreadEpoch(openId, deviceId) !== epoch) return 'File approval is unavailable.';
      if (await this.deps.auth.get(deviceId)) return 'File approval cannot replace an existing or revoked key. Use remote-cli files enable.';
      const previous = this.records.find(r => r.deviceId === deviceId && r.openId === openId && r.epoch === epoch);
      if (!previous || previous.state !== 'known') return 'File approval is unavailable or its delivery is unconfirmed. Use remote-cli files enable.';
      if (previous.explicit && previous.expires > Date.now()) return 'Use the existing file approval card in this chat.';
      const request: Request = { ...previous, explicit: true, id: createHash('sha256').update(randomUUID()).digest('hex'),
        expires: Date.now() + 24 * 60 * 60 * 1000, uuid: randomUUID(), state: 'intent', cardId: undefined };
      const replacement = this.records.map(r => r === previous ? request : r);
      if (Buffer.byteLength(JSON.stringify(replacement)) > 60 * 1024) return 'File approval capacity is unavailable.';
      this.records = replacement;
      await this.save();
      const state = await this.deliver(request);
      return state === 'known' ? 'A new file approval card was sent. Approve it, then return to Get file.'
        : 'File approval delivery is unconfirmed. Use remote-cli files enable; no automatic resend will occur.';
    });
  }

  private async deliver(request: Request): Promise<string> {
    const fingerprint = createHash('sha256').update(request.publicKey).digest('hex').slice(0, 16);
    const content = JSON.stringify({ schema: '2.0', header: { template: 'blue', title: { tag: 'plain_text', content: 'Enable file access' } },
      body: { elements: [{ tag: 'div', text: { tag: 'plain_text', content:
        'An upgraded CLI requests file access. Approve only if you expect this request from your device. Text tasks continue without approval.' } },
      { tag: 'div', text: { tag: 'plain_text', content: `New device key: ${fingerprint}. Approval requires a fresh authenticated connection.` } },
      { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: 'Enable file access' },
        behaviors: [{ type: 'callback', value: { action: 'automatic_file_enrollment', id: request.id } }] }] } });
    let delivery: Promise<string> | undefined;
    let checked = false;
    let status = 'unbound';
    try {
      await this.deps.bindings.approveExistingDeviceKey(request.openId, request.deviceId, request.epoch, async () => {
        checked = true;
        if (await this.deps.auth.get(request.deviceId)) { status = 'already-enrolled'; return; }
        // This call is the external admission boundary. No binding mutation can
        // commit between this final auth read and starting the exact owner's RPC.
        // Release the binding queue before awaiting network completion.
        try { delivery = Promise.resolve(this.deps.create(request.openId, content, request.uuid)); }
        catch { delivery = Promise.reject(new Error('Card creation outcome unknown.')); }
        void delivery.catch(() => {});
      });
    } catch (error) {
      if (checked) throw error;
      return 'unbound';
    }
    if (!delivery) return status;
    try {
      const cardId = await delivery;
      if (typeof cardId !== 'string' || !cardId || cardId.length > 200) throw new Error('Missing card receipt.');
      request.cardId = cardId; request.state = 'known';
    } catch { request.state = 'uncertain'; }
    await this.save();
    return request.state;
  }

  async click(openId: string, cardId: string, payload: unknown): Promise<string> {
    return this.run(async () => {
      const id = (payload as any)?.id;
      const request = this.records.find(item => item.id === id && item.openId === openId && item.cardId === cardId);
      if (!request || !['known', 'approved'].includes(request.state) || request.expires <= Date.now()) return 'This approval is unavailable or expired.';
      await this.deps.bindings.approveExistingDeviceKey(openId, request.deviceId, request.epoch, async () => {
        const enrolled = await this.deps.auth.get(request.deviceId);
        if (enrolled) {
          if (!enrolled.revoked && enrolled.openId === openId && enrolled.publicKey === request.publicKey) return;
          throw new Error('Device key changed.');
        }
        await this.deps.approve(openId, request.deviceId, request.publicKey);
      });
      request.state = 'approved'; await this.save();
      return 'File access approved. The CLI will reconnect securely.';
    });
  }

  async destroy(): Promise<void> { this.stopped = true; await this.tail; }
}

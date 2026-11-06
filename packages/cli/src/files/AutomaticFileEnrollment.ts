import { randomBytes } from 'crypto';
import { DeviceIdentity, ensureIdentity, fileOrigin, signDeviceProof } from './DeviceIdentity';

/** An eligible Router can request approval, never automatic authorization or key rotation. */
export class AutomaticFileEnrollment {
  private pending?: Promise<DeviceIdentity | undefined>;
  constructor(private readonly configDir: string, private readonly serverUrl: string,
    private readonly deviceId: string, private readonly enabled = true) {}

  prepare(eligible: boolean): Promise<DeviceIdentity | undefined> {
    if (!eligible || !this.enabled) return Promise.resolve(undefined);
    if (this.pending) return this.pending;
    try { fileOrigin(this.serverUrl); } catch { return Promise.resolve(undefined); }
    this.pending = ensureIdentity(this.configDir, this.serverUrl, this.deviceId)
      .catch(() => undefined).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  static proof(identity: DeviceIdentity, deviceId: string) {
    const nonce = randomBytes(32).toString('hex');
    return { publicKey: identity.publicKey, nonce, signature: signDeviceProof(identity, deviceId, nonce) };
  }
}

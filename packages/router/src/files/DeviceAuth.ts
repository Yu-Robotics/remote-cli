import { createPublicKey, randomBytes, randomUUID, verify } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

interface Enrollment { openId: string; publicKey: string; revoked?: boolean }
interface Challenge { deviceId: string; nonce: string; expiresAt: number }

/** Public keys are approved out-of-band using the existing Feishu binding code. */
export class DeviceAuth {
  private records: Record<string, Enrollment> = Object.create(null);
  private readonly challenges = new WeakMap<object, Challenge>();
  private loading?: Promise<void>;
  private writes = Promise.resolve();

  constructor(private readonly filename: string) {}

  private ready(): Promise<void> {
    return this.loading ??= (async () => {
      try {
        const stat = await fs.lstat(this.filename);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe device authentication store.');
        const records = JSON.parse(await fs.readFile(this.filename, 'utf8'));
        if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid device authentication store.');
        for (const record of Object.values(records) as Enrollment[]) {
          if (!record || typeof record.openId !== 'string' || !DeviceAuth.validKey(record.publicKey)) throw new Error('Invalid device authentication record.');
        }
        this.records = Object.assign(Object.create(null), records);
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
      }
    })();
  }

  static validKey(key: unknown): key is string {
    if (typeof key !== 'string' || key.length > 256) return false;
    try { return createPublicKey(key).asymmetricKeyType === 'ed25519'; } catch { return false; }
  }

  static verifyProof(publicKey: string, deviceId: string, nonce: unknown, signature: unknown): boolean {
    if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)
      || typeof signature !== 'string' || signature.length > 128) return false;
    try {
      return verify(null, Buffer.from(`remote-cli-device-v1\n${deviceId}\n${nonce}`), publicKey, Buffer.from(signature, 'base64'));
    } catch { return false; }
  }

  async get(deviceId: string): Promise<Enrollment | undefined> {
    await this.ready();
    const record = this.records[deviceId];
    return record ? { ...record } : undefined;
  }

  isCurrent(deviceId: string, record: { openId: string; publicKey: string }): boolean {
    const current = this.records[deviceId];
    return Boolean(current && !current.revoked && current.openId === record.openId && current.publicKey === record.publicKey);
  }

  challenge(connection: object, deviceId: string): string {
    const nonce = randomBytes(32).toString('hex');
    this.challenges.set(connection, { deviceId, nonce, expiresAt: Date.now() + 15_000 });
    return nonce;
  }

  async verify(connection: object, deviceId: string, signature: unknown): Promise<Enrollment | undefined> {
    const challenge = this.challenges.get(connection);
    this.challenges.delete(connection);
    if (!challenge || challenge.deviceId !== deviceId || challenge.expiresAt < Date.now()) return undefined;
    const record = await this.get(deviceId);
    if (!record || record.revoked || !DeviceAuth.verifyProof(record.publicKey, deviceId, challenge.nonce, signature)) return undefined;
    return record;
  }

  async enroll(deviceId: string, openId: string, publicKey: string): Promise<void> {
    if (!DeviceAuth.validKey(publicKey)) throw new Error('Invalid device public key.');
    await this.change(deviceId, { openId, publicKey });
  }

  async revoke(deviceId: string): Promise<void> {
    const previous = await this.get(deviceId);
    // Keep a tombstone: revocation must not reopen credentialless registration.
    if (previous) await this.change(deviceId, { ...previous, revoked: true });
  }

  private async change(deviceId: string, record: Enrollment): Promise<void> {
    await this.ready();
    const write = this.writes.then(async () => {
      const next = Object.assign(Object.create(null), this.records, { [deviceId]: record });
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, this.filename);
        this.records = next;
      } finally { await fs.rm(temporary, { force: true }); }
    });
    this.writes = write.catch(() => {});
    return write;
  }
}

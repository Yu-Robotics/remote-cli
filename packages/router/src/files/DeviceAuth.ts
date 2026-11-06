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
  private uncertainty?: Error;

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
    if (this.uncertainty) throw this.uncertainty;
    const record = this.records[deviceId];
    return record ? { ...record } : undefined;
  }

  isCurrent(deviceId: string, record: { openId: string; publicKey: string }): boolean {
    if (this.uncertainty) return false;
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
      if (this.uncertainty) throw this.uncertainty;
      const next = Object.assign(Object.create(null), this.records, { [deviceId]: record });
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      let handle: fs.FileHandle | undefined;
      let replaced = false;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(next));
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(temporary, this.filename);
        replaced = true;
        // Windows does not support directory handles/fsync through this portable path.
        if (process.platform !== 'win32') {
          const directory = await fs.open(path.dirname(this.filename), 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        }
      } catch (error) {
        if (replaced) {
          this.uncertainty = new Error(
            'Device authentication disk state is uncertain; authentication and writes are blocked until restart.',
            { cause: error },
          );
          throw this.uncertainty;
        }
        throw error;
      } finally {
        if (handle) await handle.close().catch(() => undefined);
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
      this.records = next;
    });
    this.writes = write.catch(() => {});
    return write;
  }
}

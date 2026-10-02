import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'crypto';
import fs from 'fs/promises';
import { privateDirectory, readPrivateJson } from './FileIO';
import path from 'path';

export interface DeviceIdentity {
  privateKey: string;
  publicKey: string;
}

/** File transfers never inherit an arbitrary URL from a message. */
export function fileOrigin(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('File transfer requires a Router URL without credentials, query, or fragment.');
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('File transfer requires HTTPS/WSS, except on loopback. Configure TLS before enabling files.');
  }
  return url.origin;
}

function identityPath(configDir: string, serverUrl: string, deviceId: string): string {
  const id = createHash('sha256').update(`${fileOrigin(serverUrl)}\n${deviceId}`).digest('hex');
  return path.join(configDir, 'device-identities', `${id}.json`);
}

export async function loadIdentity(configDir: string, serverUrl: string, deviceId: string): Promise<DeviceIdentity | undefined> {
  let filename: string;
  try { filename = identityPath(configDir, serverUrl, deviceId); } catch { return undefined; }
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
      throw new Error('Device identity must be a private regular file (mode 0600).');
    }
    if (await fs.realpath(path.dirname(filename)) !== path.resolve(path.dirname(filename))) throw new Error('Unsafe device identity directory.');
    const value = await readPrivateJson(filename) as DeviceIdentity;
    const key = createPrivateKey(value.privateKey);
    if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== value.publicKey) {
      throw new Error('Invalid device identity. Run remote-cli files enable --rotate and approve the new binding code.');
    }
    return value;
  } catch (error: any) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function ensureIdentity(configDir: string, serverUrl: string, deviceId: string, rotate = false): Promise<DeviceIdentity> {
  if (!rotate) {
    const current = await loadIdentity(configDir, serverUrl, deviceId);
    if (current) return current;
  }
  const filename = identityPath(configDir, serverUrl, deviceId);
  const directory = path.dirname(filename);
  await privateDirectory(directory);
  const keys = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const temporary = `${filename}.${createHash('sha256').update(keys.publicKey).digest('hex')}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(keys), { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, filename);
  return keys;
}

export function signDeviceProof(identity: DeviceIdentity, deviceId: string, nonce: string): string {
  return sign(null, Buffer.from(`remote-cli-device-v1\n${deviceId}\n${nonce}`), identity.privateKey).toString('base64');
}

import axios from 'axios';
import { randomBytes } from 'crypto';
import { ConfigManager } from '../config/ConfigManager';
import { ensureIdentity, fileOrigin, signDeviceProof } from '../files/DeviceIdentity';

/** Explicit enrollment; upgrading alone never authorizes a new device key. */
export async function enableFiles(rotate = false): Promise<{ bindingCode: string }> {
  const config = await ConfigManager.initialize();
  const deviceId = config.get('deviceId') as string;
  const serverUrl = config.get('serverUrl') as string;
  if (!deviceId || !serverUrl) throw new Error('Initialize remote-cli before enabling files.');
  const origin = fileOrigin(serverUrl);
  const identity = await ensureIdentity(config.getConfigDir(), serverUrl, deviceId, rotate);
  const nonce = randomBytes(32).toString('hex');
  const response = await axios.post(`${origin}/api/bind/request`, {
    deviceId, deviceName: 'File-enabled device', devicePublicKey: identity.publicKey,
    nonce, signature: signDeviceProof(identity, deviceId, nonce),
  }, { timeout: 10_000, maxRedirects: 0 });
  if (!response.data?.success || response.data.deviceAuth !== true || typeof response.data.bindingCode !== 'string') {
    throw new Error('The Router does not support secure file enrollment. Upgrade and configure the Router first.');
  }
  return { bindingCode: response.data.bindingCode };
}

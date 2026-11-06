import axios from 'axios';
import { randomBytes } from 'crypto';
import { ensureIdentity, fileOrigin, signDeviceProof } from './DeviceIdentity';

/** Only fixed, safe diagnostics may cross the command boundary. */
export class DeviceEnrollmentError extends Error {}

/** Request approval; only redemption in Feishu authorizes the saved device key. */
export async function requestDeviceEnrollment(options: {
  configDir: string; serverUrl: string; deviceId: string; deviceName: string; rotate?: boolean;
}): Promise<{ bindingCode: string }> {
  let origin: string;
  try { origin = fileOrigin(options.serverUrl); }
  catch { throw new DeviceEnrollmentError('Secure file enrollment requires HTTPS (HTTP is allowed only on loopback), without URL credentials, query, or fragment.'); }

  let identity;
  try { identity = await ensureIdentity(options.configDir, options.serverUrl, options.deviceId, options.rotate); }
  catch { throw new DeviceEnrollmentError('Device identity could not be prepared. Check local identity storage and permissions; an existing key must not be discarded automatically.'); }

  const nonce = randomBytes(32).toString('hex');
  let response;
  try {
    response = await axios.post(`${origin}/api/bind/request`, {
      deviceId: options.deviceId, deviceName: options.deviceName, devicePublicKey: identity.publicKey,
      nonce, signature: signDeviceProof(identity, options.deviceId, nonce),
    }, { timeout: 10_000, maxRedirects: 0, maxContentLength: 16 * 1024 });
  } catch {
    // Axios errors can contain request/response data. Keep the saved key for retries.
    throw new DeviceEnrollmentError('Secure file enrollment request failed. Check the Router URL, TLS, and files.enabled setting, then retry; the saved key will be reused.');
  }
  const data = response.data;
  if (data?.success !== true || data.deviceAuth !== true) {
    throw new DeviceEnrollmentError('The Router did not confirm secure file enrollment. Upgrade the Router and check files.enabled before retrying.');
  }
  if (typeof data.bindingCode !== 'string' || data.bindingCode.length > 64 || data.bindingCode.trim() !== data.bindingCode
    || !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(data.bindingCode)) {
    throw new DeviceEnrollmentError('The Router returned an invalid secure binding code. Retry with the saved device key.');
  }
  return { bindingCode: data.bindingCode };
}

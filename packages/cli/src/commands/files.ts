import { ConfigManager } from '../config/ConfigManager';
import { requestDeviceEnrollment } from '../files/DeviceEnrollment';

/** Explicit enrollment; upgrading alone never authorizes a new device key. */
export async function enableFiles(rotate = false): Promise<{ bindingCode: string }> {
  const config = await ConfigManager.initialize();
  const deviceId = config.get('deviceId') as string;
  const serverUrl = config.get('serverUrl') as string;
  if (!deviceId || !serverUrl) throw new Error('Initialize remote-cli before enabling files.');
  return requestDeviceEnrollment({ configDir: config.getConfigDir(), serverUrl, deviceId,
    deviceName: 'File-enabled device', rotate });
}

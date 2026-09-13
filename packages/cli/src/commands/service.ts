import { ConfigManager } from '../config/ConfigManager';
import { createServiceManager, ServiceStatus } from '../service/ServiceManager';

export type ServiceAction = 'install' | 'uninstall' | 'status';

export interface ServiceCommandOptions {
  action: ServiceAction;
}

export interface ServiceCommandResult {
  success: boolean;
  status?: ServiceStatus;
  error?: string;
}

export async function serviceCommand(options: ServiceCommandOptions): Promise<ServiceCommandResult> {
  try {
    const config = await ConfigManager.initialize();
    if (options.action === 'install' && !config.has('deviceId')) {
      return { success: false, error: 'Device not initialized. Please run "remote-cli init" first.' };
    }

    const manager = createServiceManager();
    const status = options.action === 'install'
      ? await manager.install()
      : options.action === 'uninstall'
        ? await manager.uninstall()
        : await manager.status();
    if (options.action === 'uninstall') {
      await config.set('service.running', false);
      await config.set('service.stoppedAt', Date.now());
    }
    return { success: true, status };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

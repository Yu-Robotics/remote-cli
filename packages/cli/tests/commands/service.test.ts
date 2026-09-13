import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/ConfigManager', () => ({
  ConfigManager: {
    initialize: vi.fn(),
  },
}));

vi.mock('../../src/service/ServiceManager', () => ({
  createServiceManager: vi.fn(),
}));

import { ConfigManager } from '../../src/config/ConfigManager';
import { createServiceManager } from '../../src/service/ServiceManager';
import { serviceCommand } from '../../src/commands/service';

describe('serviceCommand', () => {
  it('requires initialization before installing a service', async () => {
    vi.mocked(ConfigManager.initialize).mockResolvedValue({ has: () => false } as any);

    await expect(serviceCommand({ action: 'install' })).resolves.toEqual({
      success: false,
      error: 'Device not initialized. Please run "remote-cli init" first.',
    });
    expect(createServiceManager).not.toHaveBeenCalled();
  });

  it('delegates status to the platform service manager', async () => {
    vi.mocked(ConfigManager.initialize).mockResolvedValue({ has: () => true } as any);
    const status = { platform: 'linux', supported: true, installed: true, running: false, enabled: true, servicePath: '/tmp/service', serviceName: 'remote-cli' };
    vi.mocked(createServiceManager).mockReturnValue({
      install: vi.fn(),
      uninstall: vi.fn(),
      status: vi.fn().mockResolvedValue(status),
    });

    await expect(serviceCommand({ action: 'status' })).resolves.toEqual({ success: true, status });
  });
});

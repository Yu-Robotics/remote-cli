import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { MessageHandler } from '../src/client/MessageHandler';
import { BackendRegistry } from '../src/delegation/BackendRegistry';
import { DELEGATION_BACKENDS } from '../src/delegation/contract';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { initializeBackendEnvironment } from '../src/utils/BackendEnvironment';
import type { ExecutorConfig } from '../src/types/config';

const directories: string[] = [];
const handlers: MessageHandler[] = [];
afterEach(async () => {
  await Promise.all(handlers.splice(0).map(handler => handler.destroy()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'backend-discovery-'));
  directories.push(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('PATH', path.join(home, 'legacy-bin'));
  vi.stubEnv('npm_config_prefix', 'relative');
  initializeBackendEnvironment();
  const bin = path.join(home, '.local/bin');
  mkdirSync(bin, { recursive: true });
  const install = (name: string) => writeFileSync(path.join(bin, name), '#!/usr/bin/env node\nconsole.log("Backend fixture 1.0");\n', { mode: 0o755 });
  return { home, bin, install };
}

describe.skipIf(process.platform === 'win32')('live discovery under an old service environment', () => {
  it('uses the same configured executables for mobile and delegated discovery after startup', async () => {
    const f = fixture();
    const config: ExecutorConfig = { type: 'auto' };
    for (const backend of DELEGATION_BACKENDS) {
      const command = `fixture-${backend}`;
      f.install(command);
      config[backend] = { command };
    }
    const handler = new MessageHandler({ isConnected: () => false } as any,
      { destroyAll: vi.fn() } as any, {} as any, new DirectoryGuard([f.home]),
      { get: (key: string) => key === 'executor' ? config : undefined, getConfigDir: () => f.home } as any);
    handlers.push(handler);
    const mobile = await (handler as any).detectBackends();
    const delegated = await new BackendRegistry().list(config);
    expect(mobile).toHaveLength(DELEGATION_BACKENDS.length);
    expect(mobile.every((backend: any) => backend.installed)).toBe(true);
    expect(delegated.every(backend => backend.installed && backend.authentication === 'unknown')).toBe(true);
    expect(delegated.map(backend => backend.version)).toEqual(DELEGATION_BACKENDS.map(() => 'Backend fixture 1.0'));
  });

  it('expires a negative delegation probe after a later install without changing PATH', async () => {
    const f = fixture();
    const registry = new BackendRegistry();
    const config: ExecutorConfig = { type: 'kimi', kimi: { command: 'fixture-kimi' } };
    const composed = process.env.PATH;
    expect((await registry.get('kimi', config)).installed).toBe(false);
    f.install('fixture-kimi');
    expect((await registry.get('kimi', config)).installed).toBe(false);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001);
    expect(await registry.get('kimi', config)).toMatchObject({ installed: true, version: 'Backend fixture 1.0' });
    expect(process.env.PATH).toBe(composed);
    const invalid = await registry.get('kimi', { ...config, kimi: { command: path.join(f.home, 'missing-kimi') } });
    expect(invalid).toMatchObject({ installed: false, authentication: 'unknown' });
    expect(invalid.reason).toContain('executable, interpreter, or working directory');
    expect(invalid.reason).not.toContain(f.home);
    for (const command of ['', '/opt/fixture\u0000command']) {
      const malformed = await registry.get('kimi', { ...config, kimi: { command } });
      expect(malformed).toMatchObject({ installed: false, reason: 'Version probe failed.' });
    }
  });
});

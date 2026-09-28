import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelegationBridge } from '../../src/delegation/DelegationBridge';
import { BackendRegistry } from '../../src/delegation/BackendRegistry';

describe('delegation transport and discovery', () => {
  const bridges: DelegationBridge[] = [];
  afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.close())); });

  it('requires authentication and an active parent for every tool call', async () => {
    const bridge = new DelegationBridge(); bridges.push(bridge);
    const connection = await bridge.start();
    const handler = vi.fn(async () => ({ marker: 'ok' }));
    const call = (token: string) => fetch(connection.url, { method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'remote_cli_list_backends', args: {}, callId: 'one' }) });
    expect((await call(connection.token)).status).toBe(409);
    bridge.activate(handler);
    expect((await call('wrong')).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(await (await call(connection.token)).json()).toEqual({ marker: 'ok' });
    bridge.activate(undefined);
    expect((await call(connection.token)).status).toBe(409);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed operations before invoking a worker', async () => {
    const bridge = new DelegationBridge(); bridges.push(bridge);
    const connection = await bridge.start();
    const handler = vi.fn(async () => ({})); bridge.activate(handler);
    for (const body of ['not-json', JSON.stringify({ name: 'shell', args: {}, callId: 'x' })]) {
      const response = await fetch(connection.url, { method: 'POST', headers: { authorization: `Bearer ${connection.token}` }, body });
      expect(response.status).toBe(400);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('honors configured commands without inferring authentication from installation', async () => {
    const probe = vi.fn(async (command: string) => { if (command === 'pi') throw new Error('missing'); return '1.0'; });
    const registry = new BackendRegistry(probe);
    const config = { type: 'codex' as const, codex: { command: '/custom/codex' } };
    const backends = await registry.list(config);
    expect(probe).toHaveBeenCalledWith('/custom/codex');
    expect(backends.find(item => item.backend === 'codex')).toMatchObject({ installed: true, authentication: 'unknown' });
    expect(backends.find(item => item.backend === 'pi')).toMatchObject({ installed: false, worker: false });
    for (const backend of ['agy', 'opencode', 'kimi', 'zcode']) {
      expect(backends.find(item => item.backend === backend)).toMatchObject({ installed: true, coordinator: true, worker: true, readOnly: false });
    }
    await registry.list(config);
    expect(probe).toHaveBeenCalledTimes(7);
    registry.invalidate(); await registry.list(config);
    expect(probe).toHaveBeenCalledTimes(14);
  });

  it('checks real executable presence without starting an interactive model session', async () => {
    const registry = new BackendRegistry();
    expect(await registry.get('codex', { type: 'codex', codex: { command: process.execPath } }))
      .toMatchObject({ installed: true, authentication: 'unknown', version: process.version });
    expect(await registry.get('pi', { type: 'pi', pi: { command: '/nonexistent/remote-cli-delegation-test' } }))
      .toMatchObject({ installed: false, worker: false });
  });

  it('uses Node to discover an official ZCode script without executable permission', async () => {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-discovery-test-'));
    try {
      const entry = path.join(directory, 'zcode.cjs');
      await fs.writeFile(entry, "if (process.argv[2] !== '--version') process.exit(2); console.log('ZCode fixture 1.0');", { mode: 0o600 });
      expect(await new BackendRegistry().get('zcode', { type: 'zcode', zcode: { command: entry } }))
        .toMatchObject({ installed: true, version: 'ZCode fixture 1.0', authentication: 'unknown' });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  it('closes active polling connections without waiting for the worker result', async () => {
    const bridge = new DelegationBridge(); bridges.push(bridge);
    const connection = await bridge.start();
    const handler = vi.fn(() => new Promise(() => undefined)); bridge.activate(handler);
    const pending = fetch(connection.url, { method: 'POST', headers: { authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ name: 'remote_cli_result', args: { taskId: 'waiting' }, callId: 'poll' }) });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    await bridge.close();
    await rejected;
  });
});

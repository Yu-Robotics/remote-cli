import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';
import { CodexAppServerExecutor } from '../src/executor/CodexAppServerExecutor';
import { AcpExecutor } from '../src/executor/AcpExecutor';
import { AgyExecutor } from '../src/executor/AgyExecutor';
import { PiExecutor } from '../src/executor/PiExecutor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedToolBridge } from '../src/managed/ManagedToolBridge';
import { managedTools, environmentTools } from '../src/managed/tools';
import { hasDelegationTools } from '../src/managed/contract';
import { delegationEnvironment, sameConnection, delegationSessionServers } from '../src/delegation/contract';

describe('managed tool registration', () => {
  const bridges: ManagedToolBridge[] = [];
  afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(bridges.splice(0).map(bridge => bridge.close())); });
  it.each([ClaudePersistentExecutor, CodexAppServerExecutor, AcpExecutor, AgyExecutor, PiExecutor])('refuses control registration in managed child workers (%s)', async Executor => {
    const configureDelegation = vi.fn();
    await expect(Executor.prototype.configureManagedTools.call({ delegationWorker: true, configureDelegation },
      { url: 'http://127.0.0.1:1/', token: 'fixture-token', groups: ['scheduling'] })).rejects.toThrow('child workers');
    expect(configureDelegation).not.toHaveBeenCalled();
  });
  it('keeps the legacy delegation group while explicitly isolating scheduling registration', () => {
    const connection = { url: 'http://127.0.0.1:1/', token: 'fixture-token', groups: ['scheduling'] as const };
    expect(managedTools().some(tool => tool.name === 'remote_cli_delegate')).toBe(true);
    expect(managedTools(connection).every(tool => tool.name.startsWith('remote_cli_schedule_'))).toBe(true);
    expect(hasDelegationTools(connection)).toBe(false); expect(hasDelegationTools({ ...connection, groups: undefined })).toBe(true);
    expect(hasDelegationTools()).toBe(false);
    expect(sameConnection(connection, { ...connection })).toBe(true);
    expect(sameConnection(connection, { ...connection, groups: ['delegation'] })).toBe(false);
    expect(delegationEnvironment(connection).REMOTE_CLI_TOOL_GROUPS).toBe('["scheduling"]');
    expect(delegationSessionServers(connection)[0].env).toContainEqual({ name: 'REMOTE_CLI_TOOL_GROUPS', value: '["scheduling"]' });
    vi.stubEnv('REMOTE_CLI_TOOL_GROUPS', '["scheduling"]'); expect(environmentTools()).toEqual(managedTools(connection));
    vi.stubEnv('REMOTE_CLI_TOOL_GROUPS', 'invalid'); expect(environmentTools()).toEqual([]);
    vi.stubEnv('REMOTE_CLI_TOOL_GROUPS', '["shell"]'); expect(environmentTools()).toEqual([]);
    vi.stubEnv('REMOTE_CLI_TOOL_GROUPS', ''); expect(environmentTools()).toEqual(managedTools());
  });
  it('retires only the owning activation, including reuse of the same callback', () => {
    const bridge = new ManagedToolBridge(); bridges.push(bridge);
    const handler = vi.fn(async () => ({}));
    const old = bridge.activate(handler), latest = bridge.activate(handler);
    old(); expect((bridge as any).handler).toBe(handler);
    latest(); expect((bridge as any).handler).toBeUndefined();
    const final = bridge.activate(handler);
    latest(); expect((bridge as any).handler).toBe(handler);
    final(); expect((bridge as any).handler).toBeUndefined();
  });
  it('authenticates tool groups without granting delegation and retains a stable transport across turns', async () => {
    const bridge = new ManagedToolBridge(); bridges.push(bridge);
    const connection = await bridge.start(['scheduling']);
    const invoke = vi.fn(async () => ({ accepted: true })); const retire = bridge.activate(invoke);
    const call = (name: string, token = connection.token) => fetch(connection.url, { method: 'POST',
      headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name, args: {}, callId: 'fixture-call' }) });
    expect((await call('remote_cli_delegate')).status).toBe(400);
    expect((await call('remote_cli_schedule_capabilities', 'wrong')).status).toBe(401);
    expect(await (await call('remote_cli_schedule_capabilities')).json()).toEqual({ accepted: true });
    const second = await bridge.start(['delegation', 'scheduling']);
    expect(second.url).toBe(connection.url); expect(second.token).toBe(connection.token);
    expect((await call('remote_cli_delegate')).status).toBe(200);
    retire(); expect((await call('remote_cli_schedule_capabilities')).status).toBe(409);
  });
});

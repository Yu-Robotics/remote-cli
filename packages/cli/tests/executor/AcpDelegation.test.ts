import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { AcpClient, type AcpEventCallbacks } from '../../src/executor/acp/AcpClient';
import { OpenCodeExecutor } from '../../src/executor/OpenCodeExecutor';
import { KimiExecutor } from '../../src/executor/KimiExecutor';
import { ZCodeExecutor } from '../../src/executor/ZCodeExecutor';
import { ZCodeClient } from '../../src/executor/zcode/ZCodeClient';
import type { AcpExecutor } from '../../src/executor/AcpExecutor';

// A real subprocess verifies wire data and lifecycle independently of the adapter.
const originalHome = os.homedir();
const fixture = String.raw`
const fs = require('fs');
const readline = require('readline');
let servers = [];
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value}) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const {id,method,params} = JSON.parse(line);
  fs.appendFileSync(process.argv[2], JSON.stringify({method,params})+'\n');
  const reply = result => send({jsonrpc:'2.0',id,result});
  if (method === 'initialize') return reply({protocolVersion:1,agentCapabilities:{loadSession:true}});
  if (['session/new','session/load','session/create','session/resume'].includes(method)) {
    if (['session/new','session/load'].includes(method) && !Array.isArray(params.mcpServers)) throw new Error('ACP MCP servers must be explicit');
    servers = params.mcpServers || [];
    if (method === 'session/load') send({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD HISTORY'}}}});
    return reply(method === 'session/new' || method === 'session/load' ? {sessionId:'session'} : {session:{sessionId:'session'}});
  }
  if (method === 'session/subscribe') return reply({eventSeq:0});
  if (method === 'session/send') {
    reply({accepted:true});
    send({method:'session/event',params:{sessionId:'session',seq:1,type:'model.streaming',payload:{kind:'text_delta',delta:'tools='+servers.length,turnId:'turn'}}});
    return send({method:'session/event',params:{sessionId:'session',seq:2,type:'turn.completed',payload:{turnId:'turn',resultType:'success'}}});
  }
  if (method === 'session/prompt') {
    send({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'tools='+servers.length}}}});
    return reply({stopReason:'end_turn'});
  }
  reply({});
});
`;

describe('ACP-family delegation sessions', () => {
  let directory: string;
  let executor: AcpExecutor | undefined;
  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(originalHome, '.acp-delegation-test-')));
    fs.writeFileSync(path.join(directory, 'server.cjs'), fixture);
  });
  afterEach(async () => {
    await executor?.destroy(); await executor?.waitForExit();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(['opencode', 'kimi', 'zcode'] as const)('registers, resumes, and removes %s tools without changing the session', async backend => {
    const log = path.join(directory, 'requests.jsonl');
    const factory = (callbacks: AcpEventCallbacks, cwd: string) => backend === 'zcode'
      ? new ZCodeClient({ cwd, launch: { command: process.execPath, args: [path.join(directory, 'server.cjs'), log], env: process.env } }, callbacks)
      : new AcpClient(process.execPath, [path.join(directory, 'server.cjs'), log], cwd, callbacks);
    const options = { initialWorkingDirectory: directory, sessionBaseDir: directory, threadId: 'test', clientFactory: factory };
    const Constructor = { opencode: OpenCodeExecutor, kimi: KimiExecutor, zcode: ZCodeExecutor }[backend];
    executor = new Constructor(new DirectoryGuard([directory]), options);
    const first = { url: 'http://127.0.0.1:9999/', token: 'private-first' };
    await executor.configureDelegation(first);
    expect(await executor.execute('First')).toMatchObject({ success: true, output: 'tools=1' });
    const session = executor.getSessionId();
    await executor.configureDelegation({ ...first, token: 'private-second' });
    expect(await executor.execute('Resume')).toMatchObject({ success: true, output: 'tools=1' });
    await executor.configureDelegation(undefined);
    expect(await executor.execute('Disabled')).toMatchObject({ success: true, output: 'tools=0' });
    expect(executor.getSessionId()).toBe(session);
    const requests = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const sessions = requests.filter(request => ['session/new', 'session/load', 'session/create', 'session/resume'].includes(request.method));
    expect(sessions).toHaveLength(3);
    expect(sessions[0].params.mcpServers[0]).toMatchObject({ name: 'remote-cli-delegation', command: process.execPath,
      env: expect.arrayContaining([{ name: 'REMOTE_CLI_DELEGATION_TOKEN', value: 'private-first' }]) });
    expect(sessions[1].params).toMatchObject({ sessionId: session, mcpServers: [expect.objectContaining({
      env: expect.arrayContaining([{ name: 'REMOTE_CLI_DELEGATION_TOKEN', value: 'private-second' }]),
    })] });
    if (backend === 'zcode') expect(sessions[0].params.mcpServers[0]).toMatchObject({ isolation: 'session', timeoutMs: 35000 });
    expect(sessions[2].params.mcpServers).toEqual(backend === 'zcode' ? undefined : []);
    await executor.destroy(); await executor.waitForExit();
    const requestsBeforeDelete = fs.readFileSync(log, 'utf8');
    await executor.deleteThreadData('test');
    expect(fs.readFileSync(log, 'utf8')).toBe(requestsBeforeDelete);
  });

  it('keeps history when restoring with MCP tools fails instead of silently starting over', async () => {
    fs.writeFileSync(path.join(directory, 'test.json'), JSON.stringify({ id: 'existing', cwd: directory }));
    const transport = { initialize: vi.fn().mockResolvedValue({}), loadSession: vi.fn().mockRejectedValue(new Error('MCP unavailable')),
      newSession: vi.fn(), destroy: vi.fn(), waitForExit: vi.fn().mockResolvedValue(undefined) };
    executor = new OpenCodeExecutor(new DirectoryGuard([directory]), { initialWorkingDirectory: directory,
      sessionBaseDir: directory, threadId: 'test', clientFactory: () => transport as any });
    await executor.configureDelegation({ url: 'http://127.0.0.1:1/', token: 'test' });
    expect(await executor.execute('Resume')).toMatchObject({ success: false, error: 'MCP unavailable' });
    expect(transport.newSession).not.toHaveBeenCalled();
    expect(executor.getSessionId()).toBe('existing');
  });

  it('recovers a native session that was never persisted after a failed first turn', async () => {
    fs.writeFileSync(path.join(directory, 'test.json'), JSON.stringify({ id: 'unpersisted', cwd: directory }));
    const transport = { initialize: vi.fn().mockResolvedValue({}), loadSession: vi.fn().mockRejectedValue(new Error('Session not found: unpersisted')),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'fresh' }), prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      destroy: vi.fn(), waitForExit: vi.fn().mockResolvedValue(undefined) };
    executor = new ZCodeExecutor(new DirectoryGuard([directory]), { initialWorkingDirectory: directory,
      sessionBaseDir: directory, threadId: 'test', clientFactory: () => transport as any });
    await executor.configureDelegation({ url: 'http://127.0.0.1:1/', token: 'test' });
    expect(await executor.execute('Retry')).toMatchObject({ success: true });
    expect(transport.newSession).toHaveBeenCalledWith(directory, expect.arrayContaining([expect.objectContaining({ name: 'remote-cli-delegation' })]));
    expect(executor.getSessionId()).toBe('fresh');
  });
});

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
const fixture = String.raw`
const fs = require('fs');
const readline = require('readline');
let servers = [];
const mode = value => ({id:'mode',name:'Mode',type:'select',currentValue:value,options:['default','auto'].map(value=>({value,name:value}))});
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
    return reply(method === 'session/new' || method === 'session/load' ? {sessionId:'session',configOptions:[mode('default')]} : {session:{sessionId:'session'}});
  }
  if (method === 'session/set_config_option') return reply({configOptions:[mode(params.value)]});
  if (method === 'session/subscribe') return reply({eventSeq:0});
  if (method === 'session/send') {
    reply({accepted:true});
    send({method:'session/event',params:{sessionId:'session',seq:1,type:'turn.started',payload:{turnId:'turn'}}});
    if (params.content === 'Scheduled') send({method:'session/event',params:{sessionId:'session',seq:2,type:'model.streaming',payload:{kind:'text_delta',delta:'OLD TURN',turnId:'previous'}}});
    send({method:'session/event',params:{sessionId:'session',seq:3,type:'model.streaming',payload:{kind:'text_delta',delta:'tools='+servers.length,turnId:'turn'}}});
    return send({method:'session/event',params:{sessionId:'session',seq:4,type:'turn.completed',payload:{turnId:'turn',resultType:'success'}}});
  }
  if (method === 'session/prompt') {
    if (params.prompt[0].text === 'Scheduled') send({method:'session/update',params:{sessionId:'foreign',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OTHER SESSION'}}}});
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
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-delegation-')));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    vi.stubEnv('HOME', directory); vi.stubEnv('USERPROFILE', directory);
    fs.writeFileSync(path.join(directory, 'server.cjs'), fixture);
  });
  afterEach(async () => {
    await executor?.destroy(); await executor?.waitForExit();
    fs.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks(); vi.unstubAllEnvs();
  });

  it.each(['opencode', 'kimi', 'zcode'] as const)('loads the original %s session with scheduling-only tools and returns only scheduled output', async backend => {
    const log = path.join(directory, 'schedule.jsonl');
    const factory = (callbacks: AcpEventCallbacks, cwd: string) => backend === 'zcode'
      ? new ZCodeClient({ cwd, launch: { command: process.execPath, args: [path.join(directory, 'server.cjs'), log], env: process.env } }, callbacks)
      : new AcpClient(process.execPath, [path.join(directory, 'server.cjs'), log], cwd, callbacks);
    const options = { initialWorkingDirectory: directory, sessionBaseDir: directory, threadId: 'test', clientFactory: factory };
    const Constructor = { opencode: OpenCodeExecutor, kimi: KimiExecutor, zcode: ZCodeExecutor }[backend];
    executor = new Constructor(new DirectoryGuard([directory]), options);
    const connection = { url: 'http://127.0.0.1:1/', token: 'fixture', groups: ['scheduling'] as const };
    await executor.configureManagedTools(connection);
    expect(await executor.execute('Set a reminder')).toMatchObject({ success: true, output: 'tools=1' });
    const id = executor.getSessionId()!;
    await executor.destroy(); await executor.waitForExit();
    executor = new Constructor(new DirectoryGuard([directory]), options);
    executor.checkHostScheduleSession(id);
    expect(() => executor!.checkHostScheduleSession('other')).toThrow();
    await executor.configureManagedTools(connection);
    expect(await executor.execute('Scheduled', { hostScheduleSessionId: id })).toMatchObject({ success: true, output: 'tools=1' });
    const sessions = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(request => ['session/new', 'session/load', 'session/create', 'session/resume'].includes(request.method));
    expect(sessions).toHaveLength(2);
    expect(sessions[1].params.sessionId).toBe(id);
    for (const { params } of sessions) expect(params.mcpServers).toEqual([expect.objectContaining({
      command: process.execPath, env: expect.arrayContaining([{ name: 'REMOTE_CLI_TOOL_GROUPS', value: '["scheduling"]' }]),
    })]);
  });

  it.each(['missing', 'different receipt', 'pointer replaced', 'reset', 'aborted'])('refuses pinned ACP resume when %s', async failure => {
    const pointer = path.join(directory, 'test.json');
    fs.writeFileSync(pointer, JSON.stringify({ id: 'original', cwd: directory }));
    const transport = {
      initialize: vi.fn(async () => ({})),
      loadSession: vi.fn(async () => {
        if (failure === 'missing') throw new Error('Session not found');
        if (failure === 'different receipt') return { sessionId: 'other' };
        if (failure === 'pointer replaced') fs.writeFileSync(pointer, JSON.stringify({ id: 'other', cwd: directory }));
        if (failure === 'reset') executor!.resetContext();
        if (failure === 'aborted') await executor!.abort();
        return { sessionId: 'original' };
      }),
      newSession: vi.fn(), setConfigOption: vi.fn(), prompt: vi.fn(), destroy: vi.fn(),
    };
    executor = new OpenCodeExecutor(new DirectoryGuard([directory]), { initialWorkingDirectory: directory, model: 'selected',
      sessionBaseDir: directory, threadId: 'test', clientFactory: () => transport as any });
    expect(await executor.execute('Scheduled', { hostScheduleSessionId: 'original' })).toMatchObject({ success: false });
    expect(transport.newSession).not.toHaveBeenCalled();
    expect(transport.setConfigOption).not.toHaveBeenCalled();
    expect(transport.prompt).not.toHaveBeenCalled();
    if (failure !== 'reset') expect(JSON.parse(fs.readFileSync(pointer, 'utf8')).id).toBe(failure === 'pointer replaced' ? 'other' : 'original');
  });

  it('keeps a concurrent catalog query and a second wake from opening another session during pinned resume', async () => {
    fs.writeFileSync(path.join(directory, 'test.json'), JSON.stringify({ id: 'original', cwd: directory }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const transport = {
      initialize: vi.fn(async () => ({})),
      loadSession: vi.fn(async () => { await gate; return { sessionId: 'original' }; }),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })), destroy: vi.fn(),
    };
    const factory = vi.fn(() => transport as any);
    executor = new OpenCodeExecutor(new DirectoryGuard([directory]), { initialWorkingDirectory: directory,
      sessionBaseDir: directory, threadId: 'test', clientFactory: factory });
    const active = executor.execute('Scheduled', { hostScheduleSessionId: 'original' });
    await vi.waitFor(() => expect(transport.loadSession).toHaveBeenCalledOnce());
    try {
      await expect(executor.listModels()).rejects.toThrow(/scheduled turn/);
      await expect(executor.execute('Second wake', { hostScheduleSessionId: 'original' })).resolves.toMatchObject({ success: false });
    } finally { release(); }
    await expect(active).resolves.toMatchObject({ success: true });
    expect(factory).toHaveBeenCalledOnce();
    expect(transport.prompt).toHaveBeenCalledOnce();
  });

  it.each(['opencode', 'kimi', 'zcode'] as const)('registers, resumes, and removes %s tools without changing the session', async backend => {
    const log = path.join(directory, 'requests.jsonl');
    const factory = (callbacks: AcpEventCallbacks, cwd: string) => backend === 'zcode'
      ? new ZCodeClient({ cwd, launch: { command: process.execPath, args: [path.join(directory, 'server.cjs'), log], env: process.env } }, callbacks)
      : new AcpClient(process.execPath, [path.join(directory, 'server.cjs'), log], cwd, callbacks);
    const options = { initialWorkingDirectory: directory, sessionBaseDir: directory, threadId: 'test', clientFactory: factory };
    const Constructor = { opencode: OpenCodeExecutor, kimi: KimiExecutor, zcode: ZCodeExecutor }[backend];
    executor = new Constructor(new DirectoryGuard([directory]), options);
    expect(await executor.execute('Ordinary')).toMatchObject({ success: true, output: 'tools=0' });
    const session = executor.getSessionId();
    const first = { url: 'http://127.0.0.1:9999/', token: 'private-first' };
    await executor.configureDelegation(first);
    expect(await executor.execute('First')).toMatchObject({ success: true, output: 'tools=1' });
    await executor.configureDelegation({ ...first, token: 'private-second' });
    expect(await executor.execute('Resume')).toMatchObject({ success: true, output: 'tools=1' });
    await executor.configureDelegation(undefined);
    expect(await executor.execute('Disabled')).toMatchObject({ success: true, output: backend === 'zcode' ? 'tools=0' : 'OLD HISTORYtools=0' });
    expect(executor.getSessionId()).toBe(session);
    const requests = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const sessions = requests.filter(request => ['session/new', 'session/load', 'session/create', 'session/resume'].includes(request.method));
    expect(sessions).toHaveLength(4);
    expect(sessions[0].params.mcpServers).toEqual(backend === 'zcode' ? undefined : []);
    expect(sessions[1].params.mcpServers[0]).toMatchObject({ name: 'remote-cli-delegation', command: process.execPath,
      env: expect.arrayContaining([{ name: 'REMOTE_CLI_DELEGATION_TOKEN', value: 'private-first' }]) });
    expect(sessions[2].params).toMatchObject({ sessionId: session, mcpServers: [expect.objectContaining({
      env: expect.arrayContaining([{ name: 'REMOTE_CLI_DELEGATION_TOKEN', value: 'private-second' }]),
    })] });
    if (backend === 'zcode') expect(sessions[1].params.mcpServers[0]).toMatchObject({ isolation: 'session', timeoutMs: 35000 });
    expect(sessions[3].params.mcpServers).toEqual(backend === 'zcode' ? undefined : []);
    await executor.deleteThreadData('test');
    await executor.destroy(); await executor.waitForExit();
  });

  it('does not respawn a destroyed delegated worker to remove its session pointer', async () => {
    const log = path.join(directory, 'worker.jsonl');
    executor = new OpenCodeExecutor(new DirectoryGuard([directory]), {
      initialWorkingDirectory: directory, sessionBaseDir: directory, threadId: 'worker', delegationWorker: true,
      clientFactory: (callbacks, cwd) => new AcpClient(process.execPath, [path.join(directory, 'server.cjs'), log], cwd, callbacks, true),
    });
    await executor.execute('Worker');
    await executor.destroy(); await executor.waitForExit();
    const requestsBeforeDelete = fs.readFileSync(log, 'utf8');
    await executor.deleteThreadData('worker');
    expect(fs.readFileSync(log, 'utf8')).toBe(requestsBeforeDelete);
    expect(fs.existsSync(path.join(directory, 'worker.json'))).toBe(false);
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

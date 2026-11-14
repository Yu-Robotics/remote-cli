import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import registerPiTools from '../../src/delegation/piExtension';
import { DelegationBridge } from '../../src/delegation/DelegationBridge';
import { buildPiRpcArgs } from '../../src/executor/pi/PiTypes';
import { DELEGATION_INSTRUCTIONS, DELEGATION_TOOLS } from '../../src/delegation/contract';
import { SCHEDULE_TOOLS } from '../../src/scheduling/toolContract';
import { ScheduleToolOperations } from '../../src/scheduling/ScheduleToolScope';

describe('native delegation tool adapters', () => {
  let bridge: DelegationBridge;
  let retire: () => void;
  let directory: string;
  let child: ChildProcessWithoutNullStreams | undefined;
  let connection: { url: string; token: string };
  const pending = new Map<number, (response: any) => void>();

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-adapter-')));
    bridge = new DelegationBridge(); connection = await bridge.start();
    retire = bridge.activate(async (name, args) => ({ name, args, marker: 'ok' }));
  });
  afterEach(async () => {
    if (child) {
      child.stdin.end();
      await new Promise<void>(resolve => { if (child!.exitCode !== null) resolve(); else child!.once('close', () => resolve()); });
      child = undefined;
    }
    await bridge.close(); vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(['delegation', 'scheduling'] as const)('exposes %s through real MCP stdio and preserves Unicode split across frames', async group => {
    connection = await bridge.start([group]);
    for (const file of ['delegation/contract', 'delegation/mcpServer', 'managed/tools', 'scheduling/toolContract']) {
      const source = await fs.readFile(path.join(__dirname, '../../src', `${file}.ts`), 'utf8');
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
      await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await fs.writeFile(path.join(directory, `${file}.js`), compiled);
    }
    child = spawn(process.execPath, [path.join(directory, 'delegation/mcpServer.js')], {
      env: { ...process.env, REMOTE_CLI_TOOL_GROUPS: JSON.stringify([group]), REMOTE_CLI_DELEGATION_URL: connection.url, REMOTE_CLI_DELEGATION_TOKEN: connection.token },
      stdio: 'pipe',
    });
    let buffer = '';
    child.stdout.on('data', data => {
      buffer += data.toString(); let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        pending.get(message.id)?.(message.result); pending.delete(message.id);
      }
    });
    const request = (id: number, method: string, params = {}) => new Promise<any>(resolve => {
      pending.set(id, resolve); child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    child.stdin.write('null\nnot-json\n');
    expect(await request(1, 'initialize', { protocolVersion: '2024-11-05' })).toMatchObject({ capabilities: { tools: {} } });
    const tools = await request(2, 'tools/list');
    if (group === 'scheduling') {
      expect(tools.tools).toEqual(SCHEDULE_TOOLS);
      const run = vi.fn(async () => []);
      const scope = new ScheduleToolOperations().scope({ owner: { threadId: 'thread', openId: 'owner', generation: 'current' },
        messageId: 'foreground', backend: 'dsh', current: () => true, run, present: async () => 'Delivered' });
      retire = bridge.activate((name, args) => scope.invoke(name, args));
      const args = { requestId: 'native-request', when: { kind: 'after', amount: 5, unit: 'm' }, prompt: 'Synthetic task' };
      const first = await request(3, 'tools/call', { name: 'remote_cli_schedule_create', arguments: args });
      expect(JSON.parse(first.content[0].text)).toMatchObject({ status: 'succeeded' });
      expect(await request(4, 'tools/call', { name: 'remote_cli_schedule_create', arguments: args })).toEqual(first);
      expect(run).toHaveBeenCalledOnce();
      await scope.close(); return;
    }
    expect(tools.tools.map((tool: any) => tool.name)).toContain('remote_cli_delegate');
    const delegate = tools.tools.find((tool: any) => tool.name === 'remote_cli_delegate');
    expect(delegate.description).toBe(DELEGATION_TOOLS.find(tool => tool.name === 'remote_cli_delegate')!.description);
    expect(delegate.description).toContain('including the coordinator backend');
    expect(delegate.description).toContain('independent sessions, never the coordinator conversation');
    expect(delegate.inputSchema.properties.mode.description).toContain('Sandboxed coordinators cannot launch managed workers');
    expect(DELEGATION_INSTRUCTIONS).toContain('including the coordinator backend');
    expect(DELEGATION_INSTRUCTIONS).toContain('Workers cannot delegate recursively');
    expect(delegate.description).toContain('nested Git metadata/history');
    expect(delegate.description).toContain('Uninitialized submodule paths remain empty');
    const response = new Promise<any>(resolve => pending.set(3, resolve));
    const encoded = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'remote_cli_delegate', arguments: { backend: 'pi', objective: 'Read \u00e9vidence' } } }) + '\n');
    const split = encoded.indexOf(Buffer.from('\u00e9')) + 1;
    child.stdin.write(encoded.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 10));
    child.stdin.write(encoded.subarray(split));
    const result = await response;
    expect(JSON.parse(result.content[0].text).args.objective).toBe('Read \u00e9vidence');
    const malformedArgs = await request(5, 'tools/call', { name: 'remote_cli_delegate', arguments: [] });
    expect(JSON.parse(malformedArgs.content[0].text).args).toEqual({});
    retire();
    expect(await request(4, 'tools/call', { name: 'remote_cli_list_backends', arguments: {} })).toMatchObject({ isError: true });
  });

  it('adds Pi tools without disabling its built-in tools and propagates cancellation', async () => {
    vi.stubEnv('REMOTE_CLI_TOOL_GROUPS', '');
    vi.stubEnv('REMOTE_CLI_DELEGATION_URL', connection.url);
    vi.stubEnv('REMOTE_CLI_DELEGATION_TOKEN', connection.token);
    const tools: any[] = [];
    registerPiTools({ registerTool: (tool: unknown) => tools.push(tool) });
    expect(tools).toHaveLength(5);
    expect(tools.some(tool => tool.name === 'remote_cli_integrate')).toBe(true);
    expect(tools.find(tool => tool.name === 'remote_cli_delegate').description)
      .toBe(DELEGATION_TOOLS.find(tool => tool.name === 'remote_cli_delegate')!.description);
    const result = await tools[0].execute('list', {});
    expect(JSON.parse(result.content[0].text).marker).toBe('ok');
    const controller = new AbortController(); controller.abort();
    await expect(tools[0].execute('cancelled', {}, controller.signal)).rejects.toThrow();
    const launch = buildPiRpcArgs({ delegation: connection });
    expect(launch.args).toContain('--extension');
    expect(launch.args).not.toContain('--no-builtin-tools');
    retire();
    await expect(tools[0].execute('expired', {})).rejects.toThrow('No active');
  });

  it('registers only scheduling on Pi when delegation is disabled', async () => {
    connection = await bridge.start(['scheduling']);
    vi.stubEnv('REMOTE_CLI_TOOL_GROUPS', '["scheduling"]');
    vi.stubEnv('REMOTE_CLI_DELEGATION_URL', connection.url);
    vi.stubEnv('REMOTE_CLI_DELEGATION_TOKEN', connection.token);
    const tools: any[] = [];
    registerPiTools({ registerTool: tool => tools.push(tool) });
    expect(tools.map(tool => tool.name)).toEqual(SCHEDULE_TOOLS.map(tool => tool.name));
    const result = await tools[0].execute('capabilities', {});
    expect(JSON.parse(result.content[0].text)).toMatchObject({ name: 'remote_cli_schedule_capabilities' });
  });
});

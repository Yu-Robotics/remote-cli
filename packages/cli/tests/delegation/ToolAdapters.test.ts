import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import registerPiTools from '../../src/delegation/piExtension';
import { DelegationBridge } from '../../src/delegation/DelegationBridge';
import { buildPiRpcArgs } from '../../src/executor/pi/PiTypes';

describe('native delegation tool adapters', () => {
  let bridge: DelegationBridge;
  let directory: string;
  let child: ChildProcessWithoutNullStreams | undefined;
  let connection: { url: string; token: string };
  const pending = new Map<number, (response: any) => void>();

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-adapter-'));
    bridge = new DelegationBridge(); connection = await bridge.start();
    bridge.activate(async (name, args) => ({ name, args, marker: 'ok' }));
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

  it('exposes the same tools through real MCP stdio and preserves Unicode split across frames', async () => {
    for (const file of ['contract', 'mcpServer']) {
      const source = await fs.readFile(path.join(__dirname, '../../src/delegation', `${file}.ts`), 'utf8');
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
      await fs.writeFile(path.join(directory, `${file}.js`), compiled);
    }
    child = spawn(process.execPath, [path.join(directory, 'mcpServer.js')], {
      env: { ...process.env, REMOTE_CLI_DELEGATION_URL: connection.url, REMOTE_CLI_DELEGATION_TOKEN: connection.token },
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
    expect(tools.tools.map((tool: any) => tool.name)).toContain('remote_cli_delegate');
    const response = new Promise<any>(resolve => pending.set(3, resolve));
    const encoded = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'remote_cli_delegate', arguments: { backend: 'pi', objective: 'Read \u00e9vidence' } } }) + '\n');
    const split = encoded.indexOf(Buffer.from('\u00e9')) + 1;
    child.stdin.write(encoded.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 10));
    child.stdin.write(encoded.subarray(split));
    const result = await response;
    expect(JSON.parse(result.content[0].text).args.objective).toBe('Read \u00e9vidence');
    bridge.activate(undefined);
    expect(await request(4, 'tools/call', { name: 'remote_cli_list_backends', arguments: {} })).toMatchObject({ isError: true });
  });

  it('adds Pi tools without disabling its built-in tools and propagates cancellation', async () => {
    vi.stubEnv('REMOTE_CLI_DELEGATION_URL', connection.url);
    vi.stubEnv('REMOTE_CLI_DELEGATION_TOKEN', connection.token);
    const tools: any[] = [];
    registerPiTools({ registerTool: (tool: unknown) => tools.push(tool) });
    expect(tools).toHaveLength(4);
    const result = await tools[0].execute('list', {});
    expect(JSON.parse(result.content[0].text).marker).toBe('ok');
    const controller = new AbortController(); controller.abort();
    await expect(tools[0].execute('cancelled', {}, controller.signal)).rejects.toThrow();
    const launch = buildPiRpcArgs({ delegation: connection });
    expect(launch.args).toContain('--extension');
    expect(launch.args).not.toContain('--no-builtin-tools');
    bridge.activate(undefined);
    await expect(tools[0].execute('expired', {})).rejects.toThrow('No active');
  });
});

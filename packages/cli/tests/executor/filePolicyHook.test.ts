import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn } from 'child_process';
import ts from 'typescript';

describe('Claude file policy hook protocol', () => {
  let root: string;
  let socketPath: string;
  let script: string;
  let server: net.Server;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join('/tmp', 'file-hook-'));
    socketPath = path.join(root, 'policy.sock');
    script = path.join(root, 'hook.cjs');
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/executor/claude/filePolicyHook.ts'), 'utf8');
    fs.writeFileSync(script, ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText);
    server = net.createServer();
  });
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function run(event: unknown) {
    const child = spawn(process.execPath, [script, socketPath, 'test-token']);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(JSON.stringify(event));
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    return { code, stdout, stderr };
  }
  async function listen(answer: unknown, check?: (request: any) => void) {
    server.on('connection', socket => {
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        check?.(JSON.parse(buffer));
        socket.end(JSON.stringify(answer) + '\n');
      });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
  }

  it.each(['allow', 'ask', 'deny'])('returns a native %s decision without forwarding file contents', async decision => {
    let request: any;
    await listen({ decision, reason: 'test policy' }, value => { request = value; });
    const result = await run({ hook_event_name: 'PreToolUse', tool_name: 'Write',
      tool_input: { file_path: '/project/file', content: 'private content' } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision } });
    expect(request).toEqual({ type: 'file_policy', token: 'test-token', startup: false, tool_name: 'Write', input: { file_path: '/project/file' } });
  });

  it('acknowledges session startup without injecting model context', async () => {
    await listen({ decision: 'allow' });
    expect(await run({ hook_event_name: 'SessionStart' })).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('blocks a tool when the policy channel is unavailable or returns invalid data', async () => {
    const event = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/project/file' } };
    expect((await run(event)).code).toBe(2);
    await listen({ behavior: 'allow' });
    const result = await run(event);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
  });
});

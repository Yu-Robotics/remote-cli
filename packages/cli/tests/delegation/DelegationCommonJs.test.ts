import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { createServer } from 'http';
import { once } from 'events';
import { WebSocketServer } from 'ws';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execute = promisify(execFile);

describe('published CommonJS delegation runtime', () => {
  let directory: string;
  let output: string;

  beforeAll(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-commonjs-')));
    output = path.join(directory, 'dist');
    const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../package.json'), 'utf8'));
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'commonjs', version: manifest.version }));
    await execute(process.execPath, [require.resolve('typescript/bin/tsc'),
      '--project', path.resolve(__dirname, '../../tsconfig.json'), '--outDir', output,
      '--declaration', 'false', '--declarationMap', 'false', '--sourceMap', 'false'],
    { timeout: 90_000, maxBuffer: 1024 * 1024 });
  }, 100_000);

  afterAll(async () => {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it('lists backends, validates exports, and completes a delegated task through compiled modules', async () => {
    const home = path.join(directory, 'home');
    await fs.mkdir(home);
    const runner = path.join(directory, 'runner.cjs');
    await fs.writeFile(runner, `
const assert = require('assert/strict');
const os = require('os');
const path = require('path');
const home = process.argv[2];
os.homedir = () => home;
const { DelegationManager, DELEGATION_LIMITS } = require('./dist/delegation/DelegationManager');
const { BackendRegistry } = require('./dist/delegation/BackendRegistry');
const { DirectoryGuard } = require('./dist/security/DirectoryGuard');
const guard = new DirectoryGuard([home]);
let executions = 0;
const worker = {
  execute: async () => { executions++; return { success: true, output: 'Synthetic compiled worker result' }; },
  abort: async () => true, destroy: async () => {}, waitForExit: async () => {},
  waitForManagedProcessGroupExit: async () => {}, deleteThreadData: async () => {}, resetContext: () => {},
  getCurrentWorkingDirectory: () => home, setWorkingDirectory: () => true,
};
const manager = new DelegationManager(guard, () => worker, new BackendRegistry(async () => 'fixture 1.0'));
const scope = manager.begin({
  thread: { id: 'fixture-parent', name: 'default', workingDirectory: home, sessionId: null, createdAt: 0, lastActiveAt: 0 },
  cwd: home, messageId: 'fixture-message', backend: 'codex', config: { type: 'codex' },
  routerVersion: () => '1.6.191', onToolUse: () => {}, onToolResult: () => {}, onNotice: () => {},
});
(async () => {
  try {
    const listed = await scope.invoke('remote_cli_list_backends', {}, 'list');
    assert.equal(listed.maxTasksPerRequest, DELEGATION_LIMITS.launches);
    assert.equal(listed.scheduling, 'serial');
    assert.ok(listed.backends.some(item => item.backend === 'codex' && item.worker));
    await assert.rejects(scope.invoke('remote_cli_delegate', {
      backend: 'codex', objective: 'Synthetic export validation', exports: ['../outside'],
    }, 'invalid-exports'), /relative checkout file paths/);
    await assert.rejects(scope.invoke('remote_cli_delegate', {
      backend: 'codex', objective: 'Synthetic non-Git export validation', exports: ['report.txt'],
    }, 'non-git-exports'), /isolated Git worktree/);
    assert.equal(executions, 0);
    const task = await scope.invoke('remote_cli_delegate', {
      backend: 'codex', objective: 'Synthetic compiled task', exports: [],
    }, 'delegate');
    const result = await scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result');
    assert.equal(result.state, 'succeeded');
    assert.equal(result.output, 'Synthetic compiled worker result');
    assert.equal(executions, 1);
    console.log('COMMONJS_RESULT=' + JSON.stringify({ listed: true, exportsValidated: true, completed: true }));
  } finally { await scope.close(); await manager.destroy(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
    const nodePath = [path.resolve(__dirname, '../../node_modules'), path.resolve(__dirname, '../../../../node_modules'),
      process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    const result = await execute(process.execPath, [runner, home], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, NODE_PATH: nodePath },
      timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    expect(result.stdout).toContain('COMMONJS_RESULT={"listed":true,"exportsValidated":true,"completed":true}');
  }, 40_000);

  it.skipIf(process.platform === 'win32')('restarts the compiled CLI after graceful signals and SIGKILL without moving ownership files', async () => {
    const home = path.join(directory, 'signal-home');
    const configDirectory = path.join(home, '.remote-cli');
    await fs.mkdir(configDirectory, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../package.json'), 'utf8'));
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, version: manifest.version }));
    });
    const websocket = new WebSocketServer({ server });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic Router did not bind a TCP port');
    await fs.writeFile(path.join(configDirectory, 'config.json'), JSON.stringify({
      deviceId: 'fixture-shutdown-device', serverUrl: `http://127.0.0.1:${address.port}`,
      security: { allowedDirectories: [home] },
      executor: { type: 'pi', pi: { command: process.execPath } },
      maintenance: { updateNotice: false, subscriptionInspection: false },
    }));
    const bootstrap = path.join(directory, 'isolated-home.cjs');
    await fs.writeFile(bootstrap, "require('os').homedir = () => process.env.HOME;\n");
    const nodePath = [path.resolve(__dirname, '../../node_modules'), path.resolve(__dirname, '../../../../node_modules'),
      process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    let child: ChildProcess | undefined;
    try {
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGTERM'] as const) {
        let text = '';
        child = spawn(process.execPath, ['--require', bootstrap, path.join(output, 'index.js'), 'start', '--non-interactive'], {
          cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, NODE_PATH: nodePath }, stdio: 'pipe',
        });
        const closed = once(child, 'close');
        child.stdout!.on('data', chunk => { text += chunk.toString(); });
        child.stderr!.on('data', chunk => { text += chunk.toString(); });
        for (let attempt = 0; !text.includes('Service started successfully!'); attempt++) {
          if (attempt >= 400 || child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`Synthetic CLI startup failed: ${text.slice(-3000)}`);
          }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        const lock = path.join(configDirectory, 'delegation-workers.ownership');
        expect(JSON.parse(await fs.readFile(lock, 'utf8')).pid).toBe(child.pid);
        child.kill(signal);
        const [code, terminationSignal] = await closed;
        child = undefined;
        if (signal === 'SIGKILL') {
          expect(terminationSignal).toBe('SIGKILL');
          expect((await fs.lstat(lock)).isFile()).toBe(true);
        } else {
          expect({ code, terminationSignal }).toEqual({ code: 0, terminationSignal: null });
          await expect(fs.lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
        }
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
      }
      for (const client of websocket.clients) client.terminate();
      await new Promise<void>((resolve, reject) => websocket.close(error => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 40_000);
});

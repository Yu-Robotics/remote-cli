import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fork, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { HostClient } from '../src/sessionHost/HostClient';
import type { FrontendLease, HostAddress } from '../src/sessionHost/HostProtocol';

let root: string;
const children: ChildProcess[] = [];
const clients: HostClient[] = [];
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-host-process-'))); });
afterEach(async () => {
  clients.splice(0).forEach(client => client.close());
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const deadline = setTimeout(() => child.kill(), 5000);
    child.once('exit', () => { clearTimeout(deadline); resolve(); });
    if (child.connected) child.disconnect(); else child.kill();
  })));
  fs.rmSync(root, { recursive: true, force: true });
});
function exchange(child: ChildProcess, command: object, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Synthetic process response timed out')), 10_000);
    const exit = () => finish(new Error('Synthetic process exited before response'));
    const message = (value: any) => {
      if (value?.type === 'error') finish(new Error('Synthetic process failed'));
      else if (value?.type === type) finish(undefined, value);
    };
    const finish = (error?: Error, value?: any) => {
      clearTimeout(timer); child.off('message', message); child.off('exit', exit);
      if (error) reject(error); else resolve(value);
    };
    child.on('message', message); child.once('exit', exit); child.send(command);
  });
}
function launch(name: string, body: string): ChildProcess {
  const file = path.join(root, name + '.cjs');
  // Compile only repository TypeScript in the disposable test process. The
  // fixture does not depend on a stale dist/ build or run a backend executable.
  fs.writeFileSync(file, `
const ts = require(${JSON.stringify(require.resolve('typescript'))});
const fs = require('fs');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, filename);
${body}
`);
  const child = fork(file, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_PATH: process.env.NODE_PATH,
  } });
  child.stderr?.resume(); children.push(child); return child;
}
const hostModule = path.resolve(__dirname, '../src/sessionHost/HostServer.ts');
const clientModule = path.resolve(__dirname, '../src/sessionHost/HostClient.ts');
function hostProcess() {
  return launch('host-' + randomBytes(4).toString('hex'), `
const { HostServer } = require(${JSON.stringify(hostModule)});
const { spawn } = require('child_process');
let host, native, resolveWork, calls = 0;
process.on('message', async message => {
 try {
  if (message.type === 'start') {
   if (message.native !== false) native = spawn(process.execPath, ['-e',
     "process.on('message', m => { if(m === 'finish') process.send({output:'retained synthetic output'}); if(m === 'stop') process.exit(0); }); process.on('disconnect',()=>process.exit(0));"
   ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
   native?.on('message', value => { if(resolveWork) { const finish=resolveWork; resolveWork=undefined; finish(value); } });
   host = new HostServer({ directory: message.directory, installationId: 'synthetic-installation', secret: message.secret,
    runtime: { authorityId: 'native-like-owner',
     execute: async () => { calls++; return new Promise(resolve => { resolveWork=resolve; }); },
     stop: async () => { if(resolveWork) { resolveWork(null); resolveWork=undefined; }
      if(native && native.exitCode === null) await new Promise(resolve => { native.once('exit', resolve); native.send('stop'); }); }
    }});
   const address = await host.listen(); process.send({type:'started', address, nativePid:native?.pid});
  } else if(message.type === 'release') { native.send('finish'); process.send({type:'released'}); }
  else if(message.type === 'stats') process.send({type:'stats', calls, nativePid:native?.pid, nativeAlive:!!native && native.exitCode === null});
  else if(message.type === 'stop') { await host.stop(); process.send({type:'stopped'}, ()=>process.exit(0)); }
 } catch { process.send({type:'error'}); }
});
process.on('disconnect', async () => { if(host) await host.stop(); process.exit(0); });
`);
}
function connect(address: HostAddress, key: string) { const c = new HostClient(address, key); clients.push(c); return c; }
async function bootLease(client: HostClient) {
  const { epoch } = await client.hello();
  const { attachment } = await client.attach('frontend-b', epoch);
  return client.activate('frontend-b', epoch, attachment);
}

it('retains the same synthetic native process across frontend process exit and transfers an accepted result exactly once', async () => {
  const key = randomBytes(32).toString('hex'); const directory = path.join(root, 'catalog');
  const host = hostProcess();
  const started = await exchange(host, { type: 'start', directory, secret: key }, 'started');
  const frontend = launch('frontend', `
const { HostClient } = require(${JSON.stringify(clientModule)});
process.once('message', async m => {
 try {
  const a = new HostClient(m.address, m.secret);
  const { epoch } = await a.hello(); const { attachment } = await a.attach('frontend-a', epoch);
  const lease = await a.activate('frontend-a', epoch, attachment);
  await a.submit(lease, 'retained-operation', 'synthetic-run', {value:1});
  const ticket = await a.prepare(lease, 'frontend-b');
  a.close(); process.send({type:'prepared', lease, ticket}, ()=>process.exit(0));
 } catch { process.send({type:'error'}, ()=>process.exit(1)); }
});
`);
  const prepared = await exchange(frontend, { address: started.address, secret: key }, 'prepared');
  await vi.waitFor(() => expect(frontend.exitCode).toBe(0));
  const b = connect(started.address, key);
  const { attachment } = await b.attach('frontend-b', prepared.lease.epoch, prepared.ticket.ticket);
  const lease = await b.activate('frontend-b', prepared.lease.epoch, attachment);
  expect((await b.submit(lease, 'retained-operation', 'synthetic-run', { value: 1 })).status).toBe('pending');
  await expect(b.submit(prepared.lease, 'late-old-frame', 'synthetic-run', null)).rejects.toThrow('stale_lease');
  const stats = await exchange(host, { type: 'stats' }, 'stats');
  expect(stats).toMatchObject({ calls: 1, nativePid: started.nativePid, nativeAlive: true });
  await exchange(host, { type: 'release' }, 'released');
  await vi.waitFor(async () => expect((await b.status(lease, 'retained-operation')).status).toBe('completed'));
  const events = await b.events(lease, 0);
  expect(events.events).toHaveLength(1);
  expect(events.events[0]).toMatchObject({ result: { output: 'retained synthetic output' } });
  b.close(); const reconnect = connect(started.address, key);
  expect(await reconnect.events(lease, 0)).toEqual(events);
  await reconnect.ack(lease, events.through);
  expect((await reconnect.events(lease, events.through)).events).toEqual([]);
  expect(await exchange(host, { type: 'stats' }, 'stats')).toMatchObject({ calls: 1, nativePid: started.nativePid, nativeAlive: true });
  await exchange(host, { type: 'stop' }, 'stopped');
}, 30_000);

it('excludes a second writer and converts crash-pending work into durable uncertainty without redispatch', async () => {
  const key = randomBytes(32).toString('hex'); const directory = path.join(root, 'catalog');
  const host = hostProcess(); const started = await exchange(host, { type: 'start', directory, secret: key, native: false }, 'started');
  const a = connect(started.address, key); const lease = await bootLease(a);
  await a.submit(lease, 'crash-pending', 'synthetic-run', null);
  const contender = launch('contender', `
const { HostServer } = require(${JSON.stringify(hostModule)});
process.once('message', m => {
 try { new HostServer({directory:m.directory, installationId:'synthetic-installation', secret:m.secret,
  runtime:{authorityId:'other-owner',execute:async()=>null,stop:async()=>{}}}); process.send({type:'unexpected'}); }
 catch(e) { process.send({type:'excluded', code:e.code}, ()=>process.exit(0)); }
});
`);
  expect(await exchange(contender, { directory, secret: key }, 'excluded')).toMatchObject({ code: 'host_already_owned' });
  await new Promise<void>(resolve => { host.once('exit', () => resolve()); host.kill('SIGKILL'); });
  // This crash fixture deliberately has no native child. Catalog recovery cannot
  // prove retirement of a real native host or safely launch its successor.
  const successor = hostProcess(); const next = await exchange(successor, { type: 'start', directory, secret: key, native: false }, 'started');
  const b = connect(next.address, key); const lease2 = await bootLease(b);
  expect(lease2.epoch).toBeGreaterThan(lease.epoch);
  expect(await b.submit(lease2, 'crash-pending', 'synthetic-run', null)).toMatchObject({ status: 'unknown', error: 'host_restarted' });
  expect((await b.events(lease2, 0)).events[0]).toMatchObject({ status: 'unknown', requestId: 'crash-pending' });
  expect(await exchange(successor, { type: 'stats' }, 'stats')).toMatchObject({ calls: 0 });
  await exchange(successor, { type: 'stop' }, 'stopped');
}, 30_000);

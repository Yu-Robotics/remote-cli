import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fork, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { HostClient } from '../src/sessionHost/HostClient';

let root: string;
const children: ChildProcess[] = [];
let counter = 0;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retained-product-'))); });
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timeout = setTimeout(() => child.kill(), 5000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    if (child.connected) child.disconnect(); else child.kill();
  })));
  fs.rmSync(root, { recursive: true, force: true });
});
function rpc(child: ChildProcess, body: object): Promise<any> {
  const id = ++counter;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Synthetic process did not respond')), 15_000);
    const exited = () => finish(new Error('Synthetic process exited'));
    const receive = (value: any) => { if (value.id === id) finish(value.error ? new Error(value.error) : undefined, value.value); };
    const finish = (error?: Error, value?: any) => { clearTimeout(timer); child.off('message', receive); child.off('exit', exited); error ? reject(error) : resolve(value); };
    child.on('message', receive); child.once('exit', exited); child.send({ ...body, id }, error => { if (error) finish(error); });
  });
}
function launch(name: string, source: string): ChildProcess {
  const filename = path.join(root, name + '.cjs');
  fs.writeFileSync(filename, `
const ts = require(${JSON.stringify(require.resolve('typescript'))});
const fs = require('fs');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
 compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, filename);
${source}`);
  const child = fork(filename, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_PATH: process.env.NODE_PATH,
  } });
  child.stderr?.resume(); children.push(child); return child;
}
function moduleFile(name: string) { return JSON.stringify(path.resolve(__dirname, '../src/sessionHost', name + '.ts')); }
function hostProcess() {
  return launch('retained-host', `
const { HostServer } = require(${moduleFile('HostServer')});
const { RetainedRuntime } = require(${moduleFile('RetainedRuntime')});
const { fork } = require('child_process');
const path = require('path');
let host, runtime, native, directory, owners = [], jobs = new Map(), pending, calls = 0, connection;
let messageListener, ackListeners = [], closeListeners = [], sent = [], connected = true, autoAck = false;
const router = { onMessage: fn => { messageListener=fn; }, onTaskResultAck: fn => { ackListeners.push(fn); return ()=>{}; },
 onClose: fn => { closeListeners.push(fn); return ()=>{}; }, isConnected:()=>connected,
 connect:async()=>binding(), disconnect:()=>{connected=false;closeListeners.forEach(fn=>fn());},
 send:message=>{sent.push(message);if(autoAck && message.type==='response')ackListeners.forEach(fn=>fn(message.messageId));return connected;} };
function binding(){ connected=true; messageListener({type:'binding_confirm',data:{success:true,capabilities:{taskRecovery:true,scheduleResultsV1:true}}}); }
let nativeSerial=0; const nativeWaiters=new Map();
function nativeCall(type, extra={}) { return new Promise((resolve,reject)=>{ const id=++nativeSerial; nativeWaiters.set(id,{resolve,reject}); native.send({id,type,...extra}); }); }
const executor={ configureManagedTools:async value=>{connection=value;},isBusy:()=>!!pending,
 withNativeScheduleOperation:async(_id,_current,run)=>{ calls++;return run(); },
 execute:async prompt=>{ await nativeCall('begin'); return new Promise(resolve=>{pending=resolve;}); },
 createNativeSchedule:async(input,emit,current,admit)=>{
  const result=await nativeCall('create',{task:input.id}); jobs.set(input.id,{emit,current,admit});
  return {nativeId:result.task,cancellationKeepsRunning:true,retirementConfirmed:true,nativeDefinitionAbsent:true,
    list:async()=>jobs.has(input.id),cancel:async()=>{await nativeCall('cancel',{task:input.id});jobs.delete(input.id);},stop:async()=>{}};
 },getCurrentWorkingDirectory:()=>directory,getSessionId:()=> 'synthetic-original-session',destroy:async()=>{},waitForExit:async()=>{} };
const pool={getExecutor:()=>executor,getExistingExecutor:()=>executor,isThreadBusy:()=>!!pending,
 getBackendKey:()=> 'agy',getSummaries:()=>owners,destroyAll:async()=>{} };
const threads={getThread:id=>owners.find(row=>row.id===id),createThread:async(name,cwd,backend)=>{
 const thread={id:'thread-'+owners.length,name,workingDirectory:cwd,backend};owners.push(thread);return thread;
}};
async function shutdown(){
 if(native && native.exitCode===null) await new Promise(resolve=>{ native.once('exit',resolve);native.send({type:'stop'}); });
 if(pending){pending({success:false,error:'Synthetic teardown'});pending=undefined;}
 // Normal success explicitly cancels through the runtime before reaching here.
 if(host) await host.stop().catch(()=>{});
}
process.on('message', async message=>{
 try { let value;
 if(message.type==='start') {
  directory=message.directory;
  const nativeFile=path.join(directory,'synthetic-native.cjs');
  fs.writeFileSync(nativeFile, \`let tasks=new Set(),creates=0,turns=0;
process.on('message',m=>{
 if(m.type==='stop')return process.exit(0);
 if(m.type==='create'){tasks.add(m.task);creates++;}
 if(m.type==='cancel')tasks.delete(m.task);
 if(m.type==='begin')turns++;
 if(m.type==='fire'){process.send({event:'wake',task:m.task,occurrence:m.occurrence});return;}
 if(m.type==='finish'){process.send({event:'finished'});}
 process.send({id:m.id,task:m.task,pid:process.pid,session:'synthetic-original-session',tasks:[...tasks],creates,turns});
});process.on('disconnect',()=>process.exit(0));\`);
  native=fork(nativeFile,[],{stdio:['ignore','ignore','ignore','ipc'],env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot}});
  native.on('message', async event=>{
   if(event.event==='wake') {
    const job=jobs.get(event.task);
    if(!job || !job.current() || !job.admit()) return;
    await job.emit({type:'started',occurrenceId:event.occurrence});
    await job.emit({type:'completed',occurrenceId:event.occurrence,success:true,output:'native output '+event.occurrence});
   } else if(event.event==='finished'){const finish=pending;pending=undefined;finish?.({success:true,output:'original foreground result'});}
   else {nativeWaiters.get(event.id)?.resolve(event);nativeWaiters.delete(event.id);}
  });
  runtime=new RetainedRuntime({directory:path.join(directory,'runtime'),runtimeVersion:'1.6.247',config:{type:'agy'},threads,pool,
    guard:{resolveWorkingDirectory:input=>input},router});
  const control=path.join(directory,'control');
  host=new HostServer({directory:control,secret:message.secret,launcherSecret:message.launcherSecret,installationId:'process-fixture',runtime});
  await runtime.start(); value={address:await host.listen(),secret:message.secret,launcherSecret:message.launcherSecret,directory:control};
 } else if(message.type==='command'){messageListener(message.frame);value=true;}
 else if(message.type==='stats'){value={native:await nativeCall('stats'),calls,owners:runtime.journal.snapshot().owners,
  pending:!!pending,sent,commands:runtime.journal.snapshot().commands,connection};}
 else if(message.type==='fire'){native.send({type:'fire',task:message.task,occurrence:message.occurrence});value=true;}
 else if(message.type==='finish'){value=await nativeCall('finish');}
 else if(message.type==='reconnect'){router.disconnect();binding();value=true;}
 else if(message.type==='ackAll'){autoAck=true;sent.filter(row=>row.type==='response').forEach(row=>ackListeners.forEach(fn=>fn(row.messageId)));value=true;}
 else if(message.type==='ack'){ackListeners.forEach(fn=>fn(message.messageId));value=true;}
 else if(message.type==='stop'){await shutdown();process.send({id:message.id,value:true},()=>process.exit(0));return;}
 process.send({id:message.id,value});
 }catch(error){process.send({id:message.id,error:error.message});}
});
process.on('disconnect',()=>{void shutdown().finally(()=>process.exit(0));});
`);
}
function frontendProcess(name: string) {
  return launch(name, `
const { RetainedFrontend, retainedIntent }=require(${moduleFile('RetainedFrontend')});
let frontend;
process.on('message', async message=>{try{let value;
 if(message.type==='start'){
 frontend=new RetainedFrontend({connect:async()=>message.connection},message.version,
  (row,state,version)=>row.command==='/frontend-probe'?{context:null,intent:{kind:'reply',output:'dispatch '+version}}:retainedIntent(row,state,version));
 await frontend.start(60000);value={lease:frontend.lease,status:frontend.status()};
 } else if(message.type==='tick'){await frontend.tick();value=frontend.status();}
 else if(message.type==='prepare'){value=frontend.tryBeginAutomaticUpdate();await frontend.prepareAutomaticUpdate();}
 else if(message.type==='stop'){await frontend.close();process.send({id:message.id,value:true},()=>process.exit(0));return;}
 process.send({id:message.id,value});
 }catch(error){process.send({id:message.id,error:error.message});}});
process.on('disconnect',()=>{void frontend?.close().finally(()=>process.exit(0));});
`);
}

it('replaces a crashed product frontend without recreating native tasks, calls or queues, and replays only output', async () => {
  const host = hostProcess();
  const connection = await rpc(host, { type: 'start', directory: root, secret: randomBytes(32).toString('hex'), launcherSecret: randomBytes(32).toString('hex') });
  const a = frontendProcess('frontend-a');
  const first = await rpc(a, { type: 'start', connection, version: '1.6.248' });
  const stats = () => rpc(host, { type: 'stats' });
  async function command(front: ChildProcess, content: string, threadId?: string) {
    const messageId = `external-${++counter}`;
    await rpc(host, { type: 'command', frame: { type: 'command', messageId, openId: 'synthetic-owner', content, threadId } });
    await rpc(front, { type: 'tick' });
    let response: any;
    await vi.waitFor(async () => { response = (await stats()).sent.find((row: any) => row.type === 'response' && row.messageId === messageId); expect(response, 'Response for ' + content.split(' ').slice(0, 2).join(' ')).toBeTruthy(); }, { timeout: 10_000 });
    await rpc(host, { type: 'ack', messageId }); return response;
  }
  const created = await command(a, `/thread new retained agy ${root}`); expect(created.success).toBe(true);
  const threadId = created.threadId;
  expect((await command(a, '/schedule after 60m -- once', threadId)).success).toBe(true);
  expect((await command(a, '/schedule cron "* * * * *" --tz UTC -- recurring', threadId)).success).toBe(true);
  const before = await stats(); expect(before.native.creates).toBe(2);
  await rpc(host, { type: 'command', frame: { type: 'command', messageId: 'held-foreground', openId: 'synthetic-owner', threadId, content: 'held foreground' } });
  await rpc(a, { type: 'tick' });
  await vi.waitFor(async () => expect((await stats()).pending).toBe(true));
  await rpc(a, { type: 'prepare' });
  await new Promise<void>(resolve => { a.once('exit', () => resolve()); a.kill(); });
  await rpc(host, { type: 'fire', task: before.native.tasks[0], occurrence: 'once-original' });
  await rpc(host, { type: 'fire', task: before.native.tasks[1], occurrence: 'cron-original' });
  await rpc(host, { type: 'finish' });
  await vi.waitFor(async () => expect((await stats()).sent.some((row: any) => row.output === 'original foreground result')).toBe(true));
  const b = frontendProcess('frontend-b');
  const next = await rpc(b, { type: 'start', connection, version: '1.6.249' });
  expect(next.lease.epoch).toBeGreaterThan(first.lease.epoch);
  expect(next.status).toMatchObject({ frontendVersion: '1.6.249', runtimeVersion: '1.6.247' });
  const stale = new HostClient(connection.address, connection.secret);
  try { await expect(stale.inspect(first.lease, 'state')).rejects.toThrow('stale_lease'); } finally { stale.close(); }
  expect((await command(b, '/frontend-probe', threadId)).output).toBe('dispatch 1.6.249');
  const after = await stats();
  expect(after.native).toMatchObject({ pid: before.native.pid, session: before.native.session, tasks: before.native.tasks, creates: 2, turns: 1 });
  expect(after.calls).toBe(before.calls);
  expect(after.connection).toEqual(before.connection); // Same authenticated MCP listener.
  expect(after.owners).toEqual(before.owners);
  const foreground = after.sent.find((row: any) => row.messageId === 'held-foreground');
  expect(foreground.output).toBe('original foreground result');
  const copies = after.sent.filter((row: any) => row.messageId === foreground.messageId).length;
  await rpc(host, { type: 'reconnect' });
  await vi.waitFor(async () => expect((await stats()).sent.filter((row: any) => row.messageId === foreground.messageId).length).toBeGreaterThan(copies));
  await rpc(host, { type: 'ack', messageId: foreground.messageId });
  for (const occurrence of ['once-original', 'cron-original']) {
    let result: any;
    await vi.waitFor(async () => { result = (await stats()).sent.find((row: any) => row.output === 'native output ' + occurrence); expect(result).toBeTruthy(); }, { timeout: 10_000 });
    await rpc(host, { type: 'ack', messageId: result.messageId });
  }
  await rpc(host, { type: 'ackAll' });
  expect((await stats()).native.turns).toBe(1);
  for (const task of before.native.tasks) expect((await command(b, '/schedule cancel ' + task, threadId)).success).toBe(true);
  await rpc(b, { type: 'stop' }); await rpc(host, { type: 'stop' });
}, 45_000);

// Version 2: observe invocation-scoped MCP rejection and explicit product-stop calls.
// Isolation, native clocks, fake model actions and production components are unchanged.
const fs = require('fs/promises');
const path = require('path');
const http = require('http');
const { fork, execFile } = require('child_process');
const { promisify } = require('util');
const { randomUUID, randomBytes, createHash } = require('crypto');
const { RetainedRuntime } = require('/app/dist/sessionHost/RetainedRuntime');
const { HostServer } = require('/app/dist/sessionHost/HostServer');
const { ThreadManager } = require('/app/dist/thread/ThreadManager');
const { ThreadExecutorPool } = require('/app/dist/thread/ThreadExecutorPool');
const { DirectoryGuard } = require('/app/dist/security/DirectoryGuard');
const { createExecutor } = require('/app/dist/executor');
const { AcpClient } = require('/app/dist/executor/acp/AcpClient');
const { ClaudeSessionSchedules } = require('/app/dist/scheduling/claude/ClaudeSessionSchedules');
const { AgySessionSchedules } = require('/app/dist/scheduling/agy/AgySessionSchedules');
const backend = process.argv[2], start = Date.now();
const facts = { backend, platform: 'Linux-only', transport: 'synthetic Router ACK, no Feishu', assertions: [],
  provider: [], nativeOperations: [], callbacks: [], nativeReceipts: [], lifecycle: [], deliveries: [], snapshots: [], cleanup: {} };
let phase = 'setup', queue = [], model, runtime, host, pool, executor, connection, activeFrontend, serial = 0;
let held, holdNext = false, scheduledMcp = false, threadId, droppedId, allowAck = false;
const frontends = [], nativeChildren = new Map();
const now = () => Date.now() - start;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, name) { if (!value) throw Error('Assertion failed: ' + name); facts.assertions.push(name); }
async function until(fn, name, timeout = 30000) {
 const end = Date.now() + timeout;
 while (!fn()) { if (Date.now() > end) throw Error('Bounded observation timed out: ' + name); await sleep(25); }
 return fn();
}
function plan(actions) { if(queue.length)throw Error('Unconsumed fake model plan'); queue.push(...actions); }
const receiptSeen = new Set();
function receipt(value) { const signature = JSON.stringify(value); if (!receiptSeen.has(signature)) { receiptSeen.add(signature); facts.nativeReceipts.push({t:now(),phase,...value}); } }
function tool(name,args) { return { tool: name, args }; }
function extract(body) {
 if(backend==='agy') {
  for(const message of body.contents||[])for(const part of message.parts||[])if(part.functionResponse)receipt(part.functionResponse);
  return (body.contents||[]).flatMap(m=>(m.parts||[]).map(p=>p.text||'')).filter(Boolean).at(-1)||'';
 }
 for(const message of body.messages||[])if(Array.isArray(message.content))for(const part of message.content)if(part.type==='tool_result')receipt(part);
 const last=(body.messages||[]).filter(m=>m.role==='user').at(-1)?.content;
 return typeof last==='string'?last:JSON.stringify(last||[]);
}
function sendStream(res, action, index, finish=true) {
 if(backend==='agy') {
  if(!res.headersSent)res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'close'});
  const parts=action.tool?[{functionCall:{name:action.tool,args:action.args}}]:[{text:action.text||'SYNTHETIC_NATIVE_CONTENT'}];
  res.write('data: '+JSON.stringify({candidates:[{content:{role:'model',parts},...(finish?{finishReason:'STOP'}:{})}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,totalTokenCount:12}})+'\n\n');
  if(finish)res.end(); return;
 }
 const send=(event,data)=>res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
 if(!res.headersSent) {
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  send('message_start',{type:'message_start',message:{id:`msg_synthetic_${index}`,type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
  const block=action.tool?{type:'tool_use',id:randomUUID(),name:action.tool,input:{}}:{type:'text',text:''};
  send('content_block_start',{type:'content_block_start',index:0,content_block:block});
 }
 send('content_block_delta',{type:'content_block_delta',index:0,delta:action.tool?{type:'input_json_delta',partial_json:JSON.stringify(action.args)}:{type:'text_delta',text:action.text||'SYNTHETIC_NATIVE_CONTENT'}});
 if(finish) {send('content_block_stop',{type:'content_block_stop',index:0});send('message_delta',{type:'message_delta',delta:{stop_reason:action.tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:5}});send('message_stop',{type:'message_stop'});res.end();}
}
function releaseContent() { if(held) { const saved=held; held=undefined; facts.lifecycle.push({t:now(),event:'held-content-release'});sendStream(saved.res,{text:'SYNTHETIC_RETAINED_COMPLETION'},saved.index); } }
const acpRequest=AcpClient.prototype.sendRequest;
AcpClient.prototype.sendRequest=function(method,args) {facts.nativeOperations.push({t:now(),phase,kind:'acp',method});return acpRequest.call(this,method,args);};
const acpPrompt=AcpClient.prototype.prompt;
AcpClient.prototype.prompt=function(session,blocks) {
 const text=blocks[0]?.text||'';
 if(text.startsWith('Execute exactly this native tool once')) {
  const action=JSON.parse(text.slice(text.indexOf('\n')+1));facts.nativeOperations.push({t:now(),phase,kind:'management',action});
  plan([tool(action.tool,action.input),{text:'SYNTHETIC_MANAGEMENT_COMPLETE'}]);
 }
 return acpPrompt.call(this,session,blocks);
};
const claudeAccept=ClaudeSessionSchedules.prototype.accept;
ClaudeSessionSchedules.prototype.accept=function(frame) {
 if(['command_lifecycle','result','user'].includes(frame.type)||frame.request?.subtype==='hook_callback')receipt({kind:'claude-frame',frame});
 return claudeAccept.call(this,frame);
};
const agyAccept=AgySessionSchedules.prototype.accept;
AgySessionSchedules.prototype.accept=function(event,payload,records) {
 const result=agyAccept.call(this,event,payload,records);
 // Preserve genuine native transcript source/step and hook decisions; no event injection.
 if(['Stop','PreToolUse','PostToolUse','PreInvocation','PostInvocation'].includes(event))receipt({kind:'agy-hook',event,payload,records,result});
 return result;
};
class Router {
 messages=[];listeners=[];acks=[];closes=[];connected=true;
 onMessage(fn){this.listeners.push(fn);} onClose(fn){this.closes.push(fn);return()=>{};}
 onTaskResultAck(fn){this.acks.push(fn);return()=>{this.acks=this.acks.filter(x=>x!==fn);};}
 isConnected(){return this.connected;} async connect(){this.binding();}
 binding(){this.inbound({type:'binding_confirm',data:{success:true,capabilities:{taskRecovery:true,scheduleResultsV1:true}}});}
 disconnect(){this.connected=false;this.closes.forEach(fn=>fn());}
 inbound(message){this.listeners.forEach(fn=>fn(message));} ack(id){this.acks.forEach(fn=>fn(id));}
 send(message){this.messages.push(structuredClone(message));facts.deliveries.push({t:now(),phase,...message});
  if(message.type==='response') {
   if(message.queueStarted?.source==='schedule'&&!allowAck){droppedId??=message.messageId;}
   else queueMicrotask(()=>this.ack(message.messageId));
  }return true;
 }
}
const router=new Router();
function rpc(child,action,data={}) {
 const id=++serial;
 return new Promise((resolve,reject)=>{
  const deadline=setTimeout(()=>finish(Error('Frontend IPC timeout: '+action)),20000);
  const listener=m=>{if(m.id===id)finish(m.error?Error(m.error):undefined,m.value);};
  const closed=()=>finish(Error('Frontend exited before reply'));
  function finish(error,value){clearTimeout(deadline);child.off('message',listener);child.off('exit',closed);error?reject(error):resolve(value);}
  child.on('message',listener);child.on('exit',closed);child.send({id,action,...data});
 });
}
async function frontend(version) {
 const child=fork('/probe/frontend.cjs',[],{env:process.env,stdio:['ignore','ignore','pipe','ipc']});
 child.stderr.on('data',b=>{facts.frontendStderr=(facts.frontendStderr||'')+b.toString();});
 child.joined=new Promise(resolve=>child.once('exit',(code,signal)=>{child.terminal={code,signal};resolve();}));frontends.push(child);
 facts.lifecycle.push({t:now(),event:'frontend-start',version,pid:child.pid});
 await rpc(child,'start',{connection,version});activeFrontend=child;return child;
}
async function detach(child){await rpc(child,'prepare');await rpc(child,'close');await child.joined;facts.lifecycle.push({t:now(),event:'frontend-joined',pid:child.pid,terminal:child.terminal});}
async function command(content,selected=threadId) {
 const messageId='synthetic-command-'+(++serial);
 router.inbound({type:'command',messageId,openId:'synthetic-owner',...(selected?{threadId:selected}:{}),content});
 const result=await until(()=>router.messages.find(m=>m.type==='response'&&m.messageId===messageId),content,65000);
 check(result.success===true,'command succeeded: '+content);return result;
}
async function snapshot(label) {
 const child=backend==='claude'?executor?.claudeProcess:executor?.acp?.client?.child;
 if(child?.pid){
  nativeChildren.set(child.pid,child);
  if(!child.fixtureObservedStdin){
   child.fixtureObservedStdin=true;const write=child.stdin.write.bind(child.stdin);
   child.stdin.write=function(data,...rest){
    try{const frame=JSON.parse(String(data));
     if(frame.type==='user'||frame.type==='control_request')facts.nativeOperations.push({t:now(),phase,kind:'claude-wire',type:frame.type,subtype:frame.request?.subtype});
    }catch{}
    return write(data,...rest);
   };
  }
 }
 const catalog=JSON.parse(await fs.readFile('/probe/runtime/schedule-catalog.json','utf8'));
 const bridge=runtime.bridges.get(threadId)?.connection;
 const value={t:now(),label,pid:child?.pid,session:executor?.getSessionId(),bridgeUrl:bridge?.url,
  definitions:catalog.records?.map(r=>({id:r.id,nativeId:r.nativeId,state:r.state}))||[],pending:catalog.pending||[]};
 facts.snapshots.push(value);return value;
}
(async()=>{
 try {
  check((await fs.readFile('/proc/net/route','utf8')).trim().split('\n').length===1,'private network has no external route');
  check(!await fs.stat('/home').catch(()=>false),'host home is not mounted');
  facts.nativeVersion=(await promisify(execFile)(`/native/${backend}`,['--version'],{env:process.env})).stdout.trim();
  model=http.createServer((req,res)=>{void(async()=>{
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>12000000)throw Error('Oversized request');}
   const valid=backend==='claude'?req.url.startsWith('/v1/messages'):req.url.includes(':streamGenerateContent');
   if(!valid){facts.unexpectedEndpoints??=[];facts.unexpectedEndpoints.push({method:req.method,path:req.url});res.writeHead(502).end();return;}
   const body=JSON.parse(raw),input=extract(body),hasTools=!!body.tools?.length;
   let action;
   if(!hasTools)action={text:'Synthetic title',classification:'auxiliary'};
   else if(queue.length){const selected=queue.shift();action={...selected,classification:selected.classification??(phase==='cleanup'?'cleanup':'setup-or-foreground')};}
   else {
    action={text:'SYNTHETIC_NATIVE_CONTENT',classification:'scheduled-content'};
    if(holdNext){holdNext=false;action.hold=true;}
    else if(!scheduledMcp){
     const names=backend==='agy'?(body.tools||[]).flatMap(t=>(t.functionDeclarations||[]).map(x=>x.name)):(body.tools||[]).map(t=>t.name);
     const name=names.find(n=>n.endsWith('remote_cli_schedule_list'));
     if(name){
      const args={requestId:'synthetic-native-gap-mcp'};
      if(backend==='agy'){
       const spec=(body.tools||[]).flatMap(t=>t.functionDeclarations||[]).find(t=>t.name===name);
       if((spec.parameters||spec.parametersJsonSchema)?.required?.includes('toolSummary'))args.toolSummary='Synthetic retained schedule catalog inspection';
      }
      action=tool(name,args);action.classification='scheduled-content';scheduledMcp=true;
     }else if(backend==='claude'){
      const nativeName='mcp__remote-cli-delegation__remote_cli_schedule_list';
      action={...tool('ToolSearch',{query:'select:'+nativeName}),classification:'scheduled-content'};
      queue.push({...tool(nativeName,{requestId:'synthetic-native-gap-mcp'}),classification:'scheduled-content'},
       {text:'SYNTHETIC_NATIVE_MCP_COMPLETE',classification:'scheduled-content'});scheduledMcp=true;
     }
    }
   }
   const entry={t:now(),phase,hasTools,classification:action.classification,action,latestInput:input.slice(-3000)};facts.provider.push(entry);
   res.on('close',()=>{entry.connectionClosedAt=now();});
   sendStream(res,action,facts.provider.length,!action.hold);
   if(action.hold){held={res,index:facts.provider.length};facts.lifecycle.push({t:now(),event:'native-content-held'});}
  })().catch(error=>{facts.providerError=error.message;res.destroy();});});
  model.on('connect',(_req,socket)=>{facts.unexpectedConnect=true;socket.destroy();});
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${model.address().port}`;
  Object.assign(process.env,{ANTHROPIC_API_KEY:'synthetic-loopback-only',ANTHROPIC_BASE_URL:endpoint,
   CLAUDE_CONFIG_DIR:'/probe/config',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',
   GEMINI_API_KEY:'synthetic-loopback-only',GOOGLE_GEMINI_BASE_URL:endpoint,HTTP_PROXY:endpoint,HTTPS_PROXY:endpoint,ALL_PROXY:endpoint,NO_PROXY:'127.0.0.1,localhost'});
  const config={type:backend==='claude'?'claude-persistent':'agy',[backend]:{command:`/native/${backend}`,autoApprove:true,...(backend==='claude'?{model:'claude-sonnet-4-6'}:{})}};
  const threads=await ThreadManager.initialize('/probe/home');const guard=new DirectoryGuard(['/probe/home/workspace']);
  pool=new ThreadExecutorPool(threads,guard,config,(...args)=>{
   executor=createExecutor(...args);
   const execute=executor.execute.bind(executor);
   executor.execute=async(text,options)=>{
    if(options?.nativeScheduleManagement){const action=JSON.parse(text.slice(text.lastIndexOf('\n')+1));facts.nativeOperations.push({t:now(),phase,kind:'management',action});plan([tool('ToolSearch',{query:`select:${action.tool}`}),tool(action.tool,action.input),{text:'SYNTHETIC_MANAGEMENT_COMPLETE'}]);}
    else facts.nativeOperations.push({t:now(),phase,kind:'foreground',text});
    return execute(text,options);
   };
   const create=executor.createNativeSchedule.bind(executor);
   executor.createNativeSchedule=async(input,emit,...rest)=>{const handle=await create(input,event=>{facts.callbacks.push({t:now(),phase,id:input.id,event});return emit(event);},...rest);facts.nativeOperations.push({t:now(),phase,kind:'created',id:input.id,nativeId:handle.nativeId,rule:input.rule});return handle;};
   return executor;
  });
  runtime=new RetainedRuntime({directory:'/probe/runtime',runtimeVersion:'1.6.248',config,threads,pool,guard,router});
  const secret=randomBytes(32).toString('hex'),launcherSecret=randomBytes(32).toString('hex');
  host=new HostServer({directory:'/probe/control',secret,launcherSecret,installationId:'synthetic-installation',runtime});
  await runtime.start();connection={address:await host.listen(),secret,launcherSecret,directory:'/probe/control'};
  const first=await frontend('1.6.248');
  threadId=(await command(`/thread new synthetic ${backend} /probe/home/workspace`)).threadId;
  plan([{text:'SYNTHETIC_ORIGINAL_CONTEXT'}]);await command('Record synthetic original context.');
  const due=new Date(Math.ceil((Date.now()+100000)/60000)*60000);facts.onceDueEpochMs=due.getTime();
  await command(`/schedule at ${due.toISOString()} -- SYNTHETIC_ONCE_CONTENT`);
  await command('/schedule cron "* * * * *" --tz UTC -- SYNTHETIC_RECURRING_CONTENT');
  const original=await snapshot('before');check(original.pid&&original.session,'real original native process and session');
  holdNext=true;phase='native-content';await until(()=>held,'first native scheduled content',110000);
  check(queue.length===0,'setup action queue drained before lifecycle');
  phase='lifecycle';facts.transitionStart=now();await detach(first);
  // Observation waits only; native once/cron clocks continue while their first
  // content request is held. No synthetic prompt wakes the host.
  await sleep(Math.max(0,due.getTime()+4500-Date.now()));
  facts.gapDeadlinePassed=now();await snapshot('gap');
  const second=await frontend('1.6.249');facts.transitionEnd=now();
  const after=await snapshot('attached');
  check(original.pid===after.pid&&original.session===after.session,'same native PID and original conversation across frontend replacement');
  check(original.bridgeUrl===after.bridgeUrl,'same original managed bridge endpoint');
  check(JSON.stringify(original.definitions.map(r=>[r.id,r.nativeId]))===JSON.stringify(after.definitions.map(r=>[r.id,r.nativeId])),'same retained definition IDs');
  check(!facts.nativeOperations.some(x=>x.t>=facts.transitionStart&&x.t<=facts.transitionEnd),'zero native protocol or management operations during lifecycle');
  check(!facts.provider.some(x=>x.t>=facts.transitionStart&&x.t<=facts.transitionEnd),'zero lifecycle provider requests while genuine content remains held');
  phase='native-content';releaseContent();
  await until(()=>facts.callbacks.filter(x=>x.event.type==='completed').length>=2,'once and recurring native terminals',100000);
  await until(()=>droppedId,'first scheduled output dropped ACK',30000);
  const firstOutput=router.messages.find(m=>m.type==='response'&&m.messageId===droppedId);
  const callsBeforeRetry=facts.provider.length;
  allowAck=true;
  await until(()=>router.messages.filter(m=>m.type==='response'&&m.messageId===droppedId).length>=2,'same output redelivered after ACK loss',35000);
  const duplicate=router.messages.filter(m=>m.type==='response'&&m.messageId===droppedId).at(-1);
  check(firstOutput.output===duplicate.output&&firstOutput.threadId===duplicate.threadId,'lost ACK retries original result identity and output');
  facts.retryObservation={callsBeforeRetry,callsAfterRetry:facts.provider.length,id:droppedId};
  const status=await command('/host status');check(status.output.includes('Frontend 1.6.249; native runtime 1.6.248'),'new separately loaded frontend parser handles next command');
  facts.frontendB=await rpc(second,'status');
  await until(()=>facts.callbacks.filter(x=>x.event.type==='completed').length>=3,'subsequent native recurring occurrence',90000);
  const bridge=runtime.bridges.get(threadId).connection;
  const bridgeResponse=await fetch(bridge.url,{method:'POST',headers:{authorization:`Bearer ${bridge.token}`},body:JSON.stringify({name:'remote_cli_schedule_list',args:{requestId:'synthetic-gap-bridge-list'},callId:'synthetic-call'})});
  facts.directBridge=await bridgeResponse.json();check(facts.directBridge.error==='No admitted native invocation owns this tool request.','out-of-turn bridge request is rejected after native terminal');
  facts.nativeMcpAttempted=scheduledMcp;
  facts.finalCatalog=JSON.parse(await fs.readFile('/probe/runtime/schedule-catalog.json','utf8'));
  check(facts.callbacks.filter(x=>x.event.type==='completed').every(x=>x.event.success),'native results succeed');
 }catch(error){facts.error=error.message;facts.errorStack=error.stack?.split('\n').slice(0,5);}
 finally{
  phase='cleanup';releaseContent();allowAck=true;
  // Explicit owned cancellation is teardown, never frontend handoff. If product
  // teardown refuses uncertain work, preserve that failure and retire the entire
  // disposable namespace; never forge a clean receipt or clear ownership.
  try {
   if(activeFrontend&&!activeFrontend.terminal&&threadId){
    const catalog=JSON.parse(await fs.readFile('/probe/runtime/schedule-catalog.json','utf8'));
    for(const record of catalog.records||[])if(record.state!=='completed'&&record.state!=='cancelled')await command('/schedule cancel '+record.id);
   }
   for(const child of frontends)if(!child.terminal){await rpc(child,'close');await child.joined;}
   if(host){
    facts.stopStart=now();const providerBefore=facts.provider.length,operationsBefore=facts.nativeOperations.length;
    await host.stop(30000);facts.stopEnd=now();facts.cleanup.cleanHostStop=true;
    facts.stopCounts={provider:facts.provider.length-providerBefore,nativeOperations:facts.nativeOperations.length-operationsBefore};
    check(facts.stopCounts.provider===0&&facts.stopCounts.nativeOperations===0,'explicit drained host stop performs zero model or management calls');
    facts.retiredCatalog=JSON.parse(await fs.readFile('/probe/runtime/schedule-catalog.json','utf8'));
    check(facts.retiredCatalog.pending.length===0,'stop retains empty acknowledged outbox');
    check(facts.retiredCatalog.records.every(row=>row.state==='completed'||row.state==='cancelled'&&row.cancelRequested&&row.cleanupConfirmed),'cancelled cleanup certified only after native group exit');
   }
  }catch(error){facts.cleanup.productStopError=error.message;}
  for(const child of frontends)if(!child.terminal){child.kill('SIGKILL');await child.joined;}
  facts.cleanup.frontends=frontends.map(child=>({pid:child.pid,...child.terminal}));
  try {await snapshot('cleanup');}catch{}
  for(const [pid,child]of nativeChildren){
   if(child.exitCode===null&&child.signalCode===null){try{process.kill(-pid,'SIGKILL');}catch{child.kill('SIGKILL');}await new Promise(r=>child.once('close',r));}
  }
  const survivors=[];
  for(const item of await fs.readdir('/proc'))if(/^\d+$/.test(item))try{if((await fs.readlink('/proc/'+item+'/exe')).startsWith('/native/'))survivors.push(Number(item));}catch{}
  facts.cleanup.nativeParents=[...nativeChildren].map(([pid,child])=>{
   let groupAbsent=false;try{process.kill(-pid,0);}catch(error){groupAbsent=error.code==='ESRCH';}
   return {pid,exitCode:child.exitCode,signal:child.signalCode,groupAbsent};
  });
  facts.cleanup.nativeSurvivorsBeforeNamespaceExit=survivors.length;
  // Namespace-only descendants of a native ACP process may have become orphaned.
  for(const pid of survivors)try{process.kill(pid,'SIGKILL');}catch{}
  if(model){model.closeAllConnections();await new Promise(r=>model.close(r));facts.cleanup.fakeProviderClosed=true;}
  facts.pendingFakeActions=queue.length;
  facts.counts={providerTotal:facts.provider.length,byClassification:{},nativeManagement:facts.nativeOperations.filter(x=>x.kind==='management').length,
   lifecycleRequests:facts.provider.filter(x=>x.phase==='lifecycle').length,nativeCallbacks:facts.callbacks.length};
  for(const request of facts.provider)facts.counts.byClassification[request.classification]=(facts.counts.byClassification[request.classification]||0)+1;
  const labels=new Map();function label(id){if(!labels.has(id))labels.set(id,'synthetic-id-'+(labels.size+1));return labels.get(id);}
  function safe(value,key=''){
   if(Array.isArray(value))return value.map(v=>safe(v,key));
   if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,safe(v,k)]));
   if(typeof value!=='string')return value;
   if(/token|secret|authorization/i.test(key))return '<redacted-fixture-credential>';
   return value.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,label).replace(/127\.0\.0\.1:\d+/g,'127.0.0.1:<fixture-port>').replaceAll('/probe','<fixture>').replaceAll('/app','<compiled-cli>').replaceAll('/native','<native>');
  }
  await fs.writeFile('/probe/result.json',JSON.stringify(safe(facts),null,2));process.exit(facts.error?1:0);
 }
})();

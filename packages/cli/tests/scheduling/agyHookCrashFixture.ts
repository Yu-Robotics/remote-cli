import path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';

/** Node-only crash fixture. Boot identity is synthetic; kernel gates, files,
 * process groups and abrupt owner death are real. No backend command exists. */
export async function crashAgyOverlay(home: string, options: { groupPid?: number; crashRename?: number; restoring?: boolean } = {}): Promise<void> {
  const source = path.resolve('src/scheduling/agy/AgyHookRelay.ts');
  const ownership = path.resolve('src/delegation/OwnershipRuntime.ts');
  const child = spawn(process.execPath, ['-e', `
    require.extensions['.ts'] = (module, filename) => module._compile(require('typescript').transpileModule(require('fs').readFileSync(filename, 'utf8'), { compilerOptions: { module: 1, target: 9, esModuleInterop: true } }).outputText, filename);
    const fs = require('fs'), path = require('path'), crypto = require('crypto');
    const ownership = require(${JSON.stringify(ownership)});
    const identity = { host: 'synthetic-manager-host', boot: 'synthetic-manager-boot', namespace: 'host' };
    ownership.ownerRecord = () => ({ version: 2, token: crypto.randomUUID(), pid: process.pid, birth: ownership.processBirth(process.pid), ...identity });
    const recover = ownership.assertRecoverable;
    ownership.assertRecoverable = (raw, journal) => recover(raw, journal, identity);
    const options = ${JSON.stringify(options)};
    const intercept = () => { const rename = fs.renameSync; let calls = 0;
      fs.renameSync = (...args) => { if (++calls === options.crashRename) process.exit(77); return rename(...args); };
    };
    if (!options.restoring && options.crashRename) intercept();
    require(${JSON.stringify(source)}).installAgyScheduleHooks(process.argv[1], {url:'http://127.0.0.1:1/hook',token:'synthetic-token'}).then(async lease => {
      if (options.groupPid) {
        const t = JSON.parse(fs.readFileSync(path.join(process.argv[1], '.remote-cli-agy-hooks.owner.json'))).value;
        const file = path.join(process.argv[1], '.remote-cli-agy-hooks-' + t.token, 'processes');
        const id = crypto.randomUUID();
        fs.appendFileSync(file, JSON.stringify({id,event:'reserve'})+'\\n'+JSON.stringify({id,event:'spawn',pid:options.groupPid,group:true})+'\\n');
        const fd=fs.openSync(file,'r+'); fs.fsyncSync(fd); fs.closeSync(fd);
      }
      if (options.restoring) { intercept(); await lease(); }
      process.stdout.write('ready\\n'); setInterval(() => {}, 1000);
    }).catch(() => process.exit(2));
  `, home], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    const result = await Promise.race([once(child.stdout!, 'data').then(data => String(data[0])), exited.then(([code]) => code)]);
    if (result !== 'ready\n' && result !== 77) throw new Error('Synthetic overlay fixture failed before its crash boundary');
  } finally { child.kill('SIGKILL'); await exited; }
}

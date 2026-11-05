'use strict';
// This shim admits containment before any backend code can execute.
const { spawn } = require('child_process');
const path = require('path');
const native = require(path.join(__dirname, 'prebuilds', `${process.platform}-${process.arch}`, 'managed_native.node'));
const job = process.argv[2];
let started = false;
let contained = false;
const stop = () => {
  started = true;
  if (process.platform === 'darwin' && contained) {
    // Signal our own current group while its leader is alive. Never reuse a saved PGID.
    process.kill(0, 'SIGKILL');
  }
  process.exit(1);
};
const timer = setTimeout(stop, 30000);
process.on('disconnect', stop);
process.on('message', message => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'stop') { clearTimeout(timer); stop(); return; }
  if (started || !contained || message.type !== 'start') return;
  started = true;
  clearTimeout(timer);
  const environment = { ...message.env };
  delete environment.NODE_CHANNEL_FD;
  delete environment.NODE_CHANNEL_SERIALIZATION_MODE;
  let child;
  const failure = error => {
    process.send({ type: 'backend-error', code: typeof error.code === 'string' ? error.code : 'EIO' }, () => stop());
  };
  try {
    child = spawn(message.command, message.args, {
      cwd: message.cwd, env: environment, stdio: [0, 1, 2], windowsHide: true,
      windowsVerbatimArguments: message.windowsVerbatimArguments === true,
    });
  } catch (error) { failure(error); return; }
  child.once('spawn', () => process.send({ type: 'backend-started' }));
  child.once('error', failure);
  child.once('exit', (code, signal) => {
    process.send({ type: 'backend-exit', code, signal }, () => {
      if (process.platform === 'darwin') stop();
      else process.exit(code ?? 1);
    });
  });
});
try {
  if (process.platform === 'win32') native.joinJob(job);
  else {
    const identity = native.processInfo(process.pid);
    if (identity.group !== process.pid || identity.session !== process.pid) throw new Error('Uncontained launcher');
  }
  contained = true;
  process.send({ type: 'managed-job-ready' });
} catch {
  // Never start a backend when admission fails.
  process.exit(1);
}

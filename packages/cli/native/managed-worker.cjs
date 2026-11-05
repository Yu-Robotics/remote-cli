'use strict';
// This shim joins the parent's retained Job before any backend code can execute.
const { spawn } = require('child_process');
const path = require('path');
const native = require(path.join(__dirname, 'prebuilds', `${process.platform}-${process.arch}`, 'managed_native.node'));
const job = process.argv[2];
let started = false;
const timer = setTimeout(() => process.exit(1), 30000);
process.on('disconnect', () => process.exit(1));
process.on('message', message => {
  if (started || !message || message.type !== 'start') return;
  started = true;
  clearTimeout(timer);
  const environment = { ...message.env };
  delete environment.NODE_CHANNEL_FD;
  delete environment.NODE_CHANNEL_SERIALIZATION_MODE;
  let child;
  try {
    child = spawn(message.command, message.args, {
      cwd: message.cwd, env: environment, stdio: [0, 1, 2], windowsHide: true,
      windowsVerbatimArguments: message.windowsVerbatimArguments === true,
    });
  } catch { process.exit(1); }
  child.once('error', () => process.exit(1));
  child.once('exit', (code) => process.exit(code ?? 1));
});
try {
  if (process.platform === 'win32') native.joinJob(job);
  process.send({ type: 'managed-job-ready' });
} catch {
  // Never start a backend when job admission fails.
  process.exit(1);
}

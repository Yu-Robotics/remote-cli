import { type ChildProcess, type SpawnOptions } from 'child_process';
import { ownedSpawn as spawn } from '../delegation/OwnershipRuntime';
import { randomUUID } from 'crypto';
import path from 'path';
import { nativeBindings, nativeRoot, type NativeHandle } from '../native/NativeBindings';

export interface ManagedJob { handle: NativeHandle; closed: boolean; admitted: boolean }
const jobs = new WeakMap<ChildProcess, ManagedJob>();
export function managedJob(child: ChildProcess): ManagedJob | undefined { return jobs.get(child); }

/** Windows contains a shim before it may start the backend; the parent owns the Job handle. */
export function spawnManaged(enabled: boolean, command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  if (!enabled || !['win32', 'darwin'].includes(process.platform)) return spawn(command, args, options);
  if (options.shell) throw new Error('Managed Windows launch does not support a shell wrapper');
  const native = nativeBindings();
  const name = `Local\\remote-cli-${randomUUID()}`;
  const job: ManagedJob | undefined = process.platform === 'win32'
    ? { handle: native.createJob(name), closed: false, admitted: false } : undefined;
  let admitted = false;
  // The shim must not execute user Node preloads before joining the Job.
  const environment = { ...(options.env ?? process.env) };
  for (const key of Object.keys(environment)) if (['NODE_OPTIONS', 'NODE_PATH', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE'].includes(key.toUpperCase())) delete environment[key];
  let child: ChildProcess;
  try {
    const streams = Array.isArray(options.stdio) ? options.stdio.slice(0, 3) : ['pipe', 'pipe', 'pipe'];
    child = spawn(process.execPath, [path.join(nativeRoot, 'managed-worker.cjs'), name], {
      ...options, env: environment, detached: process.platform === 'darwin', windowsHide: true,
      stdio: [...streams, 'ipc'] as SpawnOptions['stdio'],
    });
  } catch (error) { if (job) { native.close(job.handle); job.closed = true; } throw error; }
  if (job) jobs.set(child, job);
  const timer = setTimeout(() => { child.kill(); }, 30000);
  child.on('message', message => {
    if (admitted || job?.closed || !message || (message as { type?: string }).type !== 'managed-job-ready') return;
    try {
      if (!child.pid) throw new Error('Managed launch identity is missing');
      if (job) {
        if (!native.jobMember(job.handle, child.pid) || native.jobCount(job.handle) < 1) throw new Error('Managed Windows job admission is missing');
        job.admitted = true;
      } else {
        const identity = native.processInfo(child.pid);
        if (identity.group !== child.pid || identity.session !== child.pid) throw new Error('Managed process group admission failed');
      }
      admitted = true;
      child.send({ type: 'start', command, args, cwd: options.cwd?.toString(), env: options.env ?? process.env,
        windowsVerbatimArguments: options.windowsVerbatimArguments }, error => { if (error) child.kill(); });
    } catch { child.kill(); }
  });
  child.once('exit', () => {
    try { if (job && !job.closed) native.terminateJob(job.handle); } catch { /* Group proof must still succeed before release. */ }
  });
  child.once('close', () => { clearTimeout(timer); });
  // The handle remains retained through close: only ManagedProcessGroups may confirm and release it.
  return child;
}

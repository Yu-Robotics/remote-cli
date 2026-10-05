import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { DelegatedWorkerLane } from './DelegatedWorkerSessionStore';
import { isWorkerLaneExecutorId } from './DelegatedWorkerSessionStore';

async function unlinkFile(file: string): Promise<void> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Expected a file at ${file}`);
    await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function cleanupAtHome(lane: DelegatedWorkerLane, home: string): Promise<void> {
  const root = path.join(home, '.remote-cli');
  const id = lane.executorThreadId;
  const pointer = (namespace: string) => path.join(root, `${namespace}-sessions`, `${id}.json`);

  switch (lane.backend) {
    case 'claude':
      await Promise.all([
        unlinkFile(pointer('claude')),
        unlinkFile(path.join(root, 'claude-sandbox', `${id}.json`)),
        unlinkFile(path.join(root, 'claude-approval', `${encodeURIComponent(id)}.sock`)),
      ]);
      return;
    case 'codex':
      await Promise.all([
        unlinkFile(pointer('codex')),
        unlinkFile(path.join(root, 'codex-sandbox', `${id}.json`)),
      ]);
      return;
    case 'agy':
      await unlinkFile(pointer('agy'));
      await fs.rm(path.join(root, 'agy-homes', id), { recursive: true, force: true });
      return;
    case 'opencode':
    case 'kimi':
    case 'zcode':
      await unlinkFile(pointer(lane.backend));
      return;
    case 'dsh':
      await unlinkFile(pointer('dsh'));
      await unlinkFile(path.join(root, 'dsh-sessions', `${id}.handoff.json`));
      return;
    case 'pi': {
      const pointerPath = pointer('pi');
      let sessionFile: string | undefined;
      try {
        const parsed = JSON.parse(await fs.readFile(pointerPath, 'utf8')) as { sessionFile?: unknown };
        if (typeof parsed.sessionFile === 'string') sessionFile = parsed.sessionFile;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await unlinkFile(pointerPath);
      if (!sessionFile) return;
      const store = path.join(root, 'pi-sessions', 'store');
      const resolved = path.resolve(sessionFile);
      if (isInside(resolved, store)) await unlinkFile(resolved);
      return;
    }
  }
}

/**
 * Removes only local state belonging to a synthetic lane ID. It never starts a
 * backend process and deliberately leaves provider-managed remote history alone.
 *
 * Backends historically use both `process.env.HOME` and `os.homedir()`. When
 * they disagree, clear the lane from both locations; the synthetic ID prevents
 * this from touching a direct user thread in either root.
 */
export async function cleanupDelegatedWorkerLane(lane: DelegatedWorkerLane, home?: string): Promise<void> {
  if (!isWorkerLaneExecutorId(lane.executorThreadId)) throw new Error('Invalid delegated worker executor ID');
  const homes = home ? [home] : [...new Set([process.env.HOME, os.homedir()].filter((value): value is string => Boolean(value)))];
  await Promise.all(homes.map(candidate => cleanupAtHome(lane, candidate)));
}

/** Disconnect native continuation without deleting workspaces, history, or settings. */
export async function clearDelegatedWorkerContext(lane: DelegatedWorkerLane, home?: string): Promise<void> {
  if (!isWorkerLaneExecutorId(lane.executorThreadId)) throw new Error('Invalid delegated worker executor ID');
  const homes = home ? [home] : [...new Set([process.env.HOME, os.homedir()].filter((value): value is string => Boolean(value)))];
  for (const candidate of homes) {
    const directory = path.join(candidate, '.remote-cli', `${lane.backend}-sessions`);
    await unlinkFile(path.join(directory, `${lane.executorThreadId}.json`));
    if (lane.backend === 'dsh') await unlinkFile(path.join(directory, `${lane.executorThreadId}.handoff.json`));
  }
}

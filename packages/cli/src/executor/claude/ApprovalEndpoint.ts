import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

/** Windows IPC uses a named pipe; Unix sockets need a short, private directory. */
export function createApprovalEndpoint(platform: NodeJS.Platform = process.platform): { socketPath: string; directory?: string } {
  if (platform === 'win32') return { socketPath: `\\\\.\\pipe\\remote-cli-claude-${randomUUID()}` };
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rca-')));
  return { directory, socketPath: path.join(directory, 'approval.sock') };
}

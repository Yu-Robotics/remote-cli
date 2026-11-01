import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createApprovalEndpoint } from '../../src/executor/claude/ApprovalEndpoint';

describe('approval IPC endpoints', () => {
  it('allocates distinct Windows named pipes without filesystem socket operations', () => {
    const first = createApprovalEndpoint('win32');
    const second = createApprovalEndpoint('win32');
    expect(first.socketPath.startsWith('\\\\.\\pipe\\remote-cli-claude-')).toBe(true);
    expect(first.directory).toBeUndefined();
    expect(second.socketPath).not.toBe(first.socketPath);
  });

  it('allocates a private, canonical directory for a short Unix socket', () => {
    const endpoint = createApprovalEndpoint('darwin');
    try {
      expect(fs.realpathSync(endpoint.directory!)).toBe(endpoint.directory);
      expect(path.dirname(endpoint.socketPath)).toBe(endpoint.directory);
      expect(path.basename(endpoint.socketPath)).toBe('approval.sock');
      if (process.platform !== 'win32') expect(fs.statSync(endpoint.directory!).mode & 0o777).toBe(0o700);
    } finally { fs.rmSync(endpoint.directory!, { recursive: true, force: true }); }
  });
});

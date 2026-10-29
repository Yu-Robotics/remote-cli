import { Command } from 'commander';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { delegationStorageCommand, registerDelegationStorage } from '../../src/commands/delegationStorage';
import { LegacyWorkspaceCleanup } from '../../src/delegation/LegacyWorkspaceCleanup';

describe('local delegation storage commands', () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-storage-command-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });
  afterEach(async () => { vi.restoreAllMocks(); process.exitCode = 0; await fs.rm(home, { recursive: true, force: true }); });

  it('runs scan without creating storage or starting a daemon', async () => {
    expect(await delegationStorageCommand('scan')).toMatchObject({ incomplete: false, items: [] });
    expect(await fs.readdir(home)).toEqual([]);
  });
  it('requires explicit plan paths and discard flags', async () => {
    await expect(delegationStorageCommand('plan')).rejects.toThrow('--out');
    await expect(delegationStorageCommand('discard')).rejects.toThrow('--plan');
    await expect(delegationStorageCommand('discard', { plan: path.join(home, 'missing') })).rejects.toThrow('--discard-contents');
    await expect(delegationStorageCommand('scan', { maxEntries: 'not-a-number' })).rejects.toThrow('Invalid');
  });
  it('dispatches plan and discard options without changing their meaning', async () => {
    const cleanup = new LegacyWorkspaceCleanup(path.join(home, '.remote-cli'));
    const plan = vi.spyOn(cleanup, 'plan').mockResolvedValue({} as any);
    const discard = vi.spyOn(cleanup, 'discard').mockResolvedValue({ removed: 0, errors: [] });
    const file = path.join(home, 'plan.json');
    await delegationStorageCommand('plan', { out: file, maxEntries: '20', maxBytes: '100', maxSeconds: '5' }, cleanup);
    expect(plan).toHaveBeenCalledWith(file, { entries: 20, bytes: 100, seconds: 5 });
    await delegationStorageCommand('discard', { plan: file, discardContents: true, confirmWorkersStopped: true }, cleanup);
    expect(discard).toHaveBeenCalledWith(file, { discardContents: true, confirmWorkersStopped: true });
  });
  it('registers the exact hierarchy and reports command failure', async () => {
    const program = new Command(); registerDelegationStorage(program);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['delegation', 'storage', 'scan'], { from: 'user' });
    expect(JSON.parse(output.mock.calls[0][0]).items).toEqual([]);
    await program.parseAsync(['delegation', 'storage', 'discard', '--plan', path.join(home, 'plan.json')], { from: 'user' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--discard-contents'));
    expect(process.exitCode).toBe(1);
  });
});

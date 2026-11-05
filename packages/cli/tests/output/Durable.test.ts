import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { durableJson } from '../../src/output/Durable';
let root: string;
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'output-durable-'))); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it('preserves the prior receipt and removes only its temporary file when sync fails', async () => {
  const filename = path.join(root, 'receipt.json'); await durableJson(filename, { phase: 'before' });
  const original = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (args[1] === 'wx') vi.spyOn(handle, 'sync').mockRejectedValue(new Error('synthetic sync failure'));
    return handle;
  });
  await expect(durableJson(filename, { phase: 'after' })).rejects.toThrow('sync failure');
  expect(JSON.parse(await fs.readFile(filename, 'utf8'))).toEqual({ phase: 'before' });
  expect(await fs.readdir(root)).toEqual(['receipt.json']);
});
it('retries Windows sharing errors without unlinking the existing receipt', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const filename = path.join(root, 'receipt.json'); await durableJson(filename, { phase: 'before' });
  const rename = fs.rename.bind(fs);
  const calls = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('sharing'), { code: 'EPERM' })).mockImplementation(rename);
  // Only the atomic rename policy is simulated, not native filesystem or ownership behavior.
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try { await durableJson(filename, { phase: 'after' }); }
  finally { Object.defineProperty(process, 'platform', originalPlatform); }
  expect(calls).toHaveBeenCalledTimes(2); expect(JSON.parse(await fs.readFile(filename, 'utf8'))).toEqual({ phase: 'after' });
});

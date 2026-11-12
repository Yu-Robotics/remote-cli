import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

/** Resolve public native packages from the running DSH installation, not remote-cli dependencies. */
export async function nativePackage(name: string): Promise<any> {
  const requireNative = createRequire(fs.realpathSync(process.argv[1]));
  const filename = requireNative.resolve(`@deepseek-ai/${name}`);
  // Preserve native ESM import when this adapter is compiled as CommonJS.
  return new Function('url', 'return import(url)')(pathToFileURL(filename).href);
}
export const name = 'remote-cli-session-schedule-storage';
export const inject = ['storage'];
export async function apply(ctx: any, config: { directory: string }): Promise<void> {
  const directory = fs.realpathSync(config.directory);
  if (directory !== config.directory || !path.isAbsolute(directory)) throw new Error('Invalid schedule storage scope.');
  const { JsonStorageBackend } = await nativePackage('dsh-storage-json');
  const backend = new JsonStorageBackend(directory);
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register('remoteCliSessionSchedule', backend);
    return async () => { unregister(); await backend.close(); };
  });
  ctx.provide('storage.backend.remoteCliSessionSchedule', backend);
}

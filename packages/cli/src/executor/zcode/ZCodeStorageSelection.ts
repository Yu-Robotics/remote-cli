import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ZCodeLaunchSpec } from './ZCodeCommand';

export interface ZCodeStorageSelection { storage: string; database: string }

/** Read-only subset of the native config contract, not its migrating config loader.
 * Audited against zai-org/ZCode a9fe401: config-factory, env-config.adapter,
 * file-config.adapter and schema.projectConfigFileSchema. Project configuration
 * cannot set storage; HOME (not ZCODE_HOME) selects the user config file. Native
 * DB confirmation is required separately before a prompted session is deletable.
 */
export function selectZCodeStorage(launch: ZCodeLaunchSpec, cwd: string, fallbackHome: string): ZCodeStorageSelection {
  if (process.platform !== 'linux') throw new Error('ZCode shared history verification requires Linux');
  if (launch.args.some(arg => /^--(?:cwd|config|user-config|prepare-storage)(?:=|$)/.test(arg))) {
    throw new Error('Unsupported ZCode storage selection arguments');
  }
  const home = launch.env.HOME ?? fallbackHome;
  if (!path.isAbsolute(home) || !path.isAbsolute(cwd)
    || launch.env.HOME === undefined && home !== os.userInfo().homedir) throw new Error('Invalid ZCode launch directory');
  let storage = '~/.zcode'; let database = '~/.zcode/cli/db/db.sqlite';
  const file = path.join(home, '.zcode', 'cli', 'config.json');
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > 2n * 1024n * 1024n) throw new Error('Unsupported ZCode configuration metadata');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('ZCode configuration changed while reading');
    }
    if (value.storage !== undefined) {
      if (!value.storage || typeof value.storage !== 'object' || Array.isArray(value.storage)) throw new Error('Unsupported ZCode storage configuration');
      for (const name of ['dir', 'sessionDbPath']) {
        const selected = value.storage[name];
        if (selected !== undefined && (typeof selected !== 'string' || !selected.length)) throw new Error('Invalid ZCode storage configuration');
      }
      storage = value.storage.dir ?? storage; database = value.storage.sessionDbPath ?? database;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  // Native parsing iterates the environment in insertion order; the last DB
  // alias wins. Do not normalize, reorder, or mutate the worker environment.
  let envStorage: { dir?: string; sessionDbPath?: string } | undefined;
  for (const [key, value] of Object.entries(launch.env)) {
    if (value === undefined) continue;
    if (key === 'ZCODE_STORAGE_DIR') (envStorage ??= {}).dir = value;
    if (key === 'ZCODE_SESSION_DB_PATH' || key === 'ZCODE_SESSION_DB') (envStorage ??= {}).sessionDbPath = value;
  }
  // The audited native merger replaces the storage object at each scope;
  // ConfigPort supplies defaults for absent/empty fields, rather than inheriting
  // those fields from user storage when only one environment override is set.
  if (envStorage) { storage = envStorage.dir || '~/.zcode'; database = envStorage.sessionDbPath || '~/.zcode/cli/db/db.sqlite'; }
  const resolve = (value: string) => {
    if (value.includes('\0')) throw new Error('Invalid ZCode storage path');
    return value.startsWith('~/') ? path.join(home, value.slice(2)) : path.resolve(cwd, value);
  };
  return { storage: resolve(storage), database: resolve(database) };
}

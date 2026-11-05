import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectZCodeStorage } from '../../src/executor/zcode/ZCodeStorageSelection';

describe('ZCode read-only storage selection', () => {
  let home: string, cwd: string, config: string;
  beforeEach(async () => {
    home = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zcode-selection-')));
    cwd = path.join(home, 'project'); fs.mkdirSync(cwd);
    config = path.join(home, '.zcode', 'cli', 'config.json'); fs.mkdirSync(path.dirname(config), { recursive: true });
  });
  afterEach(async () => { await fs.promises.rm(home, { recursive: true, force: true }); });
  const launch = (env: NodeJS.ProcessEnv = {}, args = ['app-server', '--stdio']) => ({ command: 'synthetic-zcode', args, env: { HOME: home, ...env } });
  it('uses native defaults without allocating storage or reading ZCODE_HOME settings', () => {
    const input = launch({ ZCODE_HOME: path.join(home, 'provider-settings') });
    expect(selectZCodeStorage(input, cwd, home)).toEqual({ storage: path.join(home, '.zcode'), database: path.join(home, '.zcode', 'cli', 'db', 'db.sqlite') });
    expect(fs.existsSync(path.join(home, '.zcode', 'cli', 'db'))).toBe(false);
  });
  it('resolves user-relative and tilde paths and ignores unsupported project storage fields without rewriting files', () => {
    const bytes = JSON.stringify({ storage: { dir: '../store', sessionDbPath: '~/db.sqlite' }, plugins: { enabledPlugins: { 'synthetic@local': true } } });
    fs.writeFileSync(config, bytes);
    fs.mkdirSync(path.join(cwd, '.zcode')); fs.writeFileSync(path.join(cwd, '.zcode', 'config.json'), JSON.stringify({ storage: { dir: 'ignored' } }));
    expect(selectZCodeStorage(launch(), cwd, home)).toEqual({ storage: path.join(home, 'store'), database: path.join(home, 'db.sqlite') });
    expect(fs.readFileSync(config, 'utf8')).toBe(bytes);
  });
  it('matches native storage-object replacement and last-alias-wins parsing', () => {
    fs.writeFileSync(config, JSON.stringify({ storage: { dir: '../user-store', sessionDbPath: '../user.sqlite' } }));
    expect(selectZCodeStorage(launch({ ZCODE_STORAGE_DIR: '../env-store' }), cwd, home)).toEqual({ storage: path.join(home, 'env-store'), database: path.join(home, '.zcode', 'cli', 'db', 'db.sqlite') });
    const input = launch({ ZCODE_SESSION_DB: '../first.sqlite', ZCODE_SESSION_DB_PATH: '../last.sqlite' });
    const original = structuredClone(input);
    expect(selectZCodeStorage(input, cwd, home)).toEqual({ storage: path.join(home, '.zcode'), database: path.join(home, 'last.sqlite') });
    expect(input).toEqual(original);
    expect(selectZCodeStorage(launch({ ZCODE_SESSION_DB_PATH: '../first.sqlite', ZCODE_SESSION_DB: '../last.sqlite' }), cwd, home).database).toBe(path.join(home, 'last.sqlite'));
  });
  it.each(['{', '[]', '{"storage":null}', '{"storage":{"dir":1}}', '{"storage":{"sessionDbPath":""}}'])(
    'holds malformed configuration metadata: %s', text => {
      fs.writeFileSync(config, text); expect(() => selectZCodeStorage(launch(), cwd, home)).toThrow(); expect(fs.readFileSync(config, 'utf8')).toBe(text);
    });
  it('holds unsupported cwd selection and oversized metadata', () => {
    expect(() => selectZCodeStorage(launch({}, ['app-server', '--cwd=other']), cwd, home)).toThrow('arguments');
    fs.writeFileSync(config, ' '.repeat(2 * 1024 * 1024 + 1)); expect(() => selectZCodeStorage(launch(), cwd, home)).toThrow('metadata');
  });
});

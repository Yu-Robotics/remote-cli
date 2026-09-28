import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { delegationMcpConfig } from '../../delegation/contract';

interface OriginalConfig { text?: string; link?: string; directoryLink?: string }

/** Keep AGY's MCP registration inside its existing per-thread HOME. */
export async function configureAgyDelegation(command: string, threadHome: string, enabled: boolean): Promise<void> {
  const directory = path.join(threadHome, '.gemini', 'config');
  const target = path.join(directory, 'mcp_config.json');
  const backup = path.join(directory, '.remote-cli-delegation-original.json');
  const stat = (file: string) => {
    try { return fs.lstatSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  if (!enabled && (!stat(directory) || stat(directory)?.isSymbolicLink() || !stat(backup))) return;
  let directoryLink: string | undefined;
  if (stat(directory)?.isSymbolicLink()) {
    directoryLink = fs.readlinkSync(directory);
    const source = fs.realpathSync(directory);
    // Detach only the symlink. Never modify or remove its global target.
    fs.unlinkSync(directory);
    fs.mkdirSync(directory, { mode: 0o700 });
    for (const entry of fs.readdirSync(source)) {
      fs.symlinkSync(path.join(source, entry), path.join(directory, entry));
    }
  } else fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const restore = (original: OriginalConfig) => {
    if (stat(target)) fs.unlinkSync(target);
    if (original.link) fs.symlinkSync(original.link, target);
    else if (original.text !== undefined) fs.writeFileSync(target, original.text, { mode: 0o600 });
  };
  const restoreDirectory = (original: OriginalConfig) => {
    if (!original.directoryLink) return;
    let source: string;
    try { source = fs.realpathSync(path.resolve(path.dirname(directory), original.directoryLink)); }
    catch { return; }
    const entries = fs.readdirSync(directory);
    // Retain any new thread-local files created by AGY. Otherwise restore the
    // directory link so future global configuration additions remain visible.
    if (!entries.every(name => stat(path.join(directory, name))?.isSymbolicLink()
      && fs.readlinkSync(path.join(directory, name)) === path.join(source, name))) return;
    for (const name of entries) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
    fs.symlinkSync(original.directoryLink, directory, 'dir');
  };
  if (!enabled) {
    const original = JSON.parse(fs.readFileSync(backup, 'utf8')) as OriginalConfig;
    restore(original);
    fs.unlinkSync(backup);
    restoreDirectory(original);
    return;
  }
  let original: OriginalConfig;
  if (stat(backup)) original = JSON.parse(fs.readFileSync(backup, 'utf8')) as OriginalConfig;
  else {
    original = stat(target)?.isSymbolicLink() ? { link: fs.readlinkSync(target) }
      : stat(target) ? { text: fs.readFileSync(target, 'utf8') } : {};
    original.directoryLink = directoryLink;
    fs.writeFileSync(backup, JSON.stringify(original), { mode: 0o600, flag: 'wx' });
  }
  restore(original);
  const text = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '{}';
  if (stat(target)) fs.unlinkSync(target);
  fs.writeFileSync(target, text, { mode: 0o600 });
  const server = delegationMcpConfig({ url: '', token: '' });
  try {
    // The native CLI handles JSON-with-comments and preserves other server
    // fields. Credentials are inherited from the process env, never persisted.
    await new Promise<void>((resolve, reject) => execFile(command,
      ['mcp', 'add', 'remote-cli-delegation', server.command, ...server.args],
      { env: { ...process.env, HOME: threadHome }, timeout: 10_000, maxBuffer: 16 * 1024 },
      error => error ? reject(new Error('AGY delegation requires working native "agy mcp add" support.')) : resolve()));
    fs.chmodSync(target, 0o600);
  } catch (error) {
    restore(original);
    fs.unlinkSync(backup);
    restoreDirectory(original);
    throw error;
  }
}

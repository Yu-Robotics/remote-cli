import { realpathSync } from 'fs';
import os from 'os';
import path from 'path';

export interface BackendPathOptions {
  pathValue?: string;
  homeDir: string;
  nodePath: string;
  platform: NodeJS.Platform;
  /** The resolved CLI entry, not an unverified bin symlink or relative path. */
  cliEntryPath?: string;
  npmPrefix?: string;
}

/** Add deterministic fallback locations without changing inherited precedence. */
export function buildBackendPath(options: BackendPathOptions): string {
  if (options.platform !== 'linux' && options.platform !== 'darwin') return options.pathValue ?? '';
  const entries = options.pathValue === undefined ? [] : options.pathValue.split(':');
  const candidates: string[] = [];
  const validAbsolute = (value: string | undefined): value is string =>
    !!value && path.posix.isAbsolute(value) && !/[\0\r\n:]/.test(value);

  if (validAbsolute(options.nodePath)) candidates.push(path.posix.dirname(options.nodePath));
  if (validAbsolute(options.cliEntryPath)) {
    const entry = path.posix.normalize(options.cliEntryPath);
    for (const suffix of ['/bin/remote-cli.js', '/dist/index.js']) {
      const layout = `/lib/node_modules/@yu_robotics/remote-cli${suffix}`;
      if (entry.endsWith(layout)) candidates.push(path.posix.join(entry.slice(0, -layout.length) || '/', 'bin'));
    }
  }
  if (validAbsolute(options.npmPrefix)) candidates.push(path.posix.join(options.npmPrefix, 'bin'));
  if (validAbsolute(options.homeDir)) {
    for (const directory of ['.local/bin', '.kimi-code/bin', '.npm-global/bin', '.bun/bin', '.opencode/bin']) {
      candidates.push(path.posix.join(options.homeDir, directory));
    }
  }
  if (options.platform === 'darwin') candidates.push('/opt/homebrew/bin');
  candidates.push('/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin');
  // Preserve inherited relative/empty entries; never synthesize new ones.
  return [...new Set([...entries, ...candidates])].join(':');
}

/** Resolve installation facts locally; never execute npm or source shell profiles. */
export function getBackendPath(overrides: Partial<BackendPathOptions> = {}): string {
  const platform = overrides.platform ?? process.platform;
  const pathValue = overrides.pathValue ?? process.env.PATH;
  if (platform !== 'linux' && platform !== 'darwin') return pathValue ?? '';
  const entry = overrides.cliEntryPath ?? process.argv[1];
  let resolvedEntry: string | undefined;
  if (entry && path.posix.isAbsolute(entry)) {
    try { resolvedEntry = realpathSync(entry); } catch { /* Unknown layouts do not imply a global prefix. */ }
  }
  return buildBackendPath({
    pathValue,
    platform,
    homeDir: overrides.homeDir ?? os.homedir(),
    nodePath: overrides.nodePath ?? process.execPath,
    cliEntryPath: resolvedEntry,
    npmPrefix: overrides.npmPrefix ?? process.env.npm_config_prefix,
  });
}

/** Only this process and its children receive the enriched environment. */
export function initializeBackendEnvironment(): void {
  if (process.platform === 'linux' || process.platform === 'darwin') process.env.PATH = getBackendPath();
}

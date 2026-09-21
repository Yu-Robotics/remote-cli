import { accessSync, constants, existsSync, realpathSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ZCodeLaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const PROVIDER_CONFIG = 'zcode-builtin.json';

function executableOnPath(name: string): string | null {
  if (name.includes(path.sep)) return existsSync(name) ? name : null;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function bundledCandidates(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [path.join(localAppData, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs')];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
      path.join(home, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'),
    ];
  }
  return [
    path.join(home, '.local', 'share', 'zcode', 'resources', 'glm', 'zcode.cjs'),
    '/opt/ZCode/resources/glm/zcode.cjs',
    '/usr/share/zcode/resources/glm/zcode.cjs',
  ];
}

export function findZCodeEntry(commandOverride?: string): string | null {
  const explicit = commandOverride ?? process.env.ZCODE_BIN;
  if (explicit) return executableOnPath(explicit) ?? (existsSync(explicit) ? explicit : null);
  const onPath = executableOnPath(process.platform === 'win32' ? 'zcode.exe' : 'zcode');
  if (onPath) return onPath;
  return bundledCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

function providerEnvironment(entry: string): NodeJS.ProcessEnv {
  if (!/\.(?:cjs|mjs|js)$/i.test(entry)) return {};
  const directory = path.dirname(path.resolve(entry));
  const builtin = [
    path.join(directory, 'provider', PROVIDER_CONFIG),
    path.join(directory, '..', 'config', 'provider', PROVIDER_CONFIG),
  ].find((candidate) => existsSync(candidate));
  if (!builtin) return {};
  const personal = path.join(process.env.ZCODE_HOME ?? path.join(os.homedir(), '.zcode'), 'v2', 'provider_config.json');
  return {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
    ...(existsSync(personal) ? { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal } : {}),
  };
}

export function resolveZCodeLaunch(commandOverride?: string): ZCodeLaunchSpec {
  const entry = findZCodeEntry(commandOverride) ?? commandOverride ?? process.env.ZCODE_BIN ?? 'zcode';
  let target = entry;
  try { target = realpathSync(entry); } catch {}
  const backendArgs = ['app-server', '--stdio', '--disallowed-tools', 'CronCreate CronList CronUpdate CronDelete'];
  const env = { ...process.env, ...providerEnvironment(target) };
  if (/\.(?:cjs|mjs|js)$/i.test(target)) {
    return {
      command: process.execPath,
      args: ['--no-network-family-autoselection', '--dns-result-order=ipv4first', target, ...backendArgs],
      env,
    };
  }
  return { command: entry, args: backendArgs, env };
}

export function isZCodeAvailable(commandOverride?: string): boolean {
  return findZCodeEntry(commandOverride) !== null;
}

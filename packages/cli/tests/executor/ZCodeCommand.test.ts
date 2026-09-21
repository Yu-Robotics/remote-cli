import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { findZCodeEntry, isZCodeAvailable, resolveZCodeLaunch } from '../../src/executor/zcode/ZCodeCommand';

describe('ZCodeCommand', () => {
  let temporaryDirectory: string;
  let originalZCodeHome: string | undefined;

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-command-test-'));
    originalZCodeHome = process.env.ZCODE_HOME;
  });

  afterEach(async () => {
    if (originalZCodeHome === undefined) delete process.env.ZCODE_HOME;
    else process.env.ZCODE_HOME = originalZCodeHome;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('launches the official bundled script through Node with provider config paths', async () => {
    const resources = path.join(temporaryDirectory, 'resources');
    const entry = path.join(resources, 'glm', 'zcode.cjs');
    const builtin = path.join(resources, 'config', 'provider', 'zcode-builtin.json');
    const zcodeHome = path.join(temporaryDirectory, '.zcode');
    const personal = path.join(zcodeHome, 'v2', 'provider_config.json');
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.mkdir(path.dirname(builtin), { recursive: true });
    await fs.mkdir(path.dirname(personal), { recursive: true });
    await Promise.all([
      fs.writeFile(entry, '#!/usr/bin/env node\n'),
      fs.writeFile(builtin, '{}'),
      fs.writeFile(personal, '{}'),
    ]);
    process.env.ZCODE_HOME = zcodeHome;

    const launch = resolveZCodeLaunch(entry);

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(expect.arrayContaining([
      '--no-network-family-autoselection',
      '--dns-result-order=ipv4first',
      entry,
      'app-server',
      '--stdio',
    ]));
    expect(launch.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBe(builtin);
    expect(launch.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toBe(personal);
    expect(findZCodeEntry(entry)).toBe(entry);
    expect(isZCodeAvailable(entry)).toBe(true);
  });

  it('launches an explicit native command directly', async () => {
    const command = path.join(temporaryDirectory, 'zcode');
    await fs.writeFile(command, 'binary');

    const launch = resolveZCodeLaunch(command);

    expect(launch.command).toBe(command);
    expect(launch.args.slice(0, 2)).toEqual(['app-server', '--stdio']);
  });

  it.skipIf(process.platform === 'win32')('resolves a PATH-style symlink to the bundled script', async () => {
    const entry = path.join(temporaryDirectory, 'resources', 'glm', 'zcode.cjs');
    const link = path.join(temporaryDirectory, 'bin', 'zcode');
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.writeFile(entry, '#!/usr/bin/env node\n');
    await fs.symlink(entry, link);

    const launch = resolveZCodeLaunch(link);

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toContain(entry);
  });
});

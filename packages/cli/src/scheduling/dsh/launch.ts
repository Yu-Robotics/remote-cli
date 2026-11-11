import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { DSH_PRIVACY_PATCH } from '../../executor/dsh/DshPrivacy';

/** A fresh, never resumed scope. Authentication and tool HOME retain normal native loading. */
export async function createLaunch(bridge = path.join(__dirname, 'HostBridge.js')) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-dsh-schedule-')));
  const scope = randomUUID();
  try {
    await fs.chmod(directory, 0o700);
    for (const name of ['sessions', 'storage', 'query', 'attachments']) await fs.mkdir(path.join(directory, name), { mode: 0o700 });
    // tsc includes the bridge and its relative imports in the published dist tree.
    if (!(await fs.stat(bridge)).isFile()) throw new Error('DSH schedule bridge is not built. Build the CLI before using this provider.');
    const rows: Array<Record<string, unknown>> = [
      { id: 'session-persistence-jsonl', config: { root: path.join(directory, 'sessions'), compression: 'none' } },
      { id: 'session-query-sqlite', config: { path: path.join(directory, 'query', 'index.sqlite'), openAt: 'never' } },
      { id: 'storage-json', config: { root: path.join(directory, 'storage') } },
      { id: 'storage-domain', config: { backend: 'json', routes: {} } },
      { id: 'attachment-local', config: { dshHome: path.join(directory, 'attachments') } },
      { id: 'acp', inject: ['acpAppStartup', 'remoteCliScheduleReady'] },
      { id: 'hmr', disabled: true },
      { insert: [
        ...['connection:dsh-client-connection', 'file-upload:dsh-client-file-upload', 'workspace:dsh-workspace',
          'session-controller:dsh-api-session-controller', 'tool-schedule:dsh-tool-schedule']
          .map(value => { const [id, name] = value.split(':'); return { id, name: `@deepseek-ai/${name}` }; }),
        { id: 'schedule', name: '@deepseek-ai/dsh-schedule', inject: ['remoteCliScheduleScope'] },
        { id: 'remote-cli-schedule-scope', name: path.join(path.dirname(bridge), 'ScopePlugin.js'), config: { directory, scope } },
        { id: 'remote-cli-schedule', name: bridge, config: { directory, scope } },
      ] },
    ];
    const filename = path.join(directory, 'schedule.patch.yml');
    // JSON flow mappings are YAML mappings; scalars safely preserve Windows paths.
    await fs.writeFile(filename, DSH_PRIVACY_PATCH + rows.map(row => `- ${JSON.stringify(row)}\n`).join(''), { mode: 0o600, flag: 'wx' });
    const identity = await fs.lstat(directory);
    return { directory, scope, args: ['--profile', 'acp', '--patch', filename], env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
      async dispose() {
        const current = await fs.lstat(directory);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
          || await fs.realpath(directory) !== directory) throw new Error('DSH schedule storage ownership changed.');
        await fs.rm(directory, { recursive: true, force: false });
      } };
  } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}
export type DshLaunch = Awaited<ReturnType<typeof createLaunch>>;

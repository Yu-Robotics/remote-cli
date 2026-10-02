import fs from 'fs';
import os from 'os';
import path from 'path';

/** These are independent upload paths. The telemetry environment flag only covers OTel. */
export const DSH_PRIVACY_PATCH = [
  '- id: session-log-deepseek',
  '  config:',
  '    enabled: false',
  '- id: session-telemetry-otel',
  '  config:',
  '    mode: DISABLED',
  '',
].join('\n');

/** A process-owned overlay, never an edit to the user's DSH profiles or credentials. */
export function createDshPrivacyLaunch(): { args: string[]; env: NodeJS.ProcessEnv; dispose: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-cli-dsh-privacy-'));
  const filename = path.join(directory, 'privacy.patch.yml');
  const dispose = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    fs.writeFileSync(filename, DSH_PRIVACY_PATCH, { mode: 0o600, flag: 'wx' });
    return {
      args: ['--profile', 'acp', '--patch', filename],
      env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

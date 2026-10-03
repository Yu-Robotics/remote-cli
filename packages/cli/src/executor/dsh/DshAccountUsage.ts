import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createDshPrivacyLaunch } from './DshPrivacy';

export const DSH_ACCOUNT_USAGE_PREFIX = 'REMOTE_CLI_DSH_ACCOUNT_USAGE:';
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RESULT_LENGTH = 4096;

export interface DshAccountUsageDependencies {
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
  killGraceMs?: number;
}

/** Project only wallet amounts; never expose profile fields or coerce decimal strings. */
export function formatDshAccountBalance(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.status !== 'ready') return null;
  const lines: string[] = [];
  for (const [key, label] of [['value', 'Recharge balance'], ['bonusWallets', 'Bonus balance']]) {
    const wallets = snapshot[key];
    if (!Array.isArray(wallets) || wallets.length > 32) return null;
    for (const wallet of wallets) {
      if (!wallet || !['CNY', 'USD'].includes(wallet.currency)
        || typeof wallet.balance !== 'string' || wallet.balance.length > 128
        || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(wallet.balance)) return null;
      lines.push(`- ${label}: ${wallet.currency} ${wallet.balance}`);
    }
  }
  const output = lines.join('\n');
  return output && output.length <= MAX_RESULT_LENGTH ? output : null;
}

/** Read the native account service without an ACP session, model turn, or Web server. */
export async function queryDshAccountUsage(command: string, cwd: string,
  dependencies: DshAccountUsageDependencies = {}): Promise<string | null> {
  let launch: ReturnType<typeof createDshPrivacyLaunch> | undefined;
  let child: ChildProcess;
  try {
    launch = createDshPrivacyLaunch();
    const plugin = pathToFileURL(path.join(__dirname, 'DshAccountUsagePlugin.js')).href;
    fs.appendFileSync(launch.args[3], [
      '- insert:',
      '    - id: remote-cli-dsh-account-usage',
      `      name: ${JSON.stringify(plugin)}`,
      '      config:',
      `        version: ${JSON.stringify(require('../../../package.json').version)}`,
      '        locale: en-US',
      `        timezoneOffsetSeconds: ${-new Date().getTimezoneOffset() * 60}`,
      '',
    ].join('\n'));
    child = (dependencies.spawnProcess ?? spawn)(command, launch.args,
      { cwd, env: launch.env, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    try { launch?.dispose(); } catch { /* Cleanup must not disclose native diagnostics. */ }
    return null;
  }

  return new Promise(resolve => {
    let settled = false;
    let completed = false;
    let result: string | null = null;
    let pending = '';
    let bytes = 0;
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => settle(null), dependencies.timeoutMs ?? 12_000);
    const complete = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      try { launch?.dispose(); } catch { /* Do not relay private native errors. */ }
      resolve(result);
    };
    const settle = (output: string | null) => {
      if (settled || completed) return;
      settled = true;
      result = output;
      clearTimeout(timeout);
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* The owned process may have exited. */ }
        complete();
      }, dependencies.killGraceMs ?? 2000);
      try { child.kill('SIGTERM'); } catch { /* The kill deadline still bounds cleanup. */ }
    };
    child.once('error', () => settle(null));
    child.once('exit', complete);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled || completed) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { settle(null); return; }
      pending += chunk.toString('utf8');
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.startsWith(DSH_ACCOUNT_USAGE_PREFIX)) continue;
        try {
          const message = JSON.parse(line.slice(DSH_ACCOUNT_USAGE_PREFIX.length));
          settle(typeof message?.output === 'string' && message.output.length <= MAX_RESULT_LENGTH
            ? message.output : null);
        } catch { settle(null); }
        return;
      }
    });
  });
}

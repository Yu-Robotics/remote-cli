import { spawn, type ChildProcess } from 'child_process';
import { stripAnsi } from '../../utils/stripAnsi';

const DEFAULT_TIMEOUT_MS = 12_000;
const KILL_GRACE_MS = 2_000;
const MAX_STARTUP_OUTPUT = 64 * 1024;

interface KimiQuotaEntry {
  usedRatio?: number;
  resetAt?: string;
}

interface KimiQuota {
  usages?: {
    limit5h?: KimiQuotaEntry;
    limit7d?: KimiQuotaEntry;
    monthTotal?: KimiQuotaEntry;
    monthCode?: KimiQuotaEntry;
  };
  extraUsage?: {
    balanceCents?: number;
    monthlyChargeLimitEnabled?: boolean;
    monthlyChargeLimitCents?: number;
    monthlyUsedCents?: number;
    currency?: string;
  } | null;
}

export interface KimiAccountUsageDependencies {
  spawnProcess?: typeof spawn;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function resetSuffix(value?: string): string {
  if (!value) return '';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return `, resets ${new Date(timestamp).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })}`;
}

function remainingPercent(entry: KimiQuotaEntry): number | null {
  if (typeof entry.usedRatio !== 'number' || !Number.isFinite(entry.usedRatio)) return null;
  return Math.round((1 - Math.max(0, Math.min(1, entry.usedRatio))) * 100);
}

function currency(cents: number | undefined, code: string | undefined): string | null {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return null;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code || 'USD',
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code || 'USD'}`;
  }
}

export function formatKimiAccountUsage(quota: KimiQuota): string | null {
  const lines: string[] = [];
  const appendQuota = (label: string, entry?: KimiQuotaEntry) => {
    if (!entry) return;
    const remaining = remainingPercent(entry);
    if (remaining !== null) lines.push(`- ${label}: ${remaining}% remaining${resetSuffix(entry.resetAt)}`);
  };
  appendQuota('5-hour quota', quota.usages?.limit5h);
  appendQuota('Weekly quota', quota.usages?.limit7d);
  appendQuota('Monthly quota', quota.usages?.monthTotal);

  const code = quota.usages?.monthCode;
  if (code && typeof code.usedRatio === 'number' && Number.isFinite(code.usedRatio)) {
    const used = Math.round(Math.max(0, Math.min(1, code.usedRatio)) * 100);
    lines.push(`- Monthly code usage: ${used}% used`);
  }

  const extra = quota.extraUsage;
  if (extra) {
    const used = currency(extra.monthlyUsedCents, extra.currency);
    const balance = currency(extra.balanceCents, extra.currency);
    if (used) lines.push(`- Extra usage this month: ${used}`);
    if (extra.monthlyChargeLimitEnabled) {
      const limit = currency(extra.monthlyChargeLimitCents, extra.currency);
      if (limit) lines.push(`- Extra usage monthly limit: ${limit}`);
    } else {
      lines.push('- Extra usage monthly limit: unlimited');
    }
    if (balance) lines.push(`- Extra usage balance: ${balance}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/** Query Kimi's own local authenticated server so account quota is not confused with ACP session usage. */
export function queryKimiAccountUsage(
  command: string,
  cwd: string,
  dependencies: KimiAccountUsageDependencies = {}
): Promise<string | null> {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(command, ['web', '--no-open', '--port', '0', '--log-level', 'silent'], {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    let exited = false;
    let requestStarted = false;
    let startupOutput = '';
    let controller: AbortController | null = null;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      controller?.abort();
      if (!exited) {
        child.kill('SIGTERM');
        const escalation = setTimeout(() => {
          if (!exited) child.kill('SIGKILL');
        }, KILL_GRACE_MS);
        escalation.unref?.();
      }
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), timeoutMs);
    timeout.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (requestStarted || settled) return;
      startupOutput = (startupOutput + stripAnsi(chunk.toString())).slice(-MAX_STARTUP_OUTPUT);
      const match = startupOutput.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+)\/#token=([^\s]+)/);
      if (!match) return;
      requestStarted = true;
      controller = new AbortController();
      void fetchImpl(`${match[1]}/api/v1/oauth/usage?provider=managed%3Akimi-code`, {
        headers: { Authorization: `Bearer ${match[2]}`, Accept: 'application/json' },
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) return null;
        const body = await response.json() as { data?: { kind?: string; quota?: KimiQuota } };
        return body.data?.kind === 'ok' && body.data.quota
          ? formatKimiAccountUsage(body.data.quota)
          : null;
      }).then(finish, () => finish(null));
    });
    child.once('error', () => finish(null));
    child.once('exit', () => {
      exited = true;
      finish(null);
    });
  });
}

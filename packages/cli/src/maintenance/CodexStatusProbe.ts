import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { CodexAppServerClient, type CodexAppServerClientOptions } from '../executor/CodexAppServerClient';
import { getBackendCommand } from '../utils/BackendCommand';
import type { ExecutorConfig } from '../types/config';
import { codexQuotaObservation, type CodexQuotaObservation } from './CodexQuota';

export interface StatusProbeClient {
  request(method: string, params?: unknown): Promise<any>;
  stop(): Promise<void>;
  onMessage(handler: (message: any) => void): () => void;
  respondError(id: string | number, message: string): void;
}
interface ProbeOptions {
  config: () => ExecutorConfig | undefined;
  nativeHome?: () => string;
  createClient?: (options: CodexAppServerClientOptions) => StatusProbeClient;
  now?: () => number;
  deadlineMs?: number;
}

/** Status only: existing native tokens are read locally, loaded ephemerally, and never refreshed or written by this feature. */
export class CodexStatusProbe {
  private readonly createClient: NonNullable<ProbeOptions['createClient']>;
  private readonly now: () => number;
  constructor(private readonly options: ProbeOptions) {
    this.createClient = options.createClient ?? (opts => new CodexAppServerClient(opts));
    this.now = options.now ?? Date.now;
  }

  async inspect(signal: AbortSignal): Promise<CodexQuotaObservation | undefined> {
    let temporary: string | undefined;
    let client: StatusProbeClient | undefined;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ensureActive = () => { if (timedOut || signal.aborted) throw new Error('Status probe cancelled.'); };
    let abort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        abort = () => { timedOut = true; reject(new Error('Status probe cancelled.')); };
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { timedOut = true; reject(new Error('Status probe deadline reached.')); }, this.options.deadlineMs ?? 15_000);
        timer.unref?.();
      });
      const operation = (async () => {
        ensureActive();
        const nativeHome = this.options.nativeHome?.() ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
        const authPath = path.join(nativeHome, 'auth.json');
        const stat = await fs.stat(authPath); ensureActive();
        if (!stat.isFile() || stat.size > 64 * 1024) return;
        const auth = JSON.parse(await fs.readFile(authPath, 'utf8')); ensureActive();
        // API-key/keyring/custom auth is unsupported, never substituted for a native ChatGPT account.
        const token = auth?.tokens?.access_token, accountId = auth?.tokens?.account_id;
        if (auth?.auth_mode === 'apikey' || typeof token !== 'string' || !token || token.length > 20000
          || typeof accountId !== 'string' || !accountId || accountId.length > 200) return;
        const credentialGeneration = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-status-')); ensureActive();
        await fs.chmod(temporary, 0o700); ensureActive();
        const env: NodeJS.ProcessEnv = {};
        for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
          if (process.env[name] !== undefined) env[name] = process.env[name];
        }
        env.CODEX_HOME = temporary;
        env.RUST_LOG = 'error';
        const overrides = ['cli_auth_credentials_store="ephemeral"', 'model_provider="openai"', 'forced_login_method="chatgpt"',
          'analytics.enabled=false', 'feedback.enabled=false', 'history.persistence="none"', 'web_search="disabled"',
          'features.shell_tool=false', 'features.apps=false', 'features.multi_agent=false'];
        client = this.createClient({ command: getBackendCommand('codex', this.options.config()), cwd: temporary, env,
          launchArgs: overrides.flatMap(v => ['-c', v]), requestTimeoutMs: 5000, killEscalationMs: 1000 });
        client.onMessage(message => {
          // A probe never executes server-requested integrations or token refresh callbacks.
          if (message.id != null && message.method) client?.respondError(message.id, 'Maintenance probes do not handle this request.');
        });
        // Unknown native versions or managed overrides must not silently turn ephemeral auth into a disk write.
        const configured = await Promise.race([client.request('config/read', { includeLayers: false }), deadline]); ensureActive();
        const effective = configured?.config;
        if (effective?.cli_auth_credentials_store !== 'ephemeral' || effective.model_provider !== 'openai'
          || effective.analytics?.enabled !== false || effective.feedback?.enabled !== false
          || Object.values(effective.mcp_servers ?? {}).some((server: any) => server?.enabled !== false)) return;
        const login = await Promise.race([client.request('account/login/start', { type: 'chatgptAuthTokens', accessToken: token, chatgptAccountId: accountId }), deadline]); ensureActive();
        if (login?.type !== 'chatgptAuthTokens') return;
        const raw = await Promise.race([client.request('account/rateLimits/read', { excludeResetCreditDetails: true }), deadline]); ensureActive();
        const after = await fs.stat(authPath); ensureActive();
        if (`${after.ino}:${after.size}:${after.mtimeMs}` !== credentialGeneration) return;
        return codexQuotaObservation(raw, accountId, credentialGeneration, this.now());
      })();
      // Wait for setup to settle before cleanup, even if a local filesystem operation finishes after the deadline.
      try { return await Promise.race([operation, deadline]); }
      finally { timedOut = true; await operation.catch(() => {}); }
    } catch { return; }
    finally {
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
      try { await client?.stop(); }
      catch { /* Never delete a credential-free temporary home while its process exit is unconfirmed. */ temporary = undefined; }
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

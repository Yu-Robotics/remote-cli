import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CodexStatusProbe } from '../../src/maintenance/CodexStatusProbe';
import { WEEK_SECONDS } from '../../src/maintenance/CodexWeekly';

describe('independent status-only Codex probe', () => {
  let nativeHome: string;
  let client: any;
  let launch: any;
  let probe: CodexStatusProbe;
  const time = 1800000000000;
  beforeEach(async () => {
    nativeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'native-auth-fixture-'));
    await fs.writeFile(path.join(nativeHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-token-not-a-credential', account_id: 'account-fixture' } }));
    client = { stop: vi.fn().mockResolvedValue(undefined), onMessage: vi.fn(), respondError: vi.fn(),
      request: vi.fn(async (method: string) => method === 'config/read' ? { config: {
        cli_auth_credentials_store: 'ephemeral', model_provider: 'openai', analytics: { enabled: false }, feedback: { enabled: false }, mcp_servers: {},
      } } : method === 'account/login/start' ? { type: 'chatgptAuthTokens' } : {
        accountId: 'account-fixture', rateLimits: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: time / 1000 + WEEK_SECONDS } },
      }) };
    probe = new CodexStatusProbe({ config: () => ({ type: 'codex', codex: { command: 'fixture-codex', model: 'custom-thread-model' } }),
      nativeHome: () => nativeHome, now: () => time, createClient: options => { launch = options; return client; }, deadlineMs: 50 });
  });
  afterEach(async () => { await fs.rm(nativeHome, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  it('uses ephemeral native auth and a private clean home, without user config, custom providers, threads or prompts', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-api-fixture'); vi.stubEnv('OPENAI_BASE_URL', 'https://provider.example.com');
    await fs.writeFile(path.join(nativeHome, 'config.toml'), '[mcp_servers.fixture]\ncommand="should-never-start"');
    const authBefore = await fs.readFile(path.join(nativeHome, 'auth.json'), 'utf8');
    expect(await probe.inspect(new AbortController().signal)).toMatchObject({ weekly: { candidate: true } });
    expect(client.request.mock.calls.map((c: any[]) => c[0])).toEqual(['config/read', 'account/login/start', 'account/rateLimits/read']);
    expect(launch.command).toBe('fixture-codex'); expect(launch.cwd).not.toBe(nativeHome);
    expect(launch.env.CODEX_HOME).toBe(launch.cwd);
    expect(launch.env.OPENAI_API_KEY).toBeUndefined(); expect(launch.env.OPENAI_BASE_URL).toBeUndefined();
    expect(launch.launchArgs).toContain('cli_auth_credentials_store="ephemeral"');
    expect(client.stop).toHaveBeenCalledTimes(1); await expect(fs.stat(launch.cwd)).rejects.toThrow();
    expect(await fs.readFile(path.join(nativeHome, 'auth.json'), 'utf8')).toBe(authBefore);
    const callback = client.onMessage.mock.calls[0][0]; callback({ method: 'account/chatgptAuthTokens/refresh', id: 1 });
    expect(client.respondError).toHaveBeenCalled();
  });
  it('reads banked counts from the existing count-only request without requiring weekly quota or consuming a credit', async () => {
    const request = client.request.getMockImplementation();
    client.request.mockImplementation(async (method: string) => method === 'account/rateLimits/read'
      ? { accountId: 'account-fixture', rateLimitResetCredits: { availableCount: 2, credits: null } } : request(method));
    const result = await probe.inspect(new AbortController().signal);
    expect(result).toMatchObject({ bankedResetCount: 2 });
    expect(result?.weekly).toBeUndefined();
    expect(client.request).toHaveBeenCalledWith('account/rateLimits/read', { excludeResetCreditDetails: true });
    expect(client.request.mock.calls.map((c: any[]) => c[0])).toEqual(['config/read', 'account/login/start', 'account/rateLimits/read']);
    expect(client.stop).toHaveBeenCalledTimes(1);
    await expect(fs.stat(launch.cwd)).rejects.toThrow();
  });
  it('fails closed for unsupported credentials or account mismatch instead of making a model turn', async () => {
    await fs.writeFile(path.join(nativeHome, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-fixture' }));
    expect(await probe.inspect(new AbortController().signal)).toBeUndefined(); expect(client.request).not.toHaveBeenCalled();
    await fs.writeFile(path.join(nativeHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'synthetic', account_id: 'different-account' } }));
    expect(await probe.inspect(new AbortController().signal)).toBeUndefined();
    expect(client.request.mock.calls.map((c: any[]) => c[0])).not.toContain('turn/start');
  });
  it('bounds a hung status/initialize path and cleans up only the independent process', async () => {
    client.request.mockImplementation(() => new Promise(() => {}));
    const keepAlive = setTimeout(() => {}, 100);
    expect(await probe.inspect(new AbortController().signal)).toBeUndefined();
    clearTimeout(keepAlive);
    expect(client.stop).toHaveBeenCalledTimes(1);
    await expect(fs.stat(launch.cwd)).rejects.toThrow();
  });
  it('honors cancellation and does not start a client for a pre-aborted probe', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await probe.inspect(controller.signal)).toBeUndefined(); expect(client.request).not.toHaveBeenCalled();
  });
  it('fails closed before transmitting credentials if native config or managed overrides break isolation', async () => {
    client.request.mockResolvedValue({ config: { cli_auth_credentials_store: 'file', model_provider: 'openai' } });
    expect(await probe.inspect(new AbortController().signal)).toBeUndefined();
    expect(client.request.mock.calls.map((c: any[]) => c[0])).toEqual(['config/read']);
    expect(client.stop).toHaveBeenCalledTimes(1);
  });
});

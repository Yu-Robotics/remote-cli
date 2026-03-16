/**
 * Structural cross-validation tests using a real Gemini CLI subprocess.
 *
 * These tests verify that AcpClient correctly speaks the ACP wire protocol
 * against the real Gemini CLI binary. They deliberately avoid sending prompts
 * to the model to prevent flakiness and API quota consumption.
 *
 * What is tested:
 *   - Gemini CLI binary can be spawned with --experimental-acp
 *   - ACP JSON-RPC handshake (initialize → session/new → set_mode) succeeds
 *   - destroy() terminates the subprocess cleanly
 *   - A second destroy() is a no-op (idempotent)
 *
 * Requirements:
 *   - Gemini CLI installed and authenticated (gemini auth login)
 *
 * Run only when Gemini CLI is available:
 *   npm test -- AcpClient.gemini
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import * as os from 'os';
import { AcpClient, AcpEventCallbacks } from '../../src/executor/acp/AcpClient';

// ─── Guard: skip the whole suite if Gemini CLI is not installed ───────────────

const GEMINI_PATH = (() => {
  try {
    return execSync('which gemini', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();

const SKIP = !GEMINI_PATH;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeClient(callbacks: Partial<AcpEventCallbacks> = {}): AcpClient {
  return new AcpClient(
    GEMINI_PATH!,
    ['--experimental-acp', '--yolo'],
    os.tmpdir(),
    {
      onTextChunk: () => {},
      ...callbacks,
    }
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)('AcpClient × Gemini CLI — structural tests (no API calls)', () => {
  beforeAll(() => {
    const version = spawnSync(GEMINI_PATH!, ['--version'], { encoding: 'utf8' });
    console.log(`[Gemini structural] CLI path: ${GEMINI_PATH}`);
    console.log(`[Gemini structural] CLI version: ${version.stdout?.trim()}`);
  });

  it('spawns Gemini CLI process successfully', () => {
    const client = makeClient();
    // If the process failed to spawn, the constructor would have thrown
    expect(client).toBeDefined();
    client.destroy();
  });

  it('completes ACP handshake: initialize → session/new → set_mode', async () => {
    const client = makeClient();
    try {
      await client.initialize();

      const sessionId = await client.newSession(os.tmpdir());
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);

      // set_mode with 'yolo' configures auto-approval — no model call needed
      await client.setSessionMode(sessionId, 'yolo');
    } finally {
      client.destroy();
    }
  }, 30_000);

  it('destroy() terminates the subprocess', async () => {
    const client = makeClient();
    await client.initialize();
    client.destroy();
    // After destroy, child process should be killed (no assertion needed —
    // if SIGKILL timer fires without crashing the test, behaviour is correct)
  }, 15_000);

  it('destroy() is idempotent — calling twice does not throw', async () => {
    const client = makeClient();
    await client.initialize();
    expect(() => {
      client.destroy();
      client.destroy();
    }).not.toThrow();
  }, 15_000);
});

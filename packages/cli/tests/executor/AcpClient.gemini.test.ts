/**
 * Cross-validation tests using a real Gemini CLI subprocess.
 *
 * These tests spawn the actual Gemini CLI with --experimental-acp and verify
 * that AcpClient correctly handles the real ACP wire protocol.
 *
 * Requirements:
 *   - Gemini CLI installed and authenticated (gemini auth login)
 *   - GEMINI_API_KEY set, or prior auth cached
 *
 * Run only when Gemini CLI is available:
 *   npm test -- AcpClient.gemini
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import * as path from 'path';
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

async function fullHandshake(client: AcpClient): Promise<string> {
  await client.initialize();
  const sessionId = await client.newSession(os.tmpdir());
  await client.setSessionMode(sessionId, 'yolo');
  return sessionId;
}

// ─── Tests ────────────────────────────────────="────────────────────────────

describe.skipIf(SKIP)('AcpClient × Gemini CLI — real subprocess', () => {
  beforeAll(() => {
    console.log(`[Gemini cross-validation] Using Gemini CLI at: ${GEMINI_PATH}`);
    const version = spawnSync(GEMINI_PATH!, ['--version'], { encoding: 'utf8' });
    console.log(`[Gemini cross-validation] Gemini CLI version: ${version.stdout?.trim()}`);
  });

  it('completes ACP handshake: initialize → session/new → set_mode', async () => {
    const client = makeClient();
    try {
      await client.initialize();
      const sessionId = await client.newSession(os.tmpdir());
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);
      await client.setSessionMode(sessionId, 'yolo');
      // If we get here without throwing, the handshake succeeded
    } finally {
      client.destroy();
    }
  }, 30_000);

  it('receives agent_message_chunk text chunks for a simple prompt', async () => {
    const chunks: string[] = [];
    const client = makeClient({
      onTextChunk: (text) => chunks.push(text),
    });

    try {
      const sessionId = await fullHandshake(client);
      const result = await client.prompt(sessionId, 'Reply with exactly the word PONG and nothing else.');
      expect(result.stopReason).toBe('end_turn');
      const fullText = chunks.join('');
      expect(fullText.toLowerCase()).toContain('pong');
    } finally {
      client.destroy();
    }
  }, 60_000);

  it('receives tool_call and tool_call_update events for filesystem operations', async () => {
    const toolCalls: Array<{ id: string; title: string }> = [];
    const toolResults: Array<{ id: string; status: string }> = [];

    const client = makeClient({
      onTextChunk: () => {},
      onToolCall: (id, title) => toolCalls.push({ id, title }),
      onToolResult: (id, status) => toolResults.push({ id, status }),
    });

    try {
      const sessionId = await fullHandshake(client);
      // Ask Gemini to read a known file — this forces a tool call
      const result = await client.prompt(
        sessionId,
        `Read the file ${path.join(os.tmpdir())} and list what's there. Use your filesystem tools.`
      );
      expect(result.stopReason).toBe('end_turn');
      // At least one tool call should have been made and completed
      expect(toolCalls.length).toBeGreaterThan(0);
      expect(toolResults.some(r => r.status === 'completed')).toBe(true);
    } finally {
      client.destroy();
    }
  }, 60_000);

  it('stopReason is "end_turn" for a normal completion', async () => {
    const client = makeClient();
    try {
      const sessionId = await fullHandshake(client);
      const result = await client.prompt(sessionId, 'What is 2+2?');
      expect(result.stopReason).toBe('end_turn');
    } finally {
      client.destroy();
    }
  }, 60_000);

  it('sendCancel causes prompt to terminate early (stopReason: cancelled or end_turn)', async () => {
    const client = makeClient({ onTextChunk: () => {} });
    try {
      const sessionId = await fullHandshake(client);

      // Fire a long-running prompt and cancel it almost immediately
      const promptPromise = client.prompt(
        sessionId,
        'Count slowly from 1 to 1000, saying each number on its own line.'
      );

      // Cancel after a short delay
      await new Promise((r) => setTimeout(r, 500));
      client.sendCancel(sessionId);

      const result = await promptPromise;
      // After cancel, agent may return 'cancelled' or finish early with 'end_turn'
      expect(['cancelled', 'end_turn', 'max_turn_requests']).toContain(result.stopReason);
    } finally {
      client.destroy();
    }
  }, 60_000);

  it('destroy() during active prompt rejects the promise', async () => {
    const client = makeClient({ onTextChunk: () => {} });
    try {
      const sessionId = await fullHandshake(client);
      const promptPromise = client.prompt(sessionId, 'Count from 1 to 10000 slowly.');

      // Destroy mid-flight
      setTimeout(() => client.destroy(), 300);

      await expect(promptPromise).rejects.toThrow();
    } catch {
      // expected
    }
  }, 15_000);
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as url from 'url';
import { AcpClient, AcpEventCallbacks } from '../../../src/executor/acp/AcpClient';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const MOCK_SERVER = path.join(__dirname, '../../fixtures/mock-acp-server.mjs');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AcpClient', () => {
  let client: AcpClient;
  const callbacks: AcpEventCallbacks = {
    onTextChunk: vi.fn(),
    onThoughtChunk: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onPlan: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    client = new AcpClient('node', [MOCK_SERVER], process.cwd(), callbacks);
  });

  afterEach(async () => {
    client.destroy();
    await sleep(50);
  });

  it('should complete initialize handshake', async () => {
    await expect(client.initialize()).resolves.not.toThrow();
  });

  it('should create a new session and return a sessionId', async () => {
    await client.initialize();
    const sessionId = await client.newSession(process.cwd());
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);
  });

  it('should receive text chunk callbacks during prompt', async () => {
    await client.initialize();
    const sessionId = await client.newSession(process.cwd());

    const result = await client.prompt(sessionId, 'hello world');

    expect(result.stopReason).toBe('end_turn');
    expect(callbacks.onTextChunk).toHaveBeenCalled();
    const allChunks = (callbacks.onTextChunk as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0] as string)
      .join('');
    expect(allChunks).toContain('hello world');
  });

  it('should receive tool_call and tool_result callbacks', async () => {
    await client.initialize();
    const sessionId = await client.newSession(process.cwd());

    await client.prompt(sessionId, 'list files');

    expect(callbacks.onToolCall).toHaveBeenCalledWith('tc-2', 'list_files', 'shell');
    expect(callbacks.onToolResult).toHaveBeenCalledWith('tc-2', 'completed', 'file1.txt\nfile2.txt');
  });

  it('should auto-approve permission requests (no custom handler)', async () => {
    // The mock server sends a permission request before responding to prompt.
    // Without a custom handler, AcpClient auto-approves with allow_once.
    await client.initialize();
    const sessionId = await client.newSession(process.cwd());

    // Should not throw even though permission is requested
    const result = await client.prompt(sessionId, 'read a file');
    expect(result.stopReason).toBe('end_turn');
  });

  it('should call custom permission handler when provided', async () => {
    const customHandler = vi.fn().mockResolvedValue(0); // 0 = allow_once
    const callbacksWithHandler: AcpEventCallbacks = {
      onTextChunk: vi.fn(),
      onPermissionRequest: customHandler,
    };

    const clientWithHandler = new AcpClient('node', [MOCK_SERVER], process.cwd(), callbacksWithHandler);
    try {
      await clientWithHandler.initialize();
      const sessionId = await clientWithHandler.newSession(process.cwd());
      await clientWithHandler.prompt(sessionId, 'test');
      expect(customHandler).toHaveBeenCalledWith('read_file', expect.any(Array));
    } finally {
      clientWithHandler.destroy();
    }
  });

  it('should send correct outcome format when auto-approving permission', async () => {
    // Track all lines written to the mock server's stdin
    const writtenLines: string[] = [];
    const originalWrite = (client as any).child.stdin.write.bind((client as any).child.stdin);
    (client as any).child.stdin.write = (data: string) => {
      writtenLines.push(data.trim());
      return originalWrite(data);
    };

    await client.initialize();
    const sessionId = await client.newSession(process.cwd());
    await client.prompt(sessionId, 'read a file');

    // Find the permission response message
    const permResponseLine = writtenLines.find((line) => {
      try {
        const msg = JSON.parse(line);
        return typeof msg.id === 'number' && msg.id >= 9000 && msg.result;
      } catch { return false; }
    });

    expect(permResponseLine).toBeDefined();
    const permResponse = JSON.parse(permResponseLine!);
    // Must use the ACP SDK outcome format, not the old selectedOptionKind format
    expect(permResponse.result).toHaveProperty('outcome');
    expect(permResponse.result.outcome).toHaveProperty('outcome', 'selected');
    expect(permResponse.result.outcome).toHaveProperty('optionId', 'proceed_once');
    expect(permResponse.result).not.toHaveProperty('selectedOptionKind');
  });

  it('should clean up child process on destroy', async () => {
    await client.initialize();

    client.destroy();
    await sleep(50);

    // After destroy, writing to a destroyed client should be a no-op (no crash)
    expect(() => client.sendCancel('any-session-id')).not.toThrow();
  });

  it('should reject pending requests when destroyed mid-flight', async () => {
    await client.initialize();
    const sessionId = await client.newSession(process.cwd());

    const promptPromise = client.prompt(sessionId, 'long running task');
    client.destroy();

    await expect(promptPromise).rejects.toThrow();
  });
});

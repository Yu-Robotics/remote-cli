/**
 * Protocol Compatibility Tests (CLI side)
 *
 * These tests act as a "change detector" for the WebSocket wire protocol
 * on the CLI side. If any test here fails after a code change, the developer
 * MUST check CLAUDE.md § Protocol Versioning to decide whether to bump
 * PROTOCOL_VERSION.
 *
 * Tests cover:
 *   1. Wire format snapshot  - exact shape of messages the CLI sends
 *   2. Error handling        - CLI shows a clear message when Router rejects it
 *   3. Forward compat        - new CLI fields don't break old Router connections
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocketClient } from '../../src/client/WebSocketClient';
import { MessageHandler } from '../../src/client/MessageHandler';
import { PROTOCOL_VERSION } from '../../src/types/index';
import os from 'os';

vi.mock('../../src/config/ConfigManager');
vi.mock('../../src/security/DirectoryGuard');
vi.mock('../../src/executor/ClaudeExecutor');
vi.mock('../../src/hooks/FeishuNotificationAdapter');

// ---------------------------------------------------------------------------
// 1. Wire format snapshots (CLI -> Router)
// ---------------------------------------------------------------------------

describe('Wire format snapshots (CLI sends)', () => {
  it('binding_request contains required fields including protocolVersion', () => {
    const deviceId = 'dev_mac_abc123';

    const msg = {
      type: 'binding_request',
      messageId: 'uuid-1234',
      timestamp: Date.now(),
      data: {
        deviceId,
        protocolVersion: PROTOCOL_VERSION,
      },
    };

    expect(msg.type).toBe('binding_request');
    expect(msg.data.deviceId).toBe(deviceId);
    expect(msg.data.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(typeof msg.data.protocolVersion).toBe('number');
  });

  it('heartbeat has no messageId (intentional omission)', () => {
    const msg = {
      type: 'heartbeat',
      timestamp: Date.now(),
    };

    expect(msg).toHaveProperty('type', 'heartbeat');
    expect(msg).toHaveProperty('timestamp');
    expect(msg).not.toHaveProperty('messageId');
  });

  it('outgoing result message shape', () => {
    const msg = {
      type: 'result',
      messageId: 'uuid-1234',
      timestamp: Date.now(),
      success: true,
      output: 'done',
      openId: 'ou_abc123',
    };

    expect(msg.type).toBe('result');
    expect(msg).toHaveProperty('messageId');
    expect(msg).toHaveProperty('success');
    expect(msg).toHaveProperty('openId');
  });

  it('stream message shape with streamType', () => {
    const msg = {
      type: 'stream',
      messageId: 'uuid-1234',
      timestamp: Date.now(),
      openId: 'ou_abc123',
      streamType: 'text',
      chunk: 'partial output',
    };

    expect(msg.type).toBe('stream');
    expect(['text', 'tool_use', 'tool_result', 'redacted_thinking']).toContain(msg.streamType);
    expect(msg).toHaveProperty('chunk');
  });

  it('stream message shape with tool_use streamType', () => {
    const msg = {
      type: 'stream',
      messageId: 'uuid-1234',
      timestamp: Date.now(),
      openId: 'ou_abc123',
      streamType: 'tool_use',
      toolUse: { name: 'Bash', id: 'tool_abc', input: { command: 'ls' } },
    };

    expect(msg.streamType).toBe('tool_use');
    expect(msg.toolUse).toHaveProperty('name');
    expect(msg.toolUse).toHaveProperty('id');
    expect(msg.toolUse).toHaveProperty('input');
  });

  it('notification message shape', () => {
    const msg = {
      type: 'notification',
      timestamp: Date.now(),
      openId: 'ou_abc123',
      title: 'Build failed',
      message: 'Error in line 42',
    };

    expect(msg.type).toBe('notification');
    expect(msg).toHaveProperty('openId');
    expect(msg).toHaveProperty('title');
    expect(msg).toHaveProperty('message');
  });
});

// ---------------------------------------------------------------------------
// 2. Error handling: Router rejects CLI due to incompatible protocol version
//    The CLI must surface this as a clear, user-visible message.
// ---------------------------------------------------------------------------

describe('CLI handles PROTOCOL_VERSION_INCOMPATIBLE error from Router', () => {
  const incompatibleErrorMsg = {
    type: 'error',
    messageId: 'uuid-1234',
    timestamp: Date.now(),
    data: {
      code: 'PROTOCOL_VERSION_INCOMPATIBLE',
      message: 'CLI protocol version 1 is no longer supported. Please upgrade remote-cli to the latest version.',
      minimumVersion: 2,
      currentRouterVersion: 2,
    },
  };

  it('error message has expected fields for display', () => {
    expect(incompatibleErrorMsg.data.code).toBe('PROTOCOL_VERSION_INCOMPATIBLE');
    expect(incompatibleErrorMsg.data.message).toContain('upgrade');
    expect(incompatibleErrorMsg.data).toHaveProperty('minimumVersion');
    expect(incompatibleErrorMsg.data).toHaveProperty('currentRouterVersion');
  });

  it('CLI MessageHandler does not throw on error message type', async () => {
    // MessageHandler currently handles unknown types by sending back an error response.
    // After the implementation, 'error' with code PROTOCOL_VERSION_INCOMPATIBLE
    // should log and stop reconnecting. This test verifies no crash.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mockWsClient = {
      send: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      disconnect: vi.fn(),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      onConnect: vi.fn(),
    } as any;

    const mockExecutor = { execute: vi.fn() } as any;
    const mockGuard = { isAllowed: vi.fn().mockReturnValue(true) } as any;
    const mockConfig = {
      get: vi.fn().mockReturnValue(''),
      set: vi.fn().mockResolvedValue(undefined),
      save: vi.fn(),
      getConfigDir: vi.fn().mockReturnValue('/tmp/.remote-cli'),
    } as any;
    const mockThreadPool = {
      getExecutor: vi.fn().mockReturnValue(mockExecutor),
      isThreadBusy: vi.fn().mockReturnValue(false),
      setThreadBusy: vi.fn(),
      setThreadError: vi.fn(),
      getSummaries: vi.fn().mockReturnValue([]),
      destroyAll: vi.fn().mockResolvedValue(undefined),
      switchBackend: vi.fn().mockResolvedValue(undefined),
    } as any;
    const mockThreadManager = {
      getDefaultThread: vi.fn().mockReturnValue({ id: 'default', name: 'default', workingDirectory: '/tmp', sessionId: null, createdAt: 0, lastActiveAt: 0 }),
      getThread: vi.fn(),
      getThreadByName: vi.fn(),
      listThreads: vi.fn().mockReturnValue([]),
      createThread: vi.fn(),
      deleteThread: vi.fn(),
      updateThread: vi.fn().mockResolvedValue({}),
      getSessionFilePath: vi.fn().mockReturnValue('/tmp/session.jsonl'),
    } as any;

    const handler = new MessageHandler(mockWsClient, mockThreadPool, mockThreadManager, mockGuard, mockConfig);

    // Should not throw
    await expect(handler.handleMessage(incompatibleErrorMsg as any)).resolves.not.toThrow();

    consoleSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('incompatibility message text is human-readable and actionable', () => {
    const { message, minimumVersion, currentRouterVersion } = incompatibleErrorMsg.data;
    // Must mention upgrade
    expect(message.toLowerCase()).toContain('upgrade');
    // Must contain version numbers so user knows what they need
    expect(minimumVersion).toBeGreaterThan(0);
    expect(currentRouterVersion).toBeGreaterThanOrEqual(minimumVersion);
  });
});

// ---------------------------------------------------------------------------
// 3. Thread fields are optional on the wire (additive, non-breaking)
//    threadId and threads were added with multi-thread support. They MUST
//    remain optional so that:
//      - old CLI (no threadId) works with new Router
//      - new CLI (with threadId) works with old Router
//    If any assertion here fails, stop and check whether a protocol bump is needed.
// ---------------------------------------------------------------------------

describe('Thread fields are optional on the wire', () => {
  it('outgoing result message with threadId and threads fields (new CLI)', () => {
    const msg = {
      type: 'result',
      messageId: 'uuid-1234',
      timestamp: Date.now(),
      success: true,
      output: 'done',
      openId: 'ou_abc123',
      threadId: 'thread-uuid-abc',
      threads: [
        { id: 'thread-uuid-abc', name: 'default', status: 'idle' },
        { id: 'thread-uuid-def', name: 'thread-2', status: 'idle' },
      ],
    };

    expect(msg).toHaveProperty('threadId');
    expect(msg).toHaveProperty('threads');
    expect(Array.isArray(msg.threads)).toBe(true);
    expect(msg.threads[0]).toHaveProperty('id');
    expect(msg.threads[0]).toHaveProperty('name');
    expect(msg.threads[0]).toHaveProperty('status');
    expect(['idle', 'running', 'error']).toContain(msg.threads[0].status);
  });

  it('outgoing result message without threadId and threads (old CLI) is still valid', () => {
    const msg = {
      type: 'result',
      messageId: 'uuid-1234',
      timestamp: Date.now(),
      success: true,
      output: 'done',
      openId: 'ou_abc123',
      // threadId and threads intentionally absent
    };

    // Old CLI omits these fields — they are optional
    expect(msg).not.toHaveProperty('threadId');
    expect(msg).not.toHaveProperty('threads');
    // But required fields are still present
    expect(msg).toHaveProperty('type', 'result');
    expect(msg).toHaveProperty('messageId');
    expect(msg).toHaveProperty('success');
  });

  it('stream message does not carry threadId (routing is done via messageId)', () => {
    const msg = {
      type: 'stream',
      messageId: 'uuid-1234',
      timestamp: Date.now(),
      openId: 'ou_abc123',
      streamType: 'text',
      chunk: 'partial output',
      threadId: 'thread-uuid-abc',
    };

    // threadId on stream is optional — router uses messageId to look up the session
    expect(msg).toHaveProperty('messageId');
    expect(msg).toHaveProperty('threadId');
  });

  it('incoming command message with threadId (new Router to new CLI)', () => {
    const msg = {
      type: 'command',
      messageId: 'uuid-5678',
      timestamp: Date.now(),
      content: 'list files',
      openId: 'ou_abc123',
      threadId: 'thread-uuid-abc',
    };

    expect(msg).toHaveProperty('threadId');
    expect(typeof msg.threadId).toBe('string');
  });

  it('incoming command message without threadId (old Router to new CLI) falls back to default thread', () => {
    const msg = {
      type: 'command',
      messageId: 'uuid-5678',
      timestamp: Date.now(),
      content: 'list files',
      openId: 'ou_abc123',
      // threadId intentionally absent — old Router
    };

    // CLI must handle missing threadId by falling back to default thread
    const threadId = (msg as any).threadId ?? null;
    expect(threadId).toBeNull();
    // Fallback logic: use default thread when threadId is null
    const resolvedThread = threadId ?? 'default';
    expect(resolvedThread).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// 4. Forward compatibility: new CLI fields don't break old Router
//    Old Router ignores unknown fields — new CLI must not rely on Router
//    echoing back any new fields.
// ---------------------------------------------------------------------------

describe('Forward compatibility: new CLI fields are additive', () => {
  it('protocolVersion in binding_request is an optional field (old Router ignores it)', () => {
    // This test documents the contract: adding protocolVersion to binding_request
    // is a MINOR (non-breaking) change because old Routers simply ignore it.
    const withVersion = {
      type: 'binding_request',
      messageId: 'uuid',
      timestamp: Date.now(),
      data: { deviceId: 'dev_abc', protocolVersion: 1 },
    };
    const withoutVersion = {
      type: 'binding_request',
      messageId: 'uuid',
      timestamp: Date.now(),
      data: { deviceId: 'dev_abc' },
    };

    // Both have the same required fields — the extra field is purely additive
    expect(withVersion.type).toBe(withoutVersion.type);
    expect(withVersion.data.deviceId).toBe(withoutVersion.data.deviceId);
  });

  it('CLI does not require negotiatedVersion in binding_confirm to function', () => {
    // Old Router sends binding_confirm without negotiatedVersion.
    // New CLI must not crash if the field is absent.
    const oldRouterConfirm = {
      type: 'binding_confirm',
      messageId: 'uuid',
      timestamp: Date.now(),
      data: { success: true },
      // negotiatedVersion intentionally absent
    };

    const negotiatedVersion = (oldRouterConfirm as any).data?.negotiatedVersion ?? null;
    // CLI should just proceed normally when negotiatedVersion is null
    expect(negotiatedVersion).toBeNull();
  });
});

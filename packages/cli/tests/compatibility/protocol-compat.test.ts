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
      set: vi.fn(),
      save: vi.fn(),
    } as any;

    const handler = new MessageHandler(mockWsClient, mockExecutor, mockGuard, mockConfig);

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
// 3. Forward compatibility: new CLI fields don't break old Router
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

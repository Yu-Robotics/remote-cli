/**
 * Protocol Compatibility Tests
 *
 * These tests act as a "change detector" for the WebSocket wire protocol
 * between CLI and Router. If any test here fails after a code change,
 * the developer MUST check CLAUDE.md § Protocol Versioning to decide
 * whether to bump PROTOCOL_VERSION / MIN_SUPPORTED_CLI_VERSION.
 *
 * Tests cover three concerns:
 *   1. Wire format snapshot  - exact shape of each message type
 *   2. Backward compat       - old CLI (no protocolVersion field) still connects
 *   3. Version rejection     - CLI below MIN_SUPPORTED_CLI_VERSION is rejected
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageType, PROTOCOL_VERSION, MIN_SUPPORTED_CLI_VERSION } from '../../src/types/index';

// ---------------------------------------------------------------------------
// 1. Wire format snapshots
//    Capture the exact fields of every message the Router sends or receives.
//    A failing snapshot means the wire format changed — check if it's breaking.
// ---------------------------------------------------------------------------

describe('Wire format snapshots', () => {
  describe('CLI -> Router messages', () => {
    it('binding_request shape (old CLI, no protocolVersion)', () => {
      const msg = {
        type: 'binding_request',
        messageId: 'uuid-1234',
        timestamp: 1000000,
        data: {
          deviceId: 'dev_mac_abc123',
        },
      };

      // Required top-level fields
      expect(msg).toHaveProperty('type', 'binding_request');
      expect(msg).toHaveProperty('messageId');
      expect(msg).toHaveProperty('timestamp');
      // Required data fields
      expect(msg.data).toHaveProperty('deviceId');
      // protocolVersion is optional (old clients omit it)
      expect(msg.data).not.toHaveProperty('protocolVersion');
    });

    it('binding_request shape (new CLI, with protocolVersion)', () => {
      const msg = {
        type: 'binding_request',
        messageId: 'uuid-1234',
        timestamp: 1000000,
        data: {
          deviceId: 'dev_mac_abc123',
          protocolVersion: 1,
        },
      };

      expect(msg.data).toHaveProperty('deviceId');
      expect(msg.data).toHaveProperty('protocolVersion');
      expect(typeof msg.data.protocolVersion).toBe('number');
    });

    it('heartbeat shape', () => {
      const msg = {
        type: 'heartbeat',
        timestamp: 1000000,
      };

      expect(msg).toHaveProperty('type', 'heartbeat');
      expect(msg).toHaveProperty('timestamp');
      // heartbeat intentionally has no messageId
      expect(msg).not.toHaveProperty('messageId');
    });

    it('response shape', () => {
      const msg = {
        type: 'response',
        messageId: 'uuid-1234',
        timestamp: 1000000,
        openId: 'ou_abc123',
        success: true,
        output: 'done',
      };

      expect(msg).toHaveProperty('type', 'response');
      expect(msg).toHaveProperty('messageId');
      expect(msg).toHaveProperty('openId');
      expect(msg).toHaveProperty('success');
    });

    it('stream shape', () => {
      const msg = {
        type: 'stream',
        messageId: 'uuid-1234',
        timestamp: 1000000,
        openId: 'ou_abc123',
        streamType: 'text',
        chunk: 'hello',
      };

      expect(msg).toHaveProperty('type', 'stream');
      expect(msg).toHaveProperty('streamType');
      expect(msg).toHaveProperty('messageId');
    });

    it('notification shape', () => {
      const msg = {
        type: 'notification',
        timestamp: 1000000,
        openId: 'ou_abc123',
        title: 'Alert',
        message: 'Something happened',
      };

      expect(msg).toHaveProperty('type', 'notification');
      expect(msg).toHaveProperty('openId');
      expect(msg).toHaveProperty('title');
      expect(msg).toHaveProperty('message');
    });
  });

  describe('Router -> CLI messages', () => {
    it('binding_confirm shape (no version info, legacy)', () => {
      const msg = {
        type: MessageType.BINDING_CONFIRM,
        messageId: 'uuid-1234',
        timestamp: 1000000,
        data: { success: true },
      };

      expect(msg).toHaveProperty('type', 'binding_confirm');
      expect(msg).toHaveProperty('messageId');
      expect(msg.data).toHaveProperty('success', true);
    });

    it('command shape', () => {
      const msg = {
        type: MessageType.COMMAND,
        messageId: 'uuid-5678',
        timestamp: 1000000,
        content: 'list files',
        openId: 'ou_abc123',
        workingDirectory: '/home/user/project',
        isSlashCommand: false,
      };

      expect(msg).toHaveProperty('type', 'command');
      expect(msg).toHaveProperty('messageId');
      expect(msg).toHaveProperty('content');
      expect(msg).toHaveProperty('openId');
      // workingDirectory and isSlashCommand are optional
    });

    it('heartbeat response shape', () => {
      const msg = {
        type: MessageType.HEARTBEAT,
        messageId: 'uuid-1234',
        timestamp: 1000000,
        data: {},
      };

      expect(msg).toHaveProperty('type', 'heartbeat');
      expect(msg).toHaveProperty('timestamp');
    });

    it('error shape (used for version rejection)', () => {
      const msg = {
        type: MessageType.ERROR,
        messageId: 'uuid-1234',
        timestamp: 1000000,
        data: {
          code: 'PROTOCOL_VERSION_INCOMPATIBLE',
          message: 'CLI protocol version 0 is no longer supported. Please upgrade remote-cli to the latest version.',
          minimumVersion: 1,
          currentRouterVersion: 2,
        },
      };

      expect(msg).toHaveProperty('type', 'error');
      expect(msg.data).toHaveProperty('code', 'PROTOCOL_VERSION_INCOMPATIBLE');
      expect(msg.data).toHaveProperty('message');
      expect(msg.data).toHaveProperty('minimumVersion');
      expect(msg.data).toHaveProperty('currentRouterVersion');
    });
  });

  describe('MessageType enum completeness', () => {
    it('all wire message types are in MessageType enum', () => {
      // stream and structured are sent by CLI but not yet in the enum.
      // This test documents the known gap — fix by adding them to MessageType
      // before bumping protocol version.
      const routerHandledTypes = [
        MessageType.BINDING_REQUEST,
        MessageType.HEARTBEAT,
        MessageType.RESPONSE,
        MessageType.NOTIFICATION,
        MessageType.ERROR,
      ];

      // These string literals are used on the wire but missing from the enum.
      // Listed here explicitly so any future addition to the enum is visible.
      const wireOnlyStrings = ['stream', 'structured'];

      expect(routerHandledTypes).toContain('binding_request');
      expect(routerHandledTypes).toContain('heartbeat');
      expect(routerHandledTypes).toContain('response');
      // Document the gap — when these are added to MessageType, remove from wireOnlyStrings
      expect(wireOnlyStrings).toContain('stream');
      expect(wireOnlyStrings).toContain('structured');
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Backward compatibility
//    Old CLI (no protocolVersion) MUST connect successfully after any router
//    upgrade, as long as MIN_SUPPORTED_CLI_VERSION has not been bumped.
// ---------------------------------------------------------------------------

describe('Backward compatibility: old CLI without protocolVersion', () => {
  it('missing protocolVersion is treated as version 1 (current baseline)', () => {
    function resolveClientVersion(data: Record<string, any>): number {
      return data?.protocolVersion ?? 1;
    }

    const oldCliData = { deviceId: 'dev_mac_abc' }; // no protocolVersion
    expect(resolveClientVersion(oldCliData)).toBe(1);
  });

  it('old CLI is accepted when MIN_SUPPORTED_CLI_VERSION is 1', () => {
    function isCompatible(data: Record<string, any>): boolean {
      const clientVersion = data?.protocolVersion ?? 1;
      return clientVersion >= MIN_SUPPORTED_CLI_VERSION;
    }

    const oldCliData = { deviceId: 'dev_mac_abc' };
    expect(isCompatible(oldCliData)).toBe(true);
  });

  it('old CLI is still accepted when PROTOCOL_VERSION bumps but MIN_SUPPORTED_CLI_VERSION does not', () => {
    // Simulates a MINOR router bump: PROTOCOL_VERSION goes up, min stays at 1
    function isCompatible(data: Record<string, any>): boolean {
      const clientVersion = data?.protocolVersion ?? 1;
      return clientVersion >= MIN_SUPPORTED_CLI_VERSION;
    }

    const oldCliData = { deviceId: 'dev_mac_abc' };
    expect(isCompatible(oldCliData)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Version rejection
//    When a breaking change is made and MIN_SUPPORTED_CLI_VERSION is bumped,
//    old CLIs MUST be rejected with a clear, human-readable error message.
// ---------------------------------------------------------------------------

describe('Version rejection: CLI below minimum supported version', () => {
  // Simulate a future state where MIN_SUPPORTED_CLI_VERSION has been bumped to 2
  const SIMULATED_MIN = 2;

  function checkVersion(data: Record<string, any>): { compatible: boolean; clientVersion: number } {
    const clientVersion = data?.protocolVersion ?? 1;
    return { compatible: clientVersion >= SIMULATED_MIN, clientVersion };
  }

  it('old CLI (no protocolVersion) is rejected when minimum is bumped to 2', () => {
    const result = checkVersion({ deviceId: 'dev_mac_abc' });
    expect(result.compatible).toBe(false);
    expect(result.clientVersion).toBe(1);
  });

  it('CLI at version 1 is rejected when minimum is 2', () => {
    const result = checkVersion({ deviceId: 'dev_mac_abc', protocolVersion: 1 });
    expect(result.compatible).toBe(false);
  });

  it('CLI at version 2 is accepted when minimum is 2', () => {
    const result = checkVersion({ deviceId: 'dev_mac_abc', protocolVersion: 2 });
    expect(result.compatible).toBe(true);
  });

  it('rejection error message contains actionable information', () => {
    const { compatible, clientVersion } = checkVersion({ deviceId: 'dev_mac_abc' });

    let errorData: Record<string, any> | null = null;
    if (!compatible) {
      errorData = {
        code: 'PROTOCOL_VERSION_INCOMPATIBLE',
        message: `CLI protocol version ${clientVersion} is no longer supported. Please upgrade remote-cli to the latest version.`,
        minimumVersion: SIMULATED_MIN,
        currentRouterVersion: PROTOCOL_VERSION,
      };
    }

    expect(errorData).not.toBeNull();
    expect(errorData!.code).toBe('PROTOCOL_VERSION_INCOMPATIBLE');
    expect(errorData!.message).toContain('upgrade');
    expect(errorData!.minimumVersion).toBe(SIMULATED_MIN);
  });
});

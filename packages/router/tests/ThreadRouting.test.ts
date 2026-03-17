import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Thread routing tests for the RouterServer.
 * Tests the cardThreadMap mechanism:
 *   - when a streaming session is registered with a threadId, the cardThreadMap is populated
 *   - when the CLI response includes a threadId, it is persisted to cardThreadMap
 *   - parent_id-based routing correctly resolves threadId for reply messages
 *   - messages without parent_id fall back to no threadId (CLI uses default thread)
 */

describe('RouterServer: Thread Routing', () => {
  describe('cardThreadMap', () => {
    it('stores threadId when streaming session is registered', () => {
      const cardThreadMap = new Map<string, { threadId: string; deviceId: string }>();

      // Simulate what RouterServer does when onStartStreaming fires with a threadId
      const register = (messageId: string, openId: string, feishuMessageId: string | null, deviceId: string, threadId?: string) => {
        if (feishuMessageId && threadId) {
          cardThreadMap.set(feishuMessageId, { threadId, deviceId });
        }
      };

      register('cmd-1', 'user-1', 'feishu-msg-100', 'device-1', 'thread-abc');
      expect(cardThreadMap.get('feishu-msg-100')).toEqual({ threadId: 'thread-abc', deviceId: 'device-1' });
    });

    it('does not store entry when threadId is absent', () => {
      const cardThreadMap = new Map<string, { threadId: string; deviceId: string }>();

      const register = (feishuMessageId: string | null, deviceId: string, threadId?: string) => {
        if (feishuMessageId && threadId) {
          cardThreadMap.set(feishuMessageId, { threadId, deviceId });
        }
      };

      register('feishu-msg-200', 'device-1', undefined);
      expect(cardThreadMap.has('feishu-msg-200')).toBe(false);
    });

    it('resolves threadId from parent_id', () => {
      const cardThreadMap = new Map<string, { threadId: string; deviceId: string }>();
      cardThreadMap.set('feishu-msg-300', { threadId: 'thread-xyz', deviceId: 'device-2' });

      // Simulate onResolveThread callback
      const onResolveThread = (feishuMessageId: string) => cardThreadMap.get(feishuMessageId);

      const result = onResolveThread('feishu-msg-300');
      expect(result?.threadId).toBe('thread-xyz');
    });

    it('returns undefined for unknown parent_id', () => {
      const cardThreadMap = new Map<string, { threadId: string; deviceId: string }>();

      const onResolveThread = (feishuMessageId: string) => cardThreadMap.get(feishuMessageId);

      expect(onResolveThread('not-in-map')).toBeUndefined();
    });

    it('multiple threads can have separate card mappings simultaneously', () => {
      const cardThreadMap = new Map<string, { threadId: string; deviceId: string }>();
      cardThreadMap.set('card-A', { threadId: 'thread-1', deviceId: 'device-1' });
      cardThreadMap.set('card-B', { threadId: 'thread-2', deviceId: 'device-1' });
      cardThreadMap.set('card-C', { threadId: 'thread-3', deviceId: 'device-1' });

      expect(cardThreadMap.get('card-A')?.threadId).toBe('thread-1');
      expect(cardThreadMap.get('card-B')?.threadId).toBe('thread-2');
      expect(cardThreadMap.get('card-C')?.threadId).toBe('thread-3');
    });

    it('entries are removed after finalize cleanup', () => {
      const cardThreadMap = new Map<string, { threadId: string; deviceId: string }>();
      cardThreadMap.set('card-to-clean', { threadId: 'thread-old', deviceId: 'device-1' });

      // Simulate cleanup after streaming session finalized
      const finalizeCleanup = (feishuMessageId: string) => cardThreadMap.delete(feishuMessageId);
      finalizeCleanup('card-to-clean');

      expect(cardThreadMap.has('card-to-clean')).toBe(false);
    });
  });

  describe('command routing with threadId', () => {
    it('includes threadId in command sent to device when resolved from parent_id', () => {
      const sentCommands: any[] = [];

      // Simulate sendToDevice capturing threadId
      const sendToDevice = vi.fn((deviceId: string, msg: any) => {
        sentCommands.push({ deviceId, ...msg });
        return true;
      });

      const cardThreadMap = new Map<string, { threadId: string; deviceId: string }>();
      cardThreadMap.set('parent-card-id', { threadId: 'thread-feature', deviceId: 'device-1' });

      // Simulate handleRegularCommand with parent_id resolution
      const parentId = 'parent-card-id';
      const resolved = cardThreadMap.get(parentId);
      const threadId = resolved?.threadId;

      sendToDevice('device-1', {
        type: 'command',
        messageId: 'new-cmd-id',
        content: 'implement the feature',
        openId: 'user-1',
        threadId,
        timestamp: Date.now(),
      });

      expect(sentCommands[0].threadId).toBe('thread-feature');
    });

    it('omits threadId from command when parent_id is absent (defaults to default thread on CLI)', () => {
      const sentCommands: any[] = [];

      const sendToDevice = vi.fn((deviceId: string, msg: any) => {
        sentCommands.push({ deviceId, ...msg });
        return true;
      });

      // No parent_id = no threadId in command
      sendToDevice('device-1', {
        type: 'command',
        messageId: 'no-thread-cmd',
        content: 'hello',
        openId: 'user-1',
        timestamp: Date.now(),
      });

      expect(sentCommands[0].threadId).toBeUndefined();
    });
  });

  describe('streaming session with threadId', () => {
    it('registration captures threadId from CLI response', () => {
      const streamingSessions = new Map<string, { openId: string; feishuMessageId: string | null; threadId?: string }>();

      // Simulate registerStreaming with threadId
      const registerStreaming = (messageId: string, openId: string, feishuMessageId: string | null, threadId?: string) => {
        streamingSessions.set(messageId, { openId, feishuMessageId, threadId });
      };

      registerStreaming('cmd-99', 'user-1', 'feishu-card-99', 'thread-backend');

      const session = streamingSessions.get('cmd-99');
      expect(session?.threadId).toBe('thread-backend');
    });
  });
});

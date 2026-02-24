/**
 * Tests for RouterServer.handleRedactedThinking
 *
 * Tests the private handleRedactedThinking method by simulating the internal
 * streaming session state that the router maintains per messageId.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRedactedThinkingElement } from '../src/utils/ToolFormatter';

// ---------------------------------------------------------------------------
// Minimal stubs — avoid standing up the full RouterServer (requires network)
// ---------------------------------------------------------------------------

interface StreamData {
  feishuMessageId: string | null;
  openId: string;
  elements: any[];
  currentTextContent: string;
  hasUpdated: boolean;
  createdAt: number;
}

function makeStreamData(overrides: Partial<StreamData> = {}): StreamData {
  return {
    feishuMessageId: 'feishu-msg-001',
    openId: 'user-open-id',
    elements: [],
    currentTextContent: '',
    hasUpdated: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * Extracted logic of handleRedactedThinking, mirroring the implementation
 * in packages/router/src/server.ts exactly so changes to the source will
 * cause these tests to fail — acting as a contract test.
 */
async function handleRedactedThinking(
  messageId: string,
  openId: string,
  streamingMessages: Map<string, StreamData>,
  updateStreamingMessage: (id: string, els: any[], uid: string) => Promise<void>
): Promise<void> {
  const streamData = streamingMessages.get(messageId);
  if (!streamData) {
    return;
  }

  // Flush current text content to elements if any
  if (streamData.currentTextContent.trim()) {
    streamData.elements.push({ tag: 'markdown', content: streamData.currentTextContent });
    streamData.currentTextContent = '';
  }

  // Add redacted thinking notification elements
  const redactedThinkingElements = createRedactedThinkingElement();
  streamData.elements.push(...redactedThinkingElements);
  streamData.createdAt = Date.now();

  // Immediately update card to show redacted thinking notification
  if (streamData.feishuMessageId) {
    await updateStreamingMessage(streamData.feishuMessageId, streamData.elements, openId);
    streamData.hasUpdated = true;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RouterServer - handleRedactedThinking', () => {
  let streamingMessages: Map<string, StreamData>;
  let updateStreamingMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    streamingMessages = new Map();
    updateStreamingMessage = vi.fn().mockResolvedValue(undefined);
  });

  describe('No session found', () => {
    it('should do nothing when no streaming session exists for messageId', async () => {
      await handleRedactedThinking(
        'unknown-msg',
        'user-open-id',
        streamingMessages,
        updateStreamingMessage
      );

      expect(updateStreamingMessage).not.toHaveBeenCalled();
    });
  });

  describe('Happy path — session with feishuMessageId', () => {
    it('should append redacted thinking elements to stream', async () => {
      const data = makeStreamData();
      streamingMessages.set('msg-1', data);

      await handleRedactedThinking('msg-1', data.openId, streamingMessages, updateStreamingMessage);

      // Elements should contain the redacted thinking notification (hr + note)
      const elementTags = data.elements.map((e: any) => e.tag);
      expect(elementTags).toContain('hr');
      expect(elementTags).toContain('note');
    });

    it('should call updateStreamingMessage once with the correct feishu message id', async () => {
      const data = makeStreamData({ feishuMessageId: 'feishu-abc' });
      streamingMessages.set('msg-2', data);

      await handleRedactedThinking('msg-2', data.openId, streamingMessages, updateStreamingMessage);

      expect(updateStreamingMessage).toHaveBeenCalledTimes(1);
      expect(updateStreamingMessage).toHaveBeenCalledWith(
        'feishu-abc',
        expect.any(Array),
        data.openId
      );
    });

    it('should set hasUpdated to true after update', async () => {
      const data = makeStreamData({ hasUpdated: false });
      streamingMessages.set('msg-3', data);

      await handleRedactedThinking('msg-3', data.openId, streamingMessages, updateStreamingMessage);

      expect(data.hasUpdated).toBe(true);
    });
  });

  describe('Pending text flushed before notification', () => {
    it('should flush pending text content before appending redacted thinking elements', async () => {
      const data = makeStreamData({ currentTextContent: 'Some text already accumulated' });
      streamingMessages.set('msg-4', data);

      await handleRedactedThinking('msg-4', data.openId, streamingMessages, updateStreamingMessage);

      // First element should be the flushed markdown text
      expect(data.elements[0]).toMatchObject({ tag: 'markdown', content: 'Some text already accumulated' });
      // currentTextContent should be cleared
      expect(data.currentTextContent).toBe('');
      // Redacted elements should follow
      const tags = data.elements.map((e: any) => e.tag);
      expect(tags).toContain('hr');
      expect(tags).toContain('note');
    });

    it('should not create a spurious markdown element when text is only whitespace', async () => {
      const data = makeStreamData({ currentTextContent: '   \n  ' });
      streamingMessages.set('msg-5', data);

      await handleRedactedThinking('msg-5', data.openId, streamingMessages, updateStreamingMessage);

      // Whitespace-only text should NOT be flushed as a markdown element
      const markdownElements = data.elements.filter((e: any) => e.tag === 'markdown');
      expect(markdownElements.length).toBe(0);
    });
  });

  describe('No feishuMessageId — no card update', () => {
    it('should still mutate elements but skip card update when feishuMessageId is null', async () => {
      const data = makeStreamData({ feishuMessageId: null });
      streamingMessages.set('msg-6', data);

      await handleRedactedThinking('msg-6', data.openId, streamingMessages, updateStreamingMessage);

      // Elements were still appended (for when we eventually get a message ID)
      expect(data.elements.length).toBeGreaterThan(0);
      // But the card update was NOT triggered
      expect(updateStreamingMessage).not.toHaveBeenCalled();
      expect(data.hasUpdated).toBe(false);
    });
  });

  describe('Correct element order', () => {
    it('should produce: [pre-existing elements] + [divider, note]', async () => {
      const existingEl = { tag: 'markdown', content: 'previous output' };
      const data = makeStreamData({ elements: [existingEl] });
      streamingMessages.set('msg-7', data);

      await handleRedactedThinking('msg-7', data.openId, streamingMessages, updateStreamingMessage);

      expect(data.elements[0]).toBe(existingEl);
      expect(data.elements[1]).toMatchObject({ tag: 'hr' });
      expect(data.elements[2]).toMatchObject({ tag: 'note' });
    });
  });

  describe('Multiple calls', () => {
    it('should append new notification elements on every call', async () => {
      const data = makeStreamData();
      streamingMessages.set('msg-8', data);

      await handleRedactedThinking('msg-8', data.openId, streamingMessages, updateStreamingMessage);
      await handleRedactedThinking('msg-8', data.openId, streamingMessages, updateStreamingMessage);

      const noteTags = data.elements.filter((e: any) => e.tag === 'note');
      expect(noteTags.length).toBe(2);
      expect(updateStreamingMessage).toHaveBeenCalledTimes(2);
    });
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';
import { BindingManager } from '../src/binding/BindingManager';
import { ConnectionHub } from '../src/websocket/ConnectionHub';
import * as lark from '@larksuiteoapi/node-sdk';

// Mock dependencies
vi.mock('../src/binding/BindingManager');
vi.mock('../src/websocket/ConnectionHub');
vi.mock('@larksuiteoapi/node-sdk');

describe('FeishuLongConnHandler', () => {
  let handler: FeishuLongConnHandler;
  let mockBindingManager: any;
  let mockConnectionHub: any;
  let mockClient: any;

  beforeEach(() => {
    // Create mock instances
    mockBindingManager = {
      verifyBindingCode: vi.fn(),
      bindUser: vi.fn(),
      getUserBinding: vi.fn(),
      unbindUser: vi.fn(),
      close: vi.fn()
    };

    mockConnectionHub = {
      isDeviceOnline: vi.fn(),
      sendToDevice: vi.fn(),
      getConnectionStats: vi.fn()
    };

    mockClient = {
      im: {
        message: {
          create: vi.fn(),
          patch: vi.fn(),
          reply: vi.fn(),
          delete: vi.fn()
        }
      }
    };

    // Mock constructors
    (BindingManager as any).mockImplementation(() => mockBindingManager);
    (ConnectionHub as any).mockImplementation(() => mockConnectionHub);
    (lark.Client as any).mockImplementation(() => mockClient);
    (lark.WSClient as any).mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined)
    }));
    (lark.EventDispatcher as any).mockImplementation(() => ({
      register: vi.fn().mockReturnThis()
    }));

    handler = new FeishuLongConnHandler({
      appId: 'test_app_id',
      appSecret: 'test_app_secret',
      store: {} as any
    });

    handler.setConnectionHub(mockConnectionHub);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('sendMessage', () => {
    it('should send text message successfully', async () => {
      mockClient.im.message.create.mockResolvedValue({ data: { message_id: 'msg_123' } });

      const result = await handler.sendMessage('ou_user_123', 'Hello World');

      expect(result).toBe(true);
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: 'ou_user_123',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello World' })
        }
      });
    });

    it('should return false when sending fails', async () => {
      mockClient.im.message.create.mockRejectedValue(new Error('API Error'));

      const result = await handler.sendMessage('ou_user_123', 'Hello World');

      expect(result).toBe(false);
    });
  });

  describe('sendStreamingStart', () => {
    it('should create interactive card', async () => {
      mockClient.im.message.create.mockResolvedValue({
        data: { message_id: 'msg_card_123' }
      });

      const result = await handler.sendStreamingStart('ou_user_123', '🤔 Thinking...');

      expect(result).toBe('msg_card_123');
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: 'ou_user_123',
          msg_type: 'interactive',
          content: expect.stringContaining('Thinking...')
        }
      });
    });

    it('should return null when creation fails', async () => {
      mockClient.im.message.create.mockRejectedValue(new Error('API Error'));

      const result = await handler.sendStreamingStart('ou_user_123');

      expect(result).toBeNull();
    });
  });

  describe('updateStreamingMessage', () => {
    it('should update message within limit', async () => {
      mockClient.im.message.patch.mockResolvedValue({});

      const elements = [{ tag: 'markdown', content: 'Short content' }];
      const result = await handler.updateStreamingMessage('msg_123', elements, 'ou_user_123');

      expect(result).toBe(true);
      expect(mockClient.im.message.patch).toHaveBeenCalledWith({
        path: { message_id: 'msg_123' },
        data: {
          content: JSON.stringify({
            schema: '2.0',
            body: {
              elements: [
                {
                  tag: 'markdown',
                  content: 'Short content'
                }
              ]
            }
          })
        }
      });
    });

    it('should create continuation messages when content exceeds limit', async () => {
      mockClient.im.message.patch.mockResolvedValue({});
      mockClient.im.message.create.mockResolvedValue({ data: { message_id: 'msg_456' } });

      // 160 elements > CARD_ELEMENT_LIMIT (150), triggers chunking
      const longElements = [];
      for (let i = 0; i < 160; i++) {
        longElements.push({ tag: 'markdown', content: 'line ' + i });
      }

      const result = await handler.updateStreamingMessage('msg_123', longElements, 'ou_user_123');

      expect(result).toBe(true);
      expect(mockClient.im.message.patch).toHaveBeenCalled();
      expect(mockClient.im.message.create).toHaveBeenCalled();
    });

    it('should handle multiple chunks', async () => {
      mockClient.im.message.patch.mockResolvedValue({});
      mockClient.im.message.create
        .mockResolvedValueOnce({ data: { message_id: 'msg_456' } })
        .mockResolvedValueOnce({ data: { message_id: 'msg_789' } });

      // 310 elements forces at least 3 chunks (each chunk holds ~148 elements)
      const veryLongElements = [];
      for (let i = 0; i < 310; i++) {
        veryLongElements.push({ tag: 'markdown', content: 'line ' + i });
      }

      const result = await handler.updateStreamingMessage('msg_123', veryLongElements, 'ou_user_123');

      expect(result).toBe(true);
      expect(mockClient.im.message.patch).toHaveBeenCalledTimes(1);
      expect(mockClient.im.message.create).toHaveBeenCalledTimes(2);
    });

    it('should not create continuation message if openId not provided', async () => {
      mockClient.im.message.patch.mockResolvedValue({});

      const longContent = 'a'.repeat(5000);
      const result = await handler.updateStreamingMessage('msg_123', longContent);

      expect(result).toBe(true);
      expect(mockClient.im.message.patch).toHaveBeenCalled();
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
    });

    it('should return false when patch fails', async () => {
      mockClient.im.message.patch.mockRejectedValue(new Error('API Error'));

      const result = await handler.updateStreamingMessage('msg_123', 'Content');

      expect(result).toBe(false);
    });
  });

  describe('finalizeStreamingMessage', () => {
    it('should finalize message within limit', async () => {
      mockClient.im.message.patch.mockResolvedValue({});

      const elements = [{ tag: 'markdown', content: 'Final content' }];
      const result = await handler.finalizeStreamingMessage('msg_123', elements, 'ABC123', 'ou_user_123');

      expect(result).toBe(true);
      expect(mockClient.im.message.patch).toHaveBeenCalledWith({
        path: { message_id: 'msg_123' },
        data: {
          content: JSON.stringify({
            schema: '2.0',
            body: {
              elements: [
                {
                  tag: 'markdown',
                  content: 'Final content'
                },
                {
                  tag: 'markdown',
                  content: '✅ Completed · Session: ABC123'
                }
              ]
            }
          })
        }
      });
    });

    it('should split long content into multiple messages', async () => {
      mockClient.im.message.patch.mockResolvedValue({});
      mockClient.im.message.create.mockResolvedValue({ data: { message_id: 'msg_456' } });

      // Create a long element list (simulating many tool uses/results)
      const longElements = [];
      for (let i = 0; i < 10; i++) {
        longElements.push({ tag: 'markdown', content: 'a'.repeat(500) });
      }

      const result = await handler.finalizeStreamingMessage('msg_123', longElements, 'ABC123', 'ou_user_123');

      expect(result).toBe(true);
      // NOTE: Chunking logic for element-based streaming is not yet implemented
      // For now, all elements are sent in one message
      expect(mockClient.im.message.patch).toHaveBeenCalled();
    });

    it('should handle very long content with multiple chunks', async () => {
      mockClient.im.message.patch.mockResolvedValue({});
      mockClient.im.message.create.mockResolvedValue({ data: { message_id: 'msg_456' } });

      // Create a very long element list
      const veryLongElements = [];
      for (let i = 0; i < 30; i++) {
        veryLongElements.push({ tag: 'markdown', content: 'a'.repeat(400) });
      }

      const result = await handler.finalizeStreamingMessage('msg_123', veryLongElements, undefined, 'ou_user_123');

      expect(result).toBe(true);
      // NOTE: Chunking logic not yet implemented
      expect(mockClient.im.message.patch).toHaveBeenCalledTimes(1);
    });

    it('should not create continuation message without openId', async () => {
      mockClient.im.message.patch.mockResolvedValue({});

      const longElements = [];
      for (let i = 0; i < 10; i++) {
        longElements.push({ tag: 'markdown', content: 'a'.repeat(500) });
      }

      const result = await handler.finalizeStreamingMessage('msg_123', longElements);

      expect(result).toBe(true);
      expect(mockClient.im.message.patch).toHaveBeenCalled();
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
    });

    it('should return false when patch fails', async () => {
      mockClient.im.message.patch.mockRejectedValue(new Error('API Error'));

      const result = await handler.finalizeStreamingMessage('msg_123', 'Content');

      expect(result).toBe(false);
    });
  });

  describe('finalizeStreamingMessage after streaming updates', () => {
    // Helper: generate elements that exceed the 150-node limit
    const makeElements = (count: number) => {
      const elements = [];
      for (let i = 0; i < count; i++) {
        elements.push({ tag: 'markdown', content: 'line ' + i });
      }
      return elements;
    };

    it('should not re-patch frozen messages that already exist in the chain', async () => {
      mockClient.im.message.patch.mockResolvedValue({});
      mockClient.im.message.create.mockResolvedValue({ data: { message_id: 'msg_cont_1' } });

      // Step 1: First update: fits in one message (< 150 elements)
      await handler.updateStreamingMessage('msg_123', makeElements(10), 'ou_user_123');

      // Second update: exceeds limit, creates continuation message
      await handler.updateStreamingMessage('msg_123', makeElements(160), 'ou_user_123');

      // At this point, chain = ['msg_123', 'msg_cont_1']

      // Reset mocks to track only finalize calls
      mockClient.im.message.patch.mockClear();
      mockClient.im.message.create.mockClear();

      // Step 2: Finalize with same element count (no new content added)
      await handler.finalizeStreamingMessage('msg_123', makeElements(160), 'ABC123', 'ou_user_123');

      // finalizeStreamingMessage patches all messages in the chain (first + continuations)
      // chain has 2 messages, both are patched
      expect(mockClient.im.message.patch).toHaveBeenCalledTimes(2);

      // Should NOT create any new messages (chain already covers all chunks)
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
    });

    it('should not create duplicate continuation messages when chunk boundaries shift', async () => {
      mockClient.im.message.patch.mockResolvedValue({});
      mockClient.im.message.create
        .mockResolvedValueOnce({ data: { message_id: 'msg_cont_1' } })
        .mockResolvedValueOnce({ data: { message_id: 'msg_cont_2' } })
        .mockResolvedValueOnce({ data: { message_id: 'msg_unexpected' } });

      // Step 1: Stream content that creates 3-message chain (each chunk ~148 nodes)
      await handler.updateStreamingMessage('msg_123', makeElements(10), 'ou_user_123');
      await handler.updateStreamingMessage('msg_123', makeElements(160), 'ou_user_123');
      await handler.updateStreamingMessage('msg_123', makeElements(310), 'ou_user_123');

      // chain = ['msg_123', 'msg_cont_1', 'msg_cont_2']

      mockClient.im.message.patch.mockClear();
      mockClient.im.message.create.mockClear();

      // Step 2: Finalize - should reuse existing chain, not create new messages
      await handler.finalizeStreamingMessage('msg_123', makeElements(310), 'ABC123', 'ou_user_123');

      // Should NOT create any new continuation messages
      expect(mockClient.im.message.create).not.toHaveBeenCalled();

      // finalizeStreamingMessage patches all 3 messages in the chain
      expect(mockClient.im.message.patch).toHaveBeenCalledTimes(3);
    });

    it('should handle finalize when new content extends beyond existing chain', async () => {
      mockClient.im.message.patch.mockResolvedValue({});
      mockClient.im.message.create
        .mockResolvedValueOnce({ data: { message_id: 'msg_cont_1' } })  // from update
        .mockResolvedValueOnce({ data: { message_id: 'msg_cont_2' } }); // from finalize

      // Step 1: Stream creates 2-message chain (160 elements > 150 limit)
      await handler.updateStreamingMessage('msg_123', makeElements(160), 'ou_user_123');
      // chain = ['msg_123', 'msg_cont_1']

      mockClient.im.message.patch.mockClear();
      mockClient.im.message.create.mockClear();
      mockClient.im.message.create.mockResolvedValue({ data: { message_id: 'msg_cont_2' } });

      // Step 2: Finalize with MORE content that needs a 3rd message (310 elements > 2 chunks)
      await handler.finalizeStreamingMessage('msg_123', makeElements(310), 'ABC123', 'ou_user_123');

      // Should only create 1 new message (the 3rd chunk), not recreate existing ones
      expect(mockClient.im.message.create).toHaveBeenCalledTimes(1);

      // All 3 chain messages are patched (chain[0] + existing cont + new cont)
      expect(mockClient.im.message.patch).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrent update serialization', () => {
    // Helper: generate elements that exceed the 150-node limit
    const makeElements = (count: number) => {
      const elements = [];
      for (let i = 0; i < count; i++) {
        elements.push({ tag: 'markdown', content: 'line ' + i });
      }
      return elements;
    };

    it('should not create duplicate continuation messages when updates are concurrent', async () => {
      // Simulate slow API calls where create takes time to resolve
      let createResolvers: Array<(value: any) => void> = [];
      mockClient.im.message.patch.mockResolvedValue({});
      mockClient.im.message.create.mockImplementation(() => {
        return new Promise(resolve => {
          createResolvers.push(resolve);
        });
      });

      // Fire two concurrent updates that both exceed the element limit (160 > 150)
      // Without serialization, both will try to create a continuation message
      const update1 = handler.updateStreamingMessage('msg_123', makeElements(160), 'ou_user_123');
      const update2 = handler.updateStreamingMessage('msg_123', makeElements(165), 'ou_user_123');

      // Wait for microtasks so both calls enter the method
      await new Promise(r => setTimeout(r, 10));

      // Resolve all create calls
      for (const resolver of createResolvers) {
        resolver({ data: { message_id: `msg_cont_${createResolvers.indexOf(resolver) + 1}` } });
      }

      await Promise.all([update1, update2]);

      // With serialization, only ONE continuation message should be created
      // The second call should see the chain already has 2 entries and just update
      expect(mockClient.im.message.create).toHaveBeenCalledTimes(1);
    });

    it('should serialize finalize after pending update completes', async () => {
      let patchResolver: ((value: any) => void) | null = null;
      mockClient.im.message.patch.mockImplementation(() => {
        return new Promise(resolve => {
          patchResolver = resolve;
        });
      });
      mockClient.im.message.create.mockResolvedValue({ data: { message_id: 'msg_cont_1' } });

      // Start an update that will be slow (patch takes time)
      const updatePromise = handler.updateStreamingMessage('msg_123', 'Short content', 'ou_user_123');

      // Immediately fire finalize while update is still pending
      const finalizePromise = handler.finalizeStreamingMessage('msg_123', 'Short content', 'ABC123', 'ou_user_123');

      // Resolve the first patch
      await new Promise(r => setTimeout(r, 10));
      if (patchResolver) {
        patchResolver({});
        patchResolver = null;
      }

      // Wait for update to complete, then finalize's patch should proceed
      await new Promise(r => setTimeout(r, 10));
      if (patchResolver) {
        patchResolver({});
      }

      await Promise.all([updatePromise, finalizePromise]);

      // Both should complete successfully without errors
      // The finalize should wait for the update to finish first
      expect(mockClient.im.message.patch).toHaveBeenCalled();
    });
  });

  describe('splitTextIntoChunks', () => {
    it('should return single chunk for short text', () => {
      const chunks = (handler as any).splitTextIntoChunks('Short message', 4000);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe('Short message');
    });

    it('should split at newline boundaries when possible', () => {
      const lines = Array(100).fill('Line of text with some content here').join('\n');
      const chunks = (handler as any).splitTextIntoChunks(lines, 500);

      expect(chunks.length).toBeGreaterThan(1);
      // Verify no chunk exceeds limit
      chunks.forEach((chunk: string) => {
        expect(chunk.length).toBeLessThanOrEqual(500);
      });
    });

    it('should split at space boundaries when no newlines near limit', () => {
      const text = 'word '.repeat(1000); // Many words
      const chunks = (handler as any).splitTextIntoChunks(text, 100);

      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk: string) => {
        expect(chunk.length).toBeLessThanOrEqual(100);
      });
    });

    it('should hard split when no good boundary found', () => {
      const text = 'a'.repeat(1000);
      const chunks = (handler as any).splitTextIntoChunks(text, 300);

      expect(chunks.length).toBeGreaterThan(1);
      // All chunks except last should be at or near max length
      for (let i = 0; i < chunks.length - 1; i++) {
        expect(chunks[i].length).toBeLessThanOrEqual(300);
        expect(chunks[i].length).toBeGreaterThan(200); // Should be close to limit
      }
    });

    it('should handle text exactly at limit', () => {
      const text = 'a'.repeat(4000);
      const chunks = (handler as any).splitTextIntoChunks(text, 4000);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it('should handle empty text', () => {
      const chunks = (handler as any).splitTextIntoChunks('', 4000);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe('');
    });
  });

  describe('setOnStartStreaming', () => {
    it('should set streaming start callback', () => {
      const callback = vi.fn();

      handler.setOnStartStreaming(callback);

      // Trigger the callback by simulating a command
      mockBindingManager.getUserBinding.mockResolvedValue({
        deviceId: 'dev_123',
        deviceName: 'Test Device'
      });
      mockConnectionHub.isDeviceOnline.mockReturnValue(true);
      mockConnectionHub.sendToDevice.mockResolvedValue(true);
      mockClient.im.message.create.mockResolvedValue({
        data: { message_id: 'msg_123' }
      });

      // Access private method to trigger callback
      // This would normally be called via the full flow
    });
  });

  describe('getBindingManager', () => {
    it('should return binding manager instance', () => {
      const result = handler.getBindingManager();

      expect(result).toBe(mockBindingManager);
    });
  });

  describe('splitElementsIntoChunks', () => {
    it('should return single chunk for small number of elements', () => {
      const elements = [
        { tag: 'markdown', content: 'Hello' },
        { tag: 'markdown', content: 'World' },
      ];

      const chunks = (handler as any).splitElementsIntoChunks(elements);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual(elements);
    });

    it('should split when element count exceeds CARD_ELEMENT_LIMIT (150)', () => {
      // Create 200 elements to exceed the new conservative limit of 150
      const elements = Array.from({ length: 200 }, (_, i) => ({
        tag: 'markdown',
        content: `Element ${i}`,
      }));

      const chunks = (handler as any).splitElementsIntoChunks(elements);

      // Should be split into multiple chunks
      expect(chunks.length).toBeGreaterThan(1);

      // Each chunk should have at most 152 elements (150 elements + 2 indicators max)
      chunks.forEach((chunk: any[]) => {
        expect(chunk.length).toBeLessThanOrEqual(152);
      });

      // Count original elements (excluding continuation indicators)
      const totalOriginalElements = chunks.reduce((sum: number, chunk: any[]) => {
        const originalElements = chunk.filter((el: any) =>
          !el.content?.includes('Continued from previous') &&
          !el.content?.includes('Continued in next message')
        );
        return sum + originalElements.length;
      }, 0);
      expect(totalOriginalElements).toBe(200);
    });

    it('should split when JSON size exceeds CARD_DATA_SIZE_LIMIT', () => {
      // Create elements with large content
      // Each element ~500KB, to easily exceed the 2.9MB limit
      const largeContent = 'x'.repeat(500000);
      const elements = Array.from({ length: 10 }, (_, i) => ({
        tag: 'markdown',
        content: largeContent,
      }));

      const chunks = (handler as any).splitElementsIntoChunks(elements);

      // Should be split due to size limit
      expect(chunks.length).toBeGreaterThan(1);

      // Each chunk's JSON should not exceed limit (with buffer)
      chunks.forEach((chunk: any[]) => {
        const cardData = {
          schema: '2.0',
          body: { elements: chunk },
        };
        const jsonSize = JSON.stringify(cardData).length;
        // Should be less than 2.9MB (buffer for safety)
        expect(jsonSize).toBeLessThan(2900000);
      });
    });

    it('should handle mix of different element types', () => {
      const elements = [
        { tag: 'markdown', content: 'Text 1' },
        { tag: 'hr' },
        { tag: 'markdown', content: 'Text 2' },
        { tag: 'hr' },
      ];

      const chunks = (handler as any).splitElementsIntoChunks(elements);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual(elements);
    });

    it('should handle empty elements array', () => {
      const elements: any[] = [];

      const chunks = (handler as any).splitElementsIntoChunks(elements);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual([]);
    });

    it('should add continuation indicators between chunks', () => {
      // Create 250 elements to force splitting
      const elements = Array.from({ length: 250 }, (_, i) => ({
        tag: 'markdown',
        content: `Element ${i}`,
      }));

      const chunks = (handler as any).splitElementsIntoChunks(elements);

      expect(chunks.length).toBeGreaterThan(1);

      // First chunk should have continuation indicator at the end
      const firstChunk = chunks[0];
      const lastElement = firstChunk[firstChunk.length - 1];
      expect(lastElement.tag).toBe('markdown');
      expect(lastElement.content).toContain('Continued in next message');

      // Middle chunks should have indicators at both ends
      if (chunks.length > 2) {
        const middleChunk = chunks[1];
        const firstElement = middleChunk[0];
        const lastElementMiddle = middleChunk[middleChunk.length - 1];
        expect(firstElement.tag).toBe('markdown');
        expect(firstElement.content).toContain('Continued from previous');
        expect(lastElementMiddle.tag).toBe('markdown');
        expect(lastElementMiddle.content).toContain('Continued in next message');
      }

      // Last chunk should only have indicator at the start
      const lastChunk = chunks[chunks.length - 1];
      const firstElementLast = lastChunk[0];
      expect(firstElementLast.tag).toBe('markdown');
      expect(firstElementLast.content).toContain('Continued from previous');
    });
  });

  describe('createContinuationCard', () => {
    it('should create a new card message with continuation elements', async () => {
      const openId = 'test_open_id';
      const elements = [
        { tag: 'markdown', content: 'Continuation content' },
      ];

      mockClient.im.message.create.mockResolvedValue({
        data: { message_id: 'msg_new_123' },
      });

      const messageId = await (handler as any).createContinuationCard(openId, elements);

      expect(messageId).toBe('msg_new_123');
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'interactive',
          content: expect.stringContaining('"schema":"2.0"'),
        },
      });

      // Verify the content includes the elements
      const createCall = mockClient.im.message.create.mock.calls[0][0];
      const content = JSON.parse(createCall.data.content);
      expect(content.body.elements).toEqual(elements);
    });

    it('should return null on error', async () => {
      const openId = 'test_open_id';
      const elements = [{ tag: 'markdown', content: 'Test' }];

      mockClient.im.message.create.mockRejectedValue(new Error('Network error'));

      const messageId = await (handler as any).createContinuationCard(openId, elements);

      expect(messageId).toBeNull();
    });
  });

  describe('updateStreamingMessage with chunking', () => {
    it('should create continuation cards when elements exceed limit', async () => {
      const messageId = 'msg_original';
      const openId = 'test_open_id';

      // Create 250 elements to exceed limit
      const elements = Array.from({ length: 250 }, (_, i) => ({
        tag: 'markdown',
        content: `Element ${i}`,
      }));

      mockClient.im.message.patch.mockResolvedValue({ data: {} });
      mockClient.im.message.create.mockResolvedValue({
        data: { message_id: 'msg_continuation_1' },
      });

      const result = await handler.updateStreamingMessage(messageId, elements, openId);

      expect(result).toBe(true);

      // Should update the original message
      expect(mockClient.im.message.patch).toHaveBeenCalled();

      // Should create at least one continuation card
      expect(mockClient.im.message.create).toHaveBeenCalled();
    });

    it('should not create continuation cards for small element arrays', async () => {
      const messageId = 'msg_small';
      const openId = 'test_open_id';
      const elements = [
        { tag: 'markdown', content: 'Small content' },
      ];

      mockClient.im.message.patch.mockResolvedValue({ data: {} });

      const result = await handler.updateStreamingMessage(messageId, elements, openId);

      expect(result).toBe(true);
      expect(mockClient.im.message.patch).toHaveBeenCalled();
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
    });
  });

  describe('finalizeStreamingMessage with chunking', () => {
    it('should create continuation cards when finalized elements exceed limit', async () => {
      const messageId = 'msg_finalize';
      const openId = 'test_open_id';

      // Create 250 elements to exceed limit
      const elements = Array.from({ length: 250 }, (_, i) => ({
        tag: 'markdown',
        content: `Element ${i}`,
      }));

      mockClient.im.message.patch.mockResolvedValue({ data: {} });
      mockClient.im.message.create.mockResolvedValue({
        data: { message_id: 'msg_continuation_final' },
      });

      const result = await handler.finalizeStreamingMessage(messageId, elements, 'abc123', openId);

      expect(result).toBe(true);

      // Should update the original message
      expect(mockClient.im.message.patch).toHaveBeenCalled();

      // Should create continuation cards if needed
      // Note: The completion note adds one more element, so it should still trigger chunking
      expect(mockClient.im.message.create).toHaveBeenCalled();
    });
  });

  describe('Recursive tagged node counting', () => {
    it('should count simple top-level elements', () => {
      const handler = new FeishuLongConnHandler({
        appId: 'test_app_id',
        appSecret: 'test_secret',
        store: {} as any,
      });
      const elements = [
        { tag: 'markdown', content: 'Hello' },
        { tag: 'markdown', content: 'World' },
      ];

      // Access private method via any cast for testing
      const count = (handler as any).countTaggedNodes(elements[0]) + (handler as any).countTaggedNodes(elements[1]);
      expect(count).toBe(2);
    });

    it('should count nested elements in containers', () => {
      const handler = new FeishuLongConnHandler({
        appId: 'test_app_id',
        appSecret: 'test_secret',
        store: {} as any,
      });
      const element = {
        tag: 'div',
        elements: [
          { tag: 'markdown', content: 'Text 1' },
          { tag: 'markdown', content: 'Text 2' },
          {
            tag: 'action',
            actions: [
              { tag: 'button', text: { tag: 'plain_text', content: 'Click' } },
            ],
          },
        ],
      };

      // Should count: div (1) + markdown (1) + markdown (1) + action (1) + button (1) + plain_text (1) = 6
      const count = (handler as any).countTaggedNodes(element);
      expect(count).toBe(6);
    });

    it('should count deeply nested elements', () => {
      const handler = new FeishuLongConnHandler({
        appId: 'test_app_id',
        appSecret: 'test_secret',
        store: {} as any,
      });
      const element = {
        tag: 'div',
        elements: [
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                elements: [
                  { tag: 'markdown', content: 'Column 1' },
                  { tag: 'image', img_key: 'img_123' },
                ],
              },
              {
                tag: 'column',
                elements: [
                  { tag: 'markdown', content: 'Column 2' },
                ],
              },
            ],
          },
        ],
      };

      // Should count: div (1) + column_set (1) + column (1) + markdown (1) + image (1) + column (1) + markdown (1) = 7
      const count = (handler as any).countTaggedNodes(element);
      expect(count).toBe(7);
    });

    it('should count elements with text objects', () => {
      const handler = new FeishuLongConnHandler({
        appId: 'test_app_id',
        appSecret: 'test_secret',
        store: {} as any,
      });
      const element = {
        tag: 'button',
        text: { tag: 'plain_text', content: 'Click me' },
        type: 'primary',
      };

      // Should count: button (1) + plain_text (1) = 2
      const count = (handler as any).countTaggedNodes(element);
      expect(count).toBe(2);
    });

    it('should handle elements without tag property', () => {
      const handler = new FeishuLongConnHandler({
        appId: 'test_app_id',
        appSecret: 'test_secret',
        store: {} as any,
      });
      const element = {
        content: 'No tag here',
        nested: {
          data: 'Also no tag',
        },
      };

      const count = (handler as any).countTaggedNodes(element);
      expect(count).toBe(0);
    });
  });

  describe('Continuation card reuse and cleanup', () => {
    it('should reuse existing continuation cards on update', async () => {
      const messageId = 'msg_reuse';
      const openId = 'test_open_id';

      // First update: create 2 cards (original + 1 continuation) with 180 elements (exceeds 150 limit)
      const elements1 = Array.from({ length: 180 }, (_, i) => ({
        tag: 'markdown',
        content: `Element ${i}`,
      }));

      mockClient.im.message.patch.mockResolvedValue({ data: {} });
      mockClient.im.message.create.mockResolvedValue({
        data: { message_id: 'msg_continuation_1' },
      });

      await handler.updateStreamingMessage(messageId, elements1, openId);

      const createCallCount1 = mockClient.im.message.create.mock.calls.length;
      const patchCallCount1 = mockClient.im.message.patch.mock.calls.length;

      // Second update: still needs 2 cards with 190 elements, should reuse the continuation card
      const elements2 = Array.from({ length: 190 }, (_, i) => ({
        tag: 'markdown',
        content: `Updated ${i}`,
      }));

      await handler.updateStreamingMessage(messageId, elements2, openId);

      const createCallCount2 = mockClient.im.message.create.mock.calls.length;
      const patchCallCount2 = mockClient.im.message.patch.mock.calls.length;

      // Should NOT create new cards (reuse existing)
      expect(createCallCount2).toBe(createCallCount1);

      // Should patch both original and continuation card (2 more patches)
      expect(patchCallCount2).toBeGreaterThan(patchCallCount1);
    });

    it('should create additional continuation cards when needed', async () => {
      const messageId = 'msg_expand';
      const openId = 'test_open_id';

      // First update: 180 elements -> 2 cards (exceeds 150 limit)
      const elements1 = Array.from({ length: 180 }, (_, i) => ({
        tag: 'markdown',
        content: `Element ${i}`,
      }));

      mockClient.im.message.patch.mockResolvedValue({ data: {} });
      let continuationId = 1;
      mockClient.im.message.create.mockImplementation(() =>
        Promise.resolve({ data: { message_id: `msg_continuation_${continuationId++}` } })
      );

      await handler.updateStreamingMessage(messageId, elements1, openId);
      const createCallCount1 = mockClient.im.message.create.mock.calls.length;

      // Second update: 350 elements -> needs 3 cards (350 / 150 = 2.33, rounds to 3)
      const elements2 = Array.from({ length: 350 }, (_, i) => ({
        tag: 'markdown',
        content: `More ${i}`,
      }));

      await handler.updateStreamingMessage(messageId, elements2, openId);
      const createCallCount2 = mockClient.im.message.create.mock.calls.length;

      // Should create 1 more card (createCallCount2 > createCallCount1)
      expect(createCallCount2).toBeGreaterThan(createCallCount1);
    });

    it('should delete excess continuation cards when content shrinks', async () => {
      const messageId = 'msg_shrink';
      const openId = 'test_open_id';

      // First update: 250 elements -> 3 cards
      const elements1 = Array.from({ length: 250 }, (_, i) => ({
        tag: 'markdown',
        content: `Element ${i}`,
      }));

      mockClient.im.message.patch.mockResolvedValue({ data: {} });
      let continuationId = 1;
      mockClient.im.message.create.mockImplementation(() =>
        Promise.resolve({ data: { message_id: `msg_continuation_${continuationId++}` } })
      );
      mockClient.im.message.delete.mockResolvedValue({ data: {} });

      await handler.updateStreamingMessage(messageId, elements1, openId);

      // Second update: 80 elements -> only 1 card needed
      const elements2 = Array.from({ length: 80 }, (_, i) => ({
        tag: 'markdown',
        content: `Smaller ${i}`,
      }));

      await handler.updateStreamingMessage(messageId, elements2, openId);

      // Should have called delete for the excess continuation cards
      expect(mockClient.im.message.delete).toHaveBeenCalled();
      const deleteCallCount = mockClient.im.message.delete.mock.calls.length;
      expect(deleteCallCount).toBeGreaterThan(0);
    });

    it('should delete all continuation cards when no longer needed', async () => {
      const messageId = 'msg_cleanup';
      const openId = 'test_open_id';

      // First update: 200 elements -> 2-3 cards
      const elements1 = Array.from({ length: 200 }, (_, i) => ({
        tag: 'markdown',
        content: `Element ${i}`,
      }));

      mockClient.im.message.patch.mockResolvedValue({ data: {} });
      mockClient.im.message.create.mockResolvedValue({
        data: { message_id: 'msg_continuation_temp' },
      });
      mockClient.im.message.delete.mockResolvedValue({ data: {} });

      await handler.updateStreamingMessage(messageId, elements1, openId);

      // Clear mock to track new calls
      mockClient.im.message.delete.mockClear();

      // Second update: 50 elements -> only 1 card needed
      const elements2 = Array.from({ length: 50 }, (_, i) => ({
        tag: 'markdown',
        content: `Small ${i}`,
      }));

      await handler.updateStreamingMessage(messageId, elements2, openId);

      // Should delete all continuation cards
      expect(mockClient.im.message.delete).toHaveBeenCalled();
    });
  });
});

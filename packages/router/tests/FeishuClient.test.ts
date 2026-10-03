import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FeishuClient } from '../src/feishu/FeishuClient';
import axios from 'axios';

// Mock axios
vi.mock('axios');
const mockedAxios = axios as any;

describe('FeishuClient', () => {
  let client: FeishuClient;
  const appId = 'test_app_id';
  const appSecret = 'test_app_secret';

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Mock axios.create to return mocked axios instance
    mockedAxios.create = vi.fn(() => mockedAxios);

    client = new FeishuClient(appId, appSecret);
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('getAccessToken', () => {
    it('should fetch and cache access token', async () => {
      const mockResponse = {
        data: {
          code: 0,
          tenant_access_token: 'test_token_123',
          expire: 7200
        }
      };

      mockedAxios.post = vi.fn().mockResolvedValue(mockResponse);

      const token = await client.getAccessToken();

      expect(token).toBe('test_token_123');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/auth/v3/tenant_access_token/internal',
        {
          app_id: appId,
          app_secret: appSecret
        }
      );
    });

    it('should return cached token if not expired', async () => {
      const mockResponse = {
        data: {
          code: 0,
          tenant_access_token: 'test_token_123',
          expire: 7200
        }
      };

      mockedAxios.post = vi.fn().mockResolvedValue(mockResponse);

      // First call
      const token1 = await client.getAccessToken();
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);

      // Second call should use cached token
      const token2 = await client.getAccessToken();
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(token1).toBe(token2);
    });

    it('should refresh token if expired', async () => {
      const mockResponse1 = {
        data: {
          code: 0,
          tenant_access_token: 'test_token_old',
          expire: 0.001 // Very short expiration
        }
      };

      const mockResponse2 = {
        data: {
          code: 0,
          tenant_access_token: 'test_token_new',
          expire: 7200
        }
      };

      mockedAxios.post = vi.fn()
        .mockResolvedValueOnce(mockResponse1)
        .mockResolvedValueOnce(mockResponse2);

      // First call
      await client.getAccessToken();

      // Wait for token to expire
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second call should fetch new token
      const token = await client.getAccessToken();

      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
      expect(token).toBe('test_token_new');
    });

    it('should throw error on API failure', async () => {
      mockedAxios.post = vi.fn().mockResolvedValue({
        data: {
          code: 99999,
          msg: 'Invalid app_id'
        }
      });

      await expect(client.getAccessToken()).rejects.toThrow('Failed to get access token');
    });

    it('should handle network errors', async () => {
      mockedAxios.post = vi.fn().mockRejectedValue(new Error('Network error'));

      await expect(client.getAccessToken()).rejects.toThrow('Network error');
    });
  });

  describe('sendTextMessage', () => {
    it('should send text message successfully', async () => {
      // Mock token fetch
      mockedAxios.post = vi.fn()
        .mockResolvedValueOnce({
          data: {
            code: 0,
            tenant_access_token: 'test_token',
            expire: 7200
          }
        })
        // Mock send message
        .mockResolvedValueOnce({
          data: {
            code: 0,
            msg: 'success',
            data: {
              message_id: 'msg_xxx'
            }
          }
        });

      const result = await client.sendTextMessage('ou_user_123', 'Hello World');

      expect(result).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/im/v1/messages',
        {
          receive_id: 'ou_user_123',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello World' })
        },
        {
          params: { receive_id_type: 'open_id' },
          headers: { Authorization: 'Bearer test_token' }
        }
      );
    });

    it('should handle empty message', async () => {
      mockedAxios.post = vi.fn()
        // Mock token fetch
        .mockResolvedValueOnce({
          data: {
            code: 0,
            tenant_access_token: 'test_token',
            expire: 7200
          }
        })
        // Mock send message
        .mockResolvedValueOnce({
          data: {
            code: 0,
            msg: 'success'
          }
        });

      const result = await client.sendTextMessage('ou_user_123', '');

      expect(result).toBe(true);
    });

    it('should return false on API error', async () => {
      mockedAxios.post = vi.fn()
        .mockResolvedValueOnce({
          data: {
            code: 0,
            tenant_access_token: 'test_token',
            expire: 7200
          }
        })
        .mockResolvedValueOnce({
          data: {
            code: 99999,
            msg: 'Invalid user'
          }
        });

      const result = await client.sendTextMessage('invalid_user', 'Hello');

      expect(result).toBe(false);
    });

    it('should return false on network error', async () => {
      mockedAxios.post = vi.fn()
        .mockResolvedValueOnce({
          data: {
            code: 0,
            tenant_access_token: 'test_token',
            expire: 7200
          }
        })
        .mockRejectedValueOnce(new Error('Network error'));

      const result = await client.sendTextMessage('ou_user_123', 'Hello');

      expect(result).toBe(false);
    });
  });

  describe('sendMarkdownMessage', () => {
    it('should send markdown message successfully', async () => {
      mockedAxios.post = vi.fn()
        .mockResolvedValueOnce({
          data: {
            code: 0,
            tenant_access_token: 'test_token',
            expire: 7200
          }
        })
        .mockResolvedValueOnce({
          data: {
            code: 0,
            msg: 'success'
          }
        });

      const markdownContent = '**Bold** and *Italic*';
      const result = await client.sendMarkdownMessage('ou_user_123', markdownContent);

      expect(result).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/im/v1/messages',
        {
          receive_id: 'ou_user_123',
          msg_type: 'text',
          content: JSON.stringify({ text: markdownContent })
        },
        {
          params: { receive_id_type: 'open_id' },
          headers: { Authorization: 'Bearer test_token' }
        }
      );
    });
  });

  describe('sendCardMessage', () => {
    it('should send interactive card message', async () => {
      mockedAxios.post = vi.fn()
        .mockResolvedValueOnce({
          data: {
            code: 0,
            tenant_access_token: 'test_token',
            expire: 7200
          }
        })
        .mockResolvedValueOnce({
          data: {
            code: 0,
            msg: 'success'
          }
        });

      const card = {
        elements: [
          {
            tag: 'markdown',
            content: '**Test Card**'
          }
        ]
      };

      const result = await client.sendCardMessage('ou_user_123', card);

      expect(result).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/im/v1/messages',
        {
          receive_id: 'ou_user_123',
          msg_type: 'interactive',
          content: JSON.stringify(card)
        },
        {
          params: { receive_id_type: 'open_id' },
          headers: { Authorization: 'Bearer test_token' }
        }
      );
    });

    it('should handle complex card structure', async () => {
      mockedAxios.post = vi.fn()
        .mockResolvedValueOnce({
          data: {
            code: 0,
            tenant_access_token: 'test_token',
            expire: 7200
          }
        })
        .mockResolvedValueOnce({
          data: {
            code: 0
          }
        });

      const complexCard = {
        header: {
          title: {
            tag: 'plain_text',
            content: 'Task Status'
          }
        },
        elements: [
          {
            tag: 'markdown',
            content: '```javascript\nconsole.log("hello");\n```'
          },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: 'Confirm' },
                type: 'primary'
              }
            ]
          }
        ]
      };

      const result = await client.sendCardMessage('ou_user_123', complexCard);

      expect(result).toBe(true);
    });
  });

  describe('replyToMessage', () => {
    it('should reply to existing message', async () => {
      mockedAxios.post = vi.fn()
        .mockResolvedValueOnce({
          data: {
            code: 0,
            tenant_access_token: 'test_token',
            expire: 7200
          }
        })
        .mockResolvedValueOnce({
          data: {
            code: 0,
            msg: 'success'
          }
        });

      const result = await client.replyToMessage('msg_parent_123', 'Reply content');

      expect(result).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/im/v1/messages/msg_parent_123/reply',
        {
          msg_type: 'text',
          content: JSON.stringify({ text: 'Reply content' })
        },
        {
          headers: { Authorization: 'Bearer test_token' }
        }
      );
    });

    it('should return false on reply failure', async () => {
      mockedAxios.post = vi.fn()
        .mockResolvedValueOnce({
          data: {
            code: 0,
            tenant_access_token: 'test_token',
            expire: 7200
          }
        })
        .mockResolvedValueOnce({
          data: {
            code: 99999,
            msg: 'Message not found'
          }
        });

      const result = await client.replyToMessage('invalid_msg_id', 'Reply');

      expect(result).toBe(false);
    });
  });

});

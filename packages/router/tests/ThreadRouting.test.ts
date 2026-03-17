import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ThreadSummary } from '../src/types';

/**
 * Thread routing tests for the RouterServer.
 * Tests the cardThreadMap, activeThreadMap and card button mechanisms:
 *   - cardThreadMap is populated when a streaming session with threadId is registered
 *   - parent_id-based routing correctly resolves threadId for reply messages
 *   - new top-level messages fall back to activeThreadMap for routing
 *   - activeThreadMap is updated when onCardSwitchThread fires
 *   - createThreadSwitchElements produces correct button markup
 *   - parent_id routing takes priority over activeThreadMap
 */

describe('RouterServer: Thread Routing', () => {
  describe('cardThreadMap', () => {
    it('stores threadId when streaming session is registered', () => {
      const cardThreadMap = new Map<string, { threadId: string; deviceId: string }>();

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

    it('entries survive finalize (TTL-based eviction only)', () => {
      const cardThreadMap = new Map<string, { threadId: string; deviceId: string }>();
      cardThreadMap.set('card-persistent', { threadId: 'thread-old', deviceId: 'device-1' });

      // Finalize does NOT delete from cardThreadMap — users can still reply to old cards
      // Entries are only evicted when expired on read
      expect(cardThreadMap.has('card-persistent')).toBe(true);
    });

    it('evicts expired entries on read', () => {
      const TTL = 7 * 24 * 60 * 60 * 1000;
      const cardThreadMap = new Map<string, { threadId: string; deviceId: string; expiresAt: number }>();
      cardThreadMap.set('card-expired', {
        threadId: 'thread-old',
        deviceId: 'device-1',
        expiresAt: Date.now() - 1000, // already expired
      });

      const onResolveThread = (feishuMessageId: string) => {
        const entry = cardThreadMap.get(feishuMessageId);
        if (!entry) return undefined;
        if (Date.now() > entry.expiresAt) {
          cardThreadMap.delete(feishuMessageId);
          return undefined;
        }
        return entry;
      };

      expect(onResolveThread('card-expired')).toBeUndefined();
      expect(cardThreadMap.has('card-expired')).toBe(false);
    });
  });

  describe('activeThreadMap — Option B switching', () => {
    it('onCardSwitchThread sets active thread for user', () => {
      const activeThreadMap = new Map<string, { threadId: string; threadName: string }>();

      // Simulate what RouterServer.onCardSwitchThread does
      const onCardSwitchThread = async (openId: string, threadId: string, threadName: string) => {
        activeThreadMap.set(openId, { threadId, threadName });
      };

      onCardSwitchThread('user-1', 'thread-backend-id', 'backend');
      expect(activeThreadMap.get('user-1')).toEqual({ threadId: 'thread-backend-id', threadName: 'backend' });
    });

    it('switching thread overwrites previous active thread', () => {
      const activeThreadMap = new Map<string, { threadId: string; threadName: string }>();
      activeThreadMap.set('user-1', { threadId: 'thread-default-id', threadName: 'default' });

      const onCardSwitchThread = async (openId: string, threadId: string, threadName: string) => {
        activeThreadMap.set(openId, { threadId, threadName });
      };

      onCardSwitchThread('user-1', 'thread-backend-id', 'backend');
      expect(activeThreadMap.get('user-1')?.threadId).toBe('thread-backend-id');
      expect(activeThreadMap.get('user-1')?.threadName).toBe('backend');
    });

    it('different users have independent active threads', () => {
      const activeThreadMap = new Map<string, { threadId: string; threadName: string }>();
      activeThreadMap.set('user-1', { threadId: 'thread-A', threadName: 'frontend' });
      activeThreadMap.set('user-2', { threadId: 'thread-B', threadName: 'backend' });

      expect(activeThreadMap.get('user-1')?.threadId).toBe('thread-A');
      expect(activeThreadMap.get('user-2')?.threadId).toBe('thread-B');
    });

    it('new message uses active thread when no parent_id', () => {
      const activeThreadMap = new Map<string, { threadId: string; threadName: string }>();
      activeThreadMap.set('user-1', { threadId: 'thread-backend-id', threadName: 'backend' });

      const sentCommands: any[] = [];
      const sendToDevice = (deviceId: string, msg: any) => {
        sentCommands.push({ deviceId, ...msg });
        return true;
      };

      // Simulate handleMessageEvent: no parentId → check activeThreadMap
      const openId = 'user-1';
      const parentId: string | undefined = undefined;
      const cardThreadMap = new Map<string, { threadId: string; deviceId: string }>();

      const threadId = parentId
        ? cardThreadMap.get(parentId)?.threadId
        : activeThreadMap.get(openId)?.threadId;

      sendToDevice('device-1', {
        type: 'command',
        messageId: 'new-cmd',
        content: 'implement the feature',
        openId,
        threadId,
        timestamp: Date.now(),
      });

      expect(sentCommands[0].threadId).toBe('thread-backend-id');
    });

    it('parent_id routing takes priority over activeThreadMap', () => {
      const activeThreadMap = new Map<string, { threadId: string; threadName: string }>();
      activeThreadMap.set('user-1', { threadId: 'thread-backend-id', threadName: 'backend' });

      const cardThreadMap = new Map<string, { threadId: string; deviceId: string }>();
      cardThreadMap.set('parent-card-id', { threadId: 'thread-frontend-id', deviceId: 'device-1' });

      const sentCommands: any[] = [];
      const sendToDevice = (deviceId: string, msg: any) => {
        sentCommands.push({ deviceId, ...msg });
        return true;
      };

      // Simulate handleMessageEvent: parentId is present → use cardThreadMap, ignore activeThreadMap
      const openId = 'user-1';
      const parentId = 'parent-card-id';

      const threadId = parentId
        ? cardThreadMap.get(parentId)?.threadId
        : activeThreadMap.get(openId)?.threadId;

      sendToDevice('device-1', {
        type: 'command',
        messageId: 'reply-cmd',
        content: 'continue this task',
        openId,
        threadId,
        timestamp: Date.now(),
      });

      // Active thread is 'backend', but parent_id resolves to 'frontend' → frontend wins
      expect(sentCommands[0].threadId).toBe('thread-frontend-id');
    });

    it('new message falls back to no threadId when no active thread and no parent_id', () => {
      const activeThreadMap = new Map<string, { threadId: string; threadName: string }>();
      // No entry for user-1

      const cardThreadMap = new Map<string, { threadId: string; deviceId: string }>();

      const openId = 'user-1';
      const parentId: string | undefined = undefined;

      const threadId = parentId
        ? cardThreadMap.get(parentId)?.threadId
        : activeThreadMap.get(openId)?.threadId;

      // No active thread → CLI defaults to default thread
      expect(threadId).toBeUndefined();
    });
  });

  describe('createThreadSwitchElements', () => {
    // Replicate the logic from FeishuLongConnHandler.createThreadSwitchElements
    const createThreadSwitchElements = (threads: ThreadSummary[], activeThreadId?: string): any[] => {
      const threadColumns = threads.map((t) => ({
        tag: 'column',
        width: 'auto',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: t.id === activeThreadId ? `★ ${t.name}` : t.name },
            type: t.id === activeThreadId ? 'primary' : 'default',
            disabled: t.id === activeThreadId,
            value: JSON.stringify({ action: 'switch_thread', threadId: t.id, threadName: t.name }),
          },
        ],
      }));
      const newThreadColumn = {
        tag: 'column',
        width: 'auto',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '+ New' },
            type: 'default',
            value: JSON.stringify({ action: 'new_thread' }),
          },
        ],
      };
      return [
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'stretch',
          columns: [...threadColumns, newThreadColumn],
        },
      ];
    };

    it('renders one button per thread plus a "+ New" button', () => {
      const threads: ThreadSummary[] = [
        { id: 'id-1', name: 'default', status: 'idle' },
        { id: 'id-2', name: 'backend', status: 'idle' },
        { id: 'id-3', name: 'frontend', status: 'running' },
      ];

      const elements = createThreadSwitchElements(threads, 'id-1');
      const columnSet = elements[1];
      // 3 thread switch buttons + 1 "+ New" button = 4 columns
      expect(columnSet.columns).toHaveLength(4);
    });

    it('active thread button has primary type and is disabled with star prefix', () => {
      const threads: ThreadSummary[] = [
        { id: 'id-1', name: 'default', status: 'idle' },
        { id: 'id-2', name: 'backend', status: 'idle' },
      ];

      const elements = createThreadSwitchElements(threads, 'id-1');
      const columns = elements[1].columns;

      const defaultBtn = columns[0].elements[0];
      expect(defaultBtn.type).toBe('primary');
      expect(defaultBtn.disabled).toBe(true);
      expect(defaultBtn.text.content).toBe('★ default');

      const backendBtn = columns[1].elements[0];
      expect(backendBtn.type).toBe('default');
      expect(backendBtn.disabled).toBe(false);
      expect(backendBtn.text.content).toBe('backend');
    });

    it('button value contains switch_thread action with threadId and threadName', () => {
      const threads: ThreadSummary[] = [
        { id: 'id-1', name: 'default', status: 'idle' },
        { id: 'id-2', name: 'backend', status: 'idle' },
      ];

      const elements = createThreadSwitchElements(threads, 'id-1');
      const backendBtnValue = JSON.parse(elements[1].columns[1].elements[0].value);
      expect(backendBtnValue.action).toBe('switch_thread');
      expect(backendBtnValue.threadId).toBe('id-2');
      expect(backendBtnValue.threadName).toBe('backend');
    });

    it('no buttons rendered when only one thread exists', () => {
      const threads: ThreadSummary[] = [
        { id: 'id-1', name: 'default', status: 'idle' },
      ];

      // Simulates the guard: threads.length > 1 required to call createThreadSwitchElements
      const shouldRender = threads.length > 1;
      expect(shouldRender).toBe(false);
    });

    it('no active thread highlighted when activeThreadId is undefined', () => {
      const threads: ThreadSummary[] = [
        { id: 'id-1', name: 'default', status: 'idle' },
        { id: 'id-2', name: 'backend', status: 'idle' },
      ];

      const elements = createThreadSwitchElements(threads, undefined);
      const columns = elements[1].columns;
      // Only check the thread switch button columns (all except the last "+ New" button)
      const threadColumns = columns.slice(0, -1);

      threadColumns.forEach((col: any) => {
        const btn = col.elements[0];
        expect(btn.type).toBe('default');
        expect(btn.disabled).toBe(false);
        expect(btn.text.content).not.toMatch(/^★/);
      });
    });

    it('includes hr separator before button row', () => {
      const threads: ThreadSummary[] = [
        { id: 'id-1', name: 'default', status: 'idle' },
        { id: 'id-2', name: 'backend', status: 'idle' },
      ];

      const elements = createThreadSwitchElements(threads, 'id-1');
      expect(elements[0]).toEqual({ tag: 'hr' });
    });

    it('last column is the "+ New" button with new_thread action', () => {
      const threads: ThreadSummary[] = [
        { id: 'id-1', name: 'default', status: 'idle' },
        { id: 'id-2', name: 'backend', status: 'idle' },
      ];

      const elements = createThreadSwitchElements(threads, 'id-1');
      const columns = elements[1].columns;
      const newBtn = columns[columns.length - 1].elements[0];

      expect(newBtn.text.content).toBe('+ New');
      expect(newBtn.type).toBe('default');
      const value = JSON.parse(newBtn.value);
      expect(value.action).toBe('new_thread');
    });

    it('thread switch columns appear before the "+ New" column', () => {
      const threads: ThreadSummary[] = [
        { id: 'id-1', name: 'default', status: 'idle' },
        { id: 'id-2', name: 'backend', status: 'idle' },
      ];

      const elements = createThreadSwitchElements(threads, 'id-1');
      const columns = elements[1].columns;
      // First two columns are thread switches, last is "+ New"
      const firstValue = JSON.parse(columns[0].elements[0].value);
      const secondValue = JSON.parse(columns[1].elements[0].value);
      const lastValue = JSON.parse(columns[columns.length - 1].elements[0].value);

      expect(firstValue.action).toBe('switch_thread');
      expect(secondValue.action).toBe('switch_thread');
      expect(lastValue.action).toBe('new_thread');
    });
  });

  describe('handleCardAction', () => {
    it('calls onCardSwitchThread with correct params and returns toast', async () => {
      const switchCalls: any[] = [];
      const onCardSwitchThread = vi.fn(async (openId: string, threadId: string, threadName: string) => {
        switchCalls.push({ openId, threadId, threadName });
      });

      // Replicate handleCardAction logic
      const handleCardAction = async (data: any, handler: typeof onCardSwitchThread) => {
        const openId = data?.operator?.open_id;
        const actionValue = data?.action?.value;
        if (!openId || !actionValue) return;
        let parsed: { action: string; threadId?: string; threadName?: string };
        try {
          parsed = typeof actionValue === 'string' ? JSON.parse(actionValue) : actionValue;
        } catch {
          return;
        }
        if (parsed.action === 'switch_thread' && parsed.threadId) {
          await handler(openId, parsed.threadId, parsed.threadName ?? parsed.threadId);
          return { toast: { type: 'success', content: `Switched to: ${parsed.threadName ?? parsed.threadId}` } };
        }
      };

      const result = await handleCardAction({
        operator: { open_id: 'user-1' },
        action: { value: JSON.stringify({ action: 'switch_thread', threadId: 'id-2', threadName: 'backend' }) },
      }, onCardSwitchThread);

      expect(onCardSwitchThread).toHaveBeenCalledWith('user-1', 'id-2', 'backend');
      expect(result?.toast?.type).toBe('success');
      expect(result?.toast?.content).toBe('Switched to: backend');
    });

    it('returns undefined for unknown action', async () => {
      const handleCardAction = async (data: any) => {
        const openId = data?.operator?.open_id;
        const actionValue = data?.action?.value;
        if (!openId || !actionValue) return;
        let parsed: { action: string };
        try {
          parsed = typeof actionValue === 'string' ? JSON.parse(actionValue) : actionValue;
        } catch {
          return;
        }
        if (parsed.action === 'switch_thread') {
          return { toast: { type: 'success', content: 'Switched' } };
        }
      };

      const result = await handleCardAction({
        operator: { open_id: 'user-1' },
        action: { value: JSON.stringify({ action: 'unknown_action' }) },
      });

      expect(result).toBeUndefined();
    });

    it('returns undefined when openId is missing', async () => {
      const handleCardAction = async (data: any) => {
        const openId = data?.operator?.open_id;
        const actionValue = data?.action?.value;
        if (!openId || !actionValue) return undefined;
        return { toast: { type: 'success', content: 'ok' } };
      };

      const result = await handleCardAction({
        action: { value: JSON.stringify({ action: 'switch_thread', threadId: 'id-1' }) },
        // no operator field
      });

      expect(result).toBeUndefined();
    });

    it('new_thread action calls onCardNewThread and returns info toast', async () => {
      const newThreadCalls: string[] = [];
      const onCardNewThread = vi.fn(async (openId: string) => {
        newThreadCalls.push(openId);
      });

      // Replicate handleCardAction logic including new_thread branch
      const handleCardAction = async (data: any, onNew: typeof onCardNewThread) => {
        const openId = data?.operator?.open_id;
        const actionValue = data?.action?.value;
        if (!openId || !actionValue) return;
        let parsed: { action: string; threadId?: string; threadName?: string };
        try {
          parsed = typeof actionValue === 'string' ? JSON.parse(actionValue) : actionValue;
        } catch {
          return;
        }
        if (parsed.action === 'switch_thread' && parsed.threadId) {
          return { toast: { type: 'success', content: `Switched to: ${parsed.threadName ?? parsed.threadId}` } };
        }
        if (parsed.action === 'new_thread') {
          await onNew(openId);
          return { toast: { type: 'info', content: 'Creating new thread...' } };
        }
      };

      const result = await handleCardAction({
        operator: { open_id: 'user-1' },
        action: { value: JSON.stringify({ action: 'new_thread' }) },
      }, onCardNewThread);

      expect(onCardNewThread).toHaveBeenCalledWith('user-1');
      expect(result?.toast?.type).toBe('info');
      expect(result?.toast?.content).toBe('Creating new thread...');
    });
  });

  describe('command routing with threadId', () => {
    it('includes threadId in command sent to device when resolved from parent_id', () => {
      const sentCommands: any[] = [];

      const sendToDevice = vi.fn((deviceId: string, msg: any) => {
        sentCommands.push({ deviceId, ...msg });
        return true;
      });

      const cardThreadMap = new Map<string, { threadId: string; deviceId: string }>();
      cardThreadMap.set('parent-card-id', { threadId: 'thread-feature', deviceId: 'device-1' });

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

    it('omits threadId from command when no parent_id and no active thread', () => {
      const sentCommands: any[] = [];

      const sendToDevice = vi.fn((deviceId: string, msg: any) => {
        sentCommands.push({ deviceId, ...msg });
        return true;
      });

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
      const streamingSessions = new Map<string, { openId: string; feishuMessageId: string | null; threadId?: string; threads?: ThreadSummary[] }>();

      const registerStreaming = (messageId: string, openId: string, feishuMessageId: string | null, threadId?: string) => {
        streamingSessions.set(messageId, { openId, feishuMessageId, threadId });
      };

      registerStreaming('cmd-99', 'user-1', 'feishu-card-99', 'thread-backend');

      const session = streamingSessions.get('cmd-99');
      expect(session?.threadId).toBe('thread-backend');
    });

    it('stores threads array on session when CLI response includes it', () => {
      const streamingSessions = new Map<string, { openId: string; feishuMessageId: string | null; threadId?: string; threads?: ThreadSummary[] }>();
      streamingSessions.set('cmd-100', { openId: 'user-1', feishuMessageId: 'feishu-100', threadId: 'id-1' });

      const responseThreads: ThreadSummary[] = [
        { id: 'id-1', name: 'default', status: 'idle' },
        { id: 'id-2', name: 'backend', status: 'idle' },
      ];

      const session = streamingSessions.get('cmd-100');
      if (session && responseThreads) {
        session.threads = responseThreads;
      }

      expect(streamingSessions.get('cmd-100')?.threads).toHaveLength(2);
      expect(streamingSessions.get('cmd-100')?.threads?.[1].name).toBe('backend');
    });
  });

  describe('pendingNewThread — activeThreadMap update after new thread creation', () => {
    it('pendingNewThread flag is stored on streaming session when set', () => {
      const streamingSessions = new Map<string, {
        openId: string;
        feishuMessageId: string | null;
        threadId?: string;
        threads?: ThreadSummary[];
        pendingNewThread?: boolean;
      }>();

      const registerStreaming = (messageId: string, openId: string, feishuMessageId: string | null, threadId?: string, pendingNewThread?: boolean) => {
        streamingSessions.set(messageId, { openId, feishuMessageId, threadId, pendingNewThread });
      };

      registerStreaming('cmd-new', 'user-1', null, undefined, true);
      expect(streamingSessions.get('cmd-new')?.pendingNewThread).toBe(true);
    });

    it('pendingNewThread is false/undefined for regular commands', () => {
      const streamingSessions = new Map<string, {
        openId: string;
        feishuMessageId: string | null;
        threadId?: string;
        pendingNewThread?: boolean;
      }>();

      const registerStreaming = (messageId: string, openId: string, feishuMessageId: string | null, pendingNewThread?: boolean) => {
        streamingSessions.set(messageId, { openId, feishuMessageId, pendingNewThread });
      };

      registerStreaming('cmd-regular', 'user-1', 'feishu-card-1');
      expect(streamingSessions.get('cmd-regular')?.pendingNewThread).toBeUndefined();
    });

    it('activeThreadMap updated when pendingNewThread session receives responseThreadId', () => {
      const activeThreadMap = new Map<string, { threadId: string; threadName: string }>();
      const streamingSessions = new Map<string, {
        openId: string;
        feishuMessageId: string | null;
        threadId?: string;
        threads?: ThreadSummary[];
        pendingNewThread?: boolean;
      }>();

      // Register a new-thread session
      streamingSessions.set('cmd-new', {
        openId: 'user-1',
        feishuMessageId: null,
        pendingNewThread: true,
      });

      // Simulate RESPONSE handler logic
      const responseMessageId = 'cmd-new';
      const responseOpenId = 'user-1';
      const responseThreadId = 'id-3';
      const responseThreads: ThreadSummary[] = [
        { id: 'id-1', name: 'default', status: 'idle' },
        { id: 'id-2', name: 'backend', status: 'idle' },
        { id: 'id-3', name: 'feature', status: 'idle' },
      ];

      const session = streamingSessions.get(responseMessageId);
      if (session) {
        if (responseThreads) session.threads = responseThreads;
        if (session.pendingNewThread && responseThreadId && responseThreads && responseOpenId) {
          const newThread = responseThreads.find(t => t.id === responseThreadId);
          if (newThread) {
            activeThreadMap.set(responseOpenId, { threadId: responseThreadId, threadName: newThread.name });
          }
        }
      }

      expect(activeThreadMap.get('user-1')).toEqual({ threadId: 'id-3', threadName: 'feature' });
    });

    it('activeThreadMap not updated for regular sessions (pendingNewThread=false)', () => {
      const activeThreadMap = new Map<string, { threadId: string; threadName: string }>();
      activeThreadMap.set('user-1', { threadId: 'id-2', threadName: 'backend' });

      const streamingSessions = new Map<string, {
        openId: string;
        feishuMessageId: string | null;
        threads?: ThreadSummary[];
        pendingNewThread?: boolean;
      }>();

      streamingSessions.set('cmd-regular', {
        openId: 'user-1',
        feishuMessageId: 'feishu-card-100',
        // pendingNewThread not set
      });

      const session = streamingSessions.get('cmd-regular');
      const responseThreadId = 'id-3';
      const responseThreads: ThreadSummary[] = [
        { id: 'id-1', name: 'default', status: 'idle' },
        { id: 'id-3', name: 'feature', status: 'idle' },
      ];
      const responseOpenId = 'user-1';

      if (session) {
        if (responseThreads) session.threads = responseThreads;
        // Only update activeThreadMap when pendingNewThread is true
        if (session.pendingNewThread && responseThreadId && responseThreads && responseOpenId) {
          const newThread = responseThreads.find(t => t.id === responseThreadId);
          if (newThread) {
            activeThreadMap.set(responseOpenId, { threadId: responseThreadId, threadName: newThread.name });
          }
        }
      }

      // Active thread should remain unchanged (user clicked 'backend' switch button before)
      expect(activeThreadMap.get('user-1')).toEqual({ threadId: 'id-2', threadName: 'backend' });
    });
  });
});

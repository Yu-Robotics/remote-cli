import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from '../../../src/executor/acp/SessionManager';

describe('SessionManager', () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-manager-test-'));
    manager = new SessionManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return empty string when no history exists', () => {
    const context = manager.buildResumeContext('nonexistent-session');
    expect(context).toBe('');
  });

  it('should append entries and persist them', () => {
    manager.append('session-1', 'user', 'Hello Gemini');
    manager.append('session-1', 'assistant', 'Hi there!');

    const file = path.join(tmpDir, 'session-1.jsonl');
    expect(fs.existsSync(file)).toBe(true);

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.role).toBe('user');
    expect(first.text).toBe('Hello Gemini');
    expect(typeof first.ts).toBe('number');
  });

  it('should build resume context with proper formatting', () => {
    manager.append('session-2', 'user', 'What is 2+2?');
    manager.append('session-2', 'assistant', '2+2 equals 4');

    const context = manager.buildResumeContext('session-2');
    expect(context).toContain('=== PREVIOUS CONVERSATION ===');
    expect(context).toContain('[User]: What is 2+2?');
    expect(context).toContain('[Assistant]: 2+2 equals 4');
    expect(context).toContain('=== NEW REQUEST ===');
  });

  it('should clear history while keeping the file', () => {
    manager.append('session-3', 'user', 'Hello');
    manager.clear('session-3');

    const context = manager.buildResumeContext('session-3');
    expect(context).toBe('');
  });

  it('should remove session file on remove()', () => {
    manager.append('session-4', 'user', 'Hello');

    const file = path.join(tmpDir, 'session-4.jsonl');
    expect(fs.existsSync(file)).toBe(true);

    manager.remove('session-4');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('should grow history across multiple appends', () => {
    for (let i = 0; i < 5; i++) {
      manager.append('session-5', 'user', `message ${i}`);
      manager.append('session-5', 'assistant', `response ${i}`);
    }

    const context = manager.buildResumeContext('session-5');
    for (let i = 0; i < 5; i++) {
      expect(context).toContain(`message ${i}`);
      expect(context).toContain(`response ${i}`);
    }
  });

  it('should not throw when clearing a nonexistent session', () => {
    expect(() => manager.clear('does-not-exist')).not.toThrow();
  });

  it('should not throw when removing a nonexistent session', () => {
    expect(() => manager.remove('does-not-exist')).not.toThrow();
  });

  describe('truncate()', () => {
    it('should remove older entries and keep the most recent ones', () => {
      for (let i = 0; i < 15; i++) {
        manager.append('trunc-1', i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`);
      }

      const removed = manager.truncate('trunc-1', 10);
      expect(removed).toBe(5);

      const context = manager.buildResumeContext('trunc-1');
      // Oldest entries (msg-0 through msg-4) should be gone
      expect(context).not.toContain('msg-0');
      expect(context).not.toContain('msg-4');
      // Most recent 10 entries should remain
      expect(context).toContain('msg-5');
      expect(context).toContain('msg-14');
    });

    it('should return 0 when history is already within keepCount', () => {
      manager.append('trunc-2', 'user', 'only one');
      const removed = manager.truncate('trunc-2', 10);
      expect(removed).toBe(0);
    });

    it('should return 0 for a nonexistent session', () => {
      const removed = manager.truncate('no-session', 10);
      expect(removed).toBe(0);
    });

    it('should keep exactly keepCount entries when truncating', () => {
      for (let i = 0; i < 20; i++) {
        manager.append('trunc-3', 'user', `item-${i}`);
      }

      manager.truncate('trunc-3', 5);

      const file = path.join(tmpDir, 'trunc-3.jsonl');
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(5);

      const last = JSON.parse(lines[4]);
      expect(last.text).toBe('item-19');
    });
  });
});

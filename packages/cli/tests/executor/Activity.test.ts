import { describe, it, expect, vi } from 'vitest';
import {
  ActivityTracker,
  ACTIVITY_BUFFER_LIMIT,
  ACTIVITY_SUMMARY_KEYS,
  activityFromTool,
  extractTodoPlan,
  normalizeActivity,
  sanitizeActivityText,
  MAX_ACTIVITY_TEXT_LENGTH,
} from '../../src/executor/Activity';
import type { ActivityProgressInfo } from '../../src/types';

describe('Activity layer', () => {
  describe('sanitizeActivityText', () => {
    it('collapses newlines, tabs, and multiple spaces into a single space and trims ends', () => {
      const input = '  First line\n\n\tSecond line   \r\nThird line   ';
      expect(sanitizeActivityText(input)).toBe('First line Second line Third line');
    });

    it('strips ANSI escape codes and control characters', () => {
      const input = '\u001b[32mSuccess\u001b[0m\x00\x07 with \u001b[1mbold\u001b[22m text';
      expect(sanitizeActivityText(input)).toBe('Success with bold text');
    });

    it('bounds text to <= 240 Unicode code points without splitting multi-byte characters', () => {
      const emojiString = '🚀'.repeat(300);
      const sanitized = sanitizeActivityText(emojiString);
      const points = Array.from(sanitized);
      expect(points.length).toBe(MAX_ACTIVITY_TEXT_LENGTH);
      expect(sanitized).toBe('🚀'.repeat(240));
    });

    it('returns empty string for non-string or whitespace-only input', () => {
      expect(sanitizeActivityText('')).toBe('');
      expect(sanitizeActivityText('    \n\t  ')).toBe('');
      expect(sanitizeActivityText(undefined as any)).toBe('');
      expect(sanitizeActivityText(null as any)).toBe('');
    });
  });

  describe('normalizeActivity', () => {
    it('validates supported sources and normalizes text', () => {
      const validSources: ActivityProgressInfo['source'][] = [
        'public_text',
        'reasoning_summary',
        'plan',
        'tool',
        'state',
      ];

      for (const source of validSources) {
        const result = normalizeActivity({ source, text: '  Hello\nworld  ' });
        expect(result).toEqual({ source, text: 'Hello world' });
      }
    });

    it('rejects unsupported sources', () => {
      expect(normalizeActivity({ source: 'unsupported', text: 'hello' })).toBeUndefined();
      expect(normalizeActivity({ source: 'thought', text: 'hello' })).toBeUndefined();
      expect(normalizeActivity({ source: '', text: 'hello' })).toBeUndefined();
    });

    it('rejects invalid inputs', () => {
      expect(normalizeActivity(null)).toBeUndefined();
      expect(normalizeActivity(undefined)).toBeUndefined();
      expect(normalizeActivity('string')).toBeUndefined();
      expect(normalizeActivity(123)).toBeUndefined();
      expect(normalizeActivity({ source: 'public_text', text: '' })).toBeUndefined();
      expect(normalizeActivity({ source: 'public_text', text: '   ' })).toBeUndefined();
      expect(normalizeActivity({ source: 'public_text' })).toBeUndefined();
    });
  });

  describe('extractTodoPlan', () => {
    it('extracts in-progress todo task preferentially', () => {
      const input = {
        todos: [
          { status: 'completed', content: 'Step 1: setup repo' },
          { status: 'in_progress', content: 'Step 2: implement feature' },
          { status: 'pending', content: 'Step 3: run tests' },
        ],
      };
      expect(extractTodoPlan(input)).toBe('Step 2: implement feature');
    });

    it('extracts pending todo task when no task is in-progress', () => {
      const input = {
        todos: [
          { status: 'completed', content: 'Step 1: setup repo' },
          { status: 'pending', content: 'Step 2: next task' },
        ],
      };
      expect(extractTodoPlan(input)).toBe('Step 2: next task');
    });

    it('extracts first item when no statuses match', () => {
      const input = {
        todos: [{ title: 'First standalone task' }],
      };
      expect(extractTodoPlan(input)).toBe('First standalone task');
    });

    it('supports rawInput.todos structure', () => {
      const input = {
        rawInput: {
          todos: [{ status: 'active', step: 'Active step in raw input' }],
        },
      };
      expect(extractTodoPlan(input)).toBe('Active step in raw input');
    });

    it('supports string array todos', () => {
      const input = {
        todos: ['First task in list', 'Second task'],
      };
      expect(extractTodoPlan(input)).toBe('First task in list');
    });

    it('returns undefined when todos are missing or empty', () => {
      expect(extractTodoPlan({})).toBeUndefined();
      expect(extractTodoPlan({ todos: [] })).toBeUndefined();
      expect(extractTodoPlan(undefined)).toBeUndefined();
    });

    it('keeps blocked and pending steps visible instead of selecting an already completed first step', () => {
      expect(extractTodoPlan({ todos: [{ status: 'completed', content: 'Old step' }, { status: 'blocked', content: 'Await access' }] }))
        .toBe('Blocked: Await access');
      expect(extractTodoPlan({ todos: [{ status: 'completed', content: 'Old step' }, { status: 'pending', step: 'Next step' }] }))
        .toBe('Next step');
      expect(extractTodoPlan({ todos: [{ status: 'completed', content: 'Last step' }] })).toBe('Plan steps complete');
      expect(extractTodoPlan({ todos: [{ status: 'cancelled', content: 'Abandoned step' }] })).toBeUndefined();
    });
  });

  describe('activityFromTool', () => {
    it('does not interpret arbitrary tool inputs as todos or use command-like titles', () => {
      expect(activityFromTool('Read', { todos: [{ content: 'Not a verified plan' }] })?.source).toBe('tool');
      expect(activityFromTool('Bash', { command: 'git diff' }, 'git diff')).toEqual({ source: 'tool', text: 'Running command' });
      expect(activityFromTool('Bash', {}, 'curl --header Authorization: synthetic_token https://example.com')?.text).toBe('Running command');
      expect(activityFromTool('Read', { path: '/workspace/file' }, '/workspace/file')).toEqual({ source: 'tool', text: 'Reading file' });
      expect(activityFromTool('Bash', { description: 'Read a password' })).toEqual({ source: 'tool', text: 'Running command' });
    });
    it('maps todo tool calls with todos to plan source', () => {
      const result = activityFromTool('todo_write', {
        todos: [{ status: 'in_progress', content: 'Refactor database module' }],
      });
      expect(result).toEqual({
        source: 'plan',
        text: 'Refactor database module',
      });
    });

    it('never leaks raw commands or secret parameters for Bash tools', () => {
      const result = activityFromTool('Bash', {
        command: 'curl -H "Authorization: Bearer synthetic_token" https://example.com/deploy',
      });
      expect(result).toEqual({
        source: 'tool',
        text: 'Running command',
      });
      expect(result?.text).not.toContain('secret_token');
      expect(result?.text).not.toContain('curl');
    });

    it('uses safe title or description when provided', () => {
      const withTitle = activityFromTool('Bash', { command: 'npm test' }, 'Run unit tests');
      expect(withTitle).toEqual({
        source: 'tool',
        text: 'Run unit tests',
      });

      const withDesc = activityFromTool('Bash', {
        command: 'git status',
        description: 'Check repository status',
      });
      expect(withDesc).toEqual({
        source: 'tool',
        text: 'Check repository status',
      });
    });

    it('maps known tool names to friendly human-readable descriptions', () => {
      expect(activityFromTool('Edit', { file_path: 'foo.ts' })).toEqual({
        source: 'tool',
        text: 'Editing file',
      });
      expect(activityFromTool('Read', { file_path: 'foo.ts' })).toEqual({
        source: 'tool',
        text: 'Reading file',
      });
      expect(activityFromTool('WebSearch', { query: 'vitest docs' })).toEqual({
        source: 'tool',
        text: 'Searching the web',
      });
      expect(activityFromTool('Glob', { pattern: '*.ts' })).toEqual({
        source: 'tool',
        text: 'Searching code',
      });
      expect(activityFromTool('CustomTool')).toEqual({
        source: 'tool',
        text: 'Using CustomTool',
      });
    });
  });

  describe('ActivityTracker', () => {
    it('bounds long streams, preserves the newest text and keeps only bounded summary keys', () => {
      const tracker = new ActivityTracker();
      tracker.emitPublicText('x'.repeat(100_000));
      tracker.emitPublicText(' newest update');
      expect(tracker.getLastActivity()?.text.endsWith(' newest update')).toBe(true);
      expect((tracker as any).accumulatedPublicText.length).toBeLessThanOrEqual(ACTIVITY_BUFFER_LIMIT);
      for (let index = 0; index < 100; index++) tracker.emitReasoningSummary('y'.repeat(100_000), `item-${index}`);
      expect((tracker as any).summaries.size).toBe(ACTIVITY_SUMMARY_KEYS);
      for (const value of (tracker as any).summaries.values()) expect(value.length).toBeLessThanOrEqual(ACTIVITY_BUFFER_LIMIT);
      tracker.reset();
      expect((tracker as any).summaries.size).toBe(0);
    });

    it('reassembles interleaved item/index summaries and isolates missing keys', () => {
      const tracker = new ActivityTracker();
      tracker.emitReasoningSummary('Read ', 'r1:0');
      tracker.emitReasoningSummary('Check ', 'r2:0');
      tracker.emitReasoningSummary('files', 'r1:0');
      expect(tracker.getLastActivity()?.text).toBe('Read files');
      tracker.emitReasoningSummary('tests', 'r2:0');
      expect(tracker.getLastActivity()?.text).toBe('Check tests');
      tracker.emitReasoningSummary('New index', 'r1:1');
      expect(tracker.getLastActivity()?.text).toBe('New index');
      tracker.emitReasoningSummary('Unkeyed summary');
      expect(tracker.getLastActivity()?.text).toBe('Unkeyed summary');
      tracker.emitReasoningSummary('Another unkeyed summary');
      expect(tracker.getLastActivity()?.text).toBe('Another unkeyed summary');
    });

    it('isolates callback failure and does not expose mutable accumulator state', () => {
      const tracker = new ActivityTracker(() => { throw new Error('UI disconnected'); });
      expect(() => tracker.emitPlan('Check callback safety')).not.toThrow();
      tracker.getLastActivity()!.text = 'Mutated';
      expect(tracker.getLastActivity()?.text).toBe('Check callback safety');
      expect(normalizeActivity(Object.assign([], { source: 'plan', text: 'Not an object' }))).toBeUndefined();
    });
    it('deduplicates identical consecutive activities', () => {
      const emitted: ActivityProgressInfo[] = [];
      const tracker = new ActivityTracker((a) => emitted.push(a));

      tracker.emit({ source: 'public_text', text: 'Hello' });
      tracker.emit({ source: 'public_text', text: 'Hello' });
      tracker.emit({ source: 'public_text', text: 'Hello' });
      expect(emitted).toHaveLength(1);

      tracker.emit({ source: 'public_text', text: 'Hello world' });
      expect(emitted).toHaveLength(2);
      expect(emitted[1].text).toBe('Hello world');
    });

    it('accumulates streaming public text up to max length', () => {
      const emitted: ActivityProgressInfo[] = [];
      const tracker = new ActivityTracker((a) => emitted.push(a));

      tracker.emitPublicText('First ');
      tracker.emitPublicText('chunk.');
      expect(emitted).toEqual([
        { source: 'public_text', text: 'First' },
        { source: 'public_text', text: 'First chunk.' },
      ]);
    });

    it('accumulates and separates reasoning summary by key', () => {
      const emitted: ActivityProgressInfo[] = [];
      const tracker = new ActivityTracker((a) => emitted.push(a));

      tracker.emitReasoningSummary('Thinking about ', 'item-1');
      tracker.emitReasoningSummary('architecture', 'item-1');
      expect(emitted).toEqual([
        { source: 'reasoning_summary', text: 'Thinking about' },
        { source: 'reasoning_summary', text: 'Thinking about architecture' },
      ]);

      // Different key starts fresh reasoning summary buffer
      tracker.emitReasoningSummary('Planning next steps', 'item-2');
      expect(emitted[2]).toEqual({
        source: 'reasoning_summary',
        text: 'Planning next steps',
      });
    });

    it('clears previous text buffer when source changes to tool or plan', () => {
      const emitted: ActivityProgressInfo[] = [];
      const tracker = new ActivityTracker((a) => emitted.push(a));

      tracker.emitPublicText('Analyzing codebase');
      expect(emitted).toHaveLength(1);

      tracker.emitTool('Bash', {}, 'Run tests');
      expect(emitted).toHaveLength(2);
      expect(emitted[1]).toEqual({ source: 'tool', text: 'Run tests' });

      // After tool, new public text does not prepend old public text
      tracker.emitPublicText('Tests passed, compiling now');
      expect(emitted).toHaveLength(3);
      expect(emitted[2]).toEqual({ source: 'public_text', text: 'Tests passed, compiling now' });
    });

    it('resets state completely across turns', () => {
      const emitted: ActivityProgressInfo[] = [];
      const tracker = new ActivityTracker((a) => emitted.push(a));

      tracker.emitPublicText('Turn 1 text');
      expect(tracker.getLastActivity()).toEqual({ source: 'public_text', text: 'Turn 1 text' });

      tracker.reset();
      expect(tracker.getLastActivity()).toBeUndefined();

      // Emitting the same text after reset is not blocked by dedup
      tracker.emitPublicText('Turn 1 text');
      expect(emitted).toHaveLength(2);
      expect(emitted[1]).toEqual({ source: 'public_text', text: 'Turn 1 text' });
    });
  });
});

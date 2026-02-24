import { describe, it, expect } from 'vitest';
import { createRedactedThinkingElement, createMarkdownElement, createToolUseElement } from '../src/utils/ToolFormatter';

describe('ToolFormatter - Redacted Thinking', () => {
  describe('createRedactedThinkingElement', () => {
    it('should create valid Feishu Card 2.0 elements', () => {
      const elements = createRedactedThinkingElement();

      // Should return an array
      expect(Array.isArray(elements)).toBe(true);
      expect(elements.length).toBeGreaterThan(0);
    });

    it('should include divider and markdown elements', () => {
      const elements = createRedactedThinkingElement();

      // Should have exactly 2 elements (divider + markdown)
      expect(elements.length).toBe(2);

      // First element should be divider (hr)
      expect(elements[0].tag).toBe('hr');

      // Second element should be markdown (note tag not supported in Card 2.0)
      expect(elements[1].tag).toBe('markdown');
    });

    it('should contain user-friendly notification text', () => {
      const elements = createRedactedThinkingElement();
      const markdownElement = elements.find((el: any) => el.tag === 'markdown');

      expect(markdownElement).toBeDefined();
      expect(markdownElement.content).toBeDefined();
      expect(typeof markdownElement.content).toBe('string');

      // Check for key phrases
      expect(markdownElement.content).toContain('filtered by safety systems');
      expect(markdownElement.content.toLowerCase()).toContain('reasoning');
    });

    it('should not contain encrypted content', () => {
      const elements = createRedactedThinkingElement();
      const jsonStr = JSON.stringify(elements);

      // Should not expose any encrypted/technical content
      expect(jsonStr).not.toContain('ENCRYPTED');
      expect(jsonStr).not.toContain('redacted_thinking');
      expect(jsonStr).not.toContain('encrypted');
    });

    it('should reassure user about response quality', () => {
      const elements = createRedactedThinkingElement();
      const jsonStr = JSON.stringify(elements).toLowerCase();

      // Should contain reassuring message
      expect(jsonStr).toContain('does not affect');
      expect(jsonStr).toContain('response quality');
    });

    it('should be idempotent — multiple calls return identical structure', () => {
      const first = createRedactedThinkingElement();
      const second = createRedactedThinkingElement();

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });
  });

  describe('Integration with other formatters', () => {
    it('should be compatible with markdown elements', () => {
      const elements = [
        createMarkdownElement('Some text before'),
        ...createRedactedThinkingElement(),
        createMarkdownElement('Some text after')
      ];

      // All elements should have valid structure
      expect(elements.length).toBeGreaterThan(3);
      elements.forEach(el => {
        expect(el).toHaveProperty('tag');
        expect(typeof el.tag).toBe('string');
      });
    });

    it('should create unique element structure', () => {
      const redactedElements = createRedactedThinkingElement();
      const markdownElements = [createMarkdownElement('test')];

      // Redacted thinking elements should be distinct
      const redactedJson = JSON.stringify(redactedElements);
      const markdownJson = JSON.stringify(markdownElements);

      expect(redactedJson).not.toBe(markdownJson);
      expect(redactedElements[0].tag).not.toBe(markdownElements[0].tag);
    });

    it('should interleave correctly between tool_use and markdown elements', () => {
      const combined = [
        ...createToolUseElement({ name: 'Read', id: 'id1', input: { file_path: '/x' } }),
        createMarkdownElement('some text'),
        ...createRedactedThinkingElement(),
        createMarkdownElement('after redacted'),
      ];

      // All elements must have a tag property
      combined.forEach(el => expect(el).toHaveProperty('tag'));

      // Markdown elements should appear (including the redacted thinking one)
      const markdownCount = combined.filter((el: any) => el.tag === 'markdown').length;
      expect(markdownCount).toBeGreaterThanOrEqual(3); // 'some text' + redacted + 'after redacted'
    });
  });

  describe('Visual formatting', () => {
    it('should have emoji indicator', () => {
      const elements = createRedactedThinkingElement();
      const jsonStr = JSON.stringify(elements);

      // Should include thinking emoji
      expect(jsonStr).toContain('💭');
    });

    it('should use markdown tag for Card 2.0 compatibility', () => {
      const elements = createRedactedThinkingElement();

      // Markdown tag is used for Card 2.0 (note tag is not supported)
      const hasMarkdownTag = elements.some((el: any) => el.tag === 'markdown');
      expect(hasMarkdownTag).toBe(true);
    });

    it('should use hr divider before note, not a markdown element', () => {
      const elements = createRedactedThinkingElement();

      // First element must be hr, NOT markdown — ensures visual separation
      expect(elements[0].tag).toBe('hr');
      expect(elements[0].tag).not.toBe('markdown');
    });
  });
});

describe('ToolFormatter - Redacted Thinking', () => {
  describe('createRedactedThinkingElement', () => {
    it('should create valid Feishu Card 2.0 elements', () => {
      const elements = createRedactedThinkingElement();

      // Should return an array
      expect(Array.isArray(elements)).toBe(true);
      expect(elements.length).toBeGreaterThan(0);
    });

    it('should include divider and markdown elements', () => {
      const elements = createRedactedThinkingElement();

      // Should have exactly 2 elements (divider + markdown)
      expect(elements.length).toBe(2);

      // First element should be divider (hr)
      expect(elements[0].tag).toBe('hr');

      // Second element should be markdown (note tag not supported in Card 2.0)
      expect(elements[1].tag).toBe('markdown');
    });

    it('should contain user-friendly notification text', () => {
      const elements = createRedactedThinkingElement();
      const markdownElement = elements.find((el: any) => el.tag === 'markdown');

      expect(markdownElement).toBeDefined();
      expect(markdownElement.content).toBeDefined();
      expect(typeof markdownElement.content).toBe('string');

      // Check for key phrases
      expect(markdownElement.content).toContain('filtered by safety systems');
      expect(markdownElement.content.toLowerCase()).toContain('reasoning');
    });

    it('should not contain encrypted content', () => {
      const elements = createRedactedThinkingElement();
      const jsonStr = JSON.stringify(elements);

      // Should not expose any encrypted/technical content
      expect(jsonStr).not.toContain('ENCRYPTED');
      expect(jsonStr).not.toContain('redacted_thinking');
      expect(jsonStr).not.toContain('encrypted');
    });

    it('should reassure user about response quality', () => {
      const elements = createRedactedThinkingElement();
      const jsonStr = JSON.stringify(elements).toLowerCase();

      // Should contain reassuring message
      expect(jsonStr).toContain('does not affect');
      expect(jsonStr).toContain('response quality');
    });
  });

  describe('Integration with other formatters', () => {
    it('should be compatible with markdown elements', () => {
      const elements = [
        createMarkdownElement('Some text before'),
        ...createRedactedThinkingElement(),
        createMarkdownElement('Some text after')
      ];

      // All elements should have valid structure
      expect(elements.length).toBeGreaterThan(3);
      elements.forEach(el => {
        expect(el).toHaveProperty('tag');
        expect(typeof el.tag).toBe('string');
      });
    });

    it('should create unique element structure', () => {
      const redactedElements = createRedactedThinkingElement();
      const markdownElements = [createMarkdownElement('test')];

      // Redacted thinking elements should be distinct
      const redactedJson = JSON.stringify(redactedElements);
      const markdownJson = JSON.stringify(markdownElements);

      expect(redactedJson).not.toBe(markdownJson);
      expect(redactedElements[0].tag).not.toBe(markdownElements[0].tag);
    });
  });

  describe('Visual formatting', () => {
    it('should have emoji indicator', () => {
      const elements = createRedactedThinkingElement();
      const jsonStr = JSON.stringify(elements);

      // Should include thinking emoji
      expect(jsonStr).toContain('💭');
    });

    it('should use markdown tag for Card 2.0 compatibility', () => {
      const elements = createRedactedThinkingElement();

      // Markdown tag is used for Card 2.0 (note tag is not supported)
      const hasMarkdownTag = elements.some((el: any) => el.tag === 'markdown');
      expect(hasMarkdownTag).toBe(true);
    });
  });
});

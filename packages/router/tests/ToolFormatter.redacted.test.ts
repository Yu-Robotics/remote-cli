import { describe, it, expect } from 'vitest';
import { createRedactedThinkingElement, createMarkdownElement } from '../src/utils/ToolFormatter';

describe('ToolFormatter - Redacted Thinking', () => {
  describe('createRedactedThinkingElement', () => {
    it('should create valid Feishu Card 2.0 elements', () => {
      const elements = createRedactedThinkingElement();

      // Should return an array
      expect(Array.isArray(elements)).toBe(true);
      expect(elements.length).toBeGreaterThan(0);
    });

    it('should include divider and note elements', () => {
      const elements = createRedactedThinkingElement();

      // Should have at least 2 elements (divider + note)
      expect(elements.length).toBeGreaterThanOrEqual(2);

      // First element should be divider (hr)
      expect(elements[0].tag).toBe('hr');

      // Should have a note element
      const noteElement = elements.find((el: any) => el.tag === 'note');
      expect(noteElement).toBeDefined();
    });

    it('should contain user-friendly notification text', () => {
      const elements = createRedactedThinkingElement();
      const noteElement = elements.find((el: any) => el.tag === 'note');

      expect(noteElement).toBeDefined();
      expect(noteElement.elements).toBeDefined();
      expect(Array.isArray(noteElement.elements)).toBe(true);

      // Should have plain_text elements with notification
      const textElements = noteElement.elements.filter((el: any) => el.tag === 'plain_text');
      expect(textElements.length).toBeGreaterThan(0);

      // Check for key phrases
      const allText = textElements.map((el: any) => el.content).join(' ');
      expect(allText).toContain('filtered by safety systems');
      expect(allText.toLowerCase()).toContain('reasoning');
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

    it('should use note tag for visual distinction', () => {
      const elements = createRedactedThinkingElement();

      // Note tag creates a visually distinct box in Feishu
      const hasNoteTag = elements.some((el: any) => el.tag === 'note');
      expect(hasNoteTag).toBe(true);
    });
  });
});

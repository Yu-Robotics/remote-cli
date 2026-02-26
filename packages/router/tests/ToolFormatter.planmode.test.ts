import { describe, it, expect } from 'vitest';
import { createPlanModeElement, createMarkdownElement, createToolUseElement, truncate } from '../src/utils/ToolFormatter';

describe('ToolFormatter - Plan Mode', () => {
  describe('createPlanModeElement', () => {
    it('should return an array with at least one element', () => {
      const elements = createPlanModeElement('Step 1: Read file\nStep 2: Edit it');
      expect(Array.isArray(elements)).toBe(true);
      expect(elements.length).toBeGreaterThan(0);
    });

    it('should include a divider (hr) as the first element', () => {
      const elements = createPlanModeElement('Some plan');
      expect(elements[0].tag).toBe('hr');
    });

    it('should include a collapsible_panel as the second element', () => {
      const elements = createPlanModeElement('Some plan');
      expect(elements[1].tag).toBe('collapsible_panel');
    });

    it('should be expanded by default so user sees the plan immediately', () => {
      const elements = createPlanModeElement('Some plan');
      const panel = elements.find((el: any) => el.tag === 'collapsible_panel');
      expect(panel).toBeDefined();
      expect(panel!.expanded).toBe(true);
    });

    it('should include the plan content inside the collapsible panel', () => {
      const planContent = 'Step 1: Read file\nStep 2: Write output';
      const elements = createPlanModeElement(planContent);
      const panel = elements.find((el: any) => el.tag === 'collapsible_panel');

      expect(panel).toBeDefined();
      expect(panel!.elements).toBeDefined();
      const panelJson = JSON.stringify(panel!.elements);
      expect(panelJson).toContain('Step 1: Read file');
    });

    it('should show PLAN label and auto-approved indicator in the header', () => {
      const elements = createPlanModeElement('plan text');
      const panel = elements.find((el: any) => el.tag === 'collapsible_panel');
      const headerContent = JSON.stringify(panel!.header);
      expect(headerContent).toContain('PLAN');
      expect(headerContent.toLowerCase()).toContain('auto-approved');
    });

    it('should include the plan emoji 📋 in the header', () => {
      const elements = createPlanModeElement('plan text');
      const panelJson = JSON.stringify(elements);
      expect(panelJson).toContain('📋');
    });

    it('should truncate very long plan content to 2000 chars', () => {
      const longPlan = 'x'.repeat(3000);
      const elements = createPlanModeElement(longPlan);
      const panelJson = JSON.stringify(elements);
      // The original 3000-char string should not appear intact
      expect(panelJson).not.toContain('x'.repeat(2001));
      // But the truncated version (2000 chars worth) should be present
      expect(panelJson).toContain('x'.repeat(100));
    });

    it('should handle empty plan content without throwing', () => {
      expect(() => createPlanModeElement('')).not.toThrow();
    });

    it('should produce consistent structure for the same input', () => {
      const plan = 'Step 1\nStep 2';
      const first = createPlanModeElement(plan);
      const second = createPlanModeElement(plan);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('should have all elements with a tag property', () => {
      const elements = createPlanModeElement('A plan');
      elements.forEach((el: any) => {
        expect(el).toHaveProperty('tag');
        expect(typeof el.tag).toBe('string');
      });
    });
  });

  describe('Integration with other formatters', () => {
    it('should compose with markdown elements without errors', () => {
      const combined = [
        createMarkdownElement('Pre-plan text'),
        ...createPlanModeElement('Step 1: do X'),
        createMarkdownElement('Post-plan continuation'),
      ];

      combined.forEach((el: any) => {
        expect(el).toHaveProperty('tag');
      });
    });

    it('should compose with tool_use elements without errors', () => {
      const combined = [
        ...createPlanModeElement('Step 1: read file'),
        ...createToolUseElement({ name: 'Read', id: 'id_001', input: { file_path: '/tmp/x' } }),
      ];

      combined.forEach((el: any) => {
        expect(el).toHaveProperty('tag');
      });
    });

    it('should be distinguishable from redacted thinking elements', () => {
      const planElements = createPlanModeElement('some plan');
      const planJson = JSON.stringify(planElements);

      // Plan elements should not contain the redacted thinking phrase
      expect(planJson).not.toContain('filtered by safety systems');
      // But should contain plan-specific content
      expect(planJson).toContain('PLAN');
    });
  });
});

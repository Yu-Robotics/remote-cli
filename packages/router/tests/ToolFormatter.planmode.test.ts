import { describe, it, expect } from 'vitest';
import { createPlanModeElement } from '../src/utils/ToolFormatter';

describe('plan mode card', () => {
  it('renders an expanded Markdown plan and identifies its approval state', () => {
    const plan = 'Step 1: Read file\nStep 2: Write output';
    const elements = createPlanModeElement(plan);
    expect(elements).toHaveLength(2);
    expect(elements[0]).toEqual({ tag: 'hr' });
    expect(elements[1]).toMatchObject({
      tag: 'collapsible_panel', expanded: true,
      header: { title: { tag: 'markdown', content: expect.stringMatching(/plan.*auto-approved/i) } },
      elements: [{ tag: 'markdown', content: plan }],
    });
  });

  it('bounds long plans without dropping the visible preview', () => {
    const content = createPlanModeElement('x'.repeat(3000))[1].elements![0].content!;
    expect(content).toContain('x'.repeat(100));
    expect(content).not.toContain('x'.repeat(2001));
    expect(content.length).toBeLessThanOrEqual(2000);
  });

  it('accepts an empty plan as Markdown content', () => {
    expect(createPlanModeElement('')[1].elements).toEqual([{ tag: 'markdown', content: '' }]);
  });
});

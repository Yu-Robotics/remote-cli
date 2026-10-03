import { describe, it, expect } from 'vitest';
import { createRedactedThinkingElement } from '../src/utils/ToolFormatter';

describe('redacted thinking notice', () => {
  it('renders a separated Card 2.0 Markdown notice explaining filtered reasoning', () => {
    const elements = createRedactedThinkingElement();
    expect(elements).toEqual([
      { tag: 'hr' },
      { tag: 'markdown', content: expect.stringMatching(/reasoning.*filtered/i) },
    ]);
  });

  it('does not expose encrypted content or internal protocol markers', () => {
    const rendered = JSON.stringify(createRedactedThinkingElement());
    expect(rendered).not.toMatch(/encrypted|redacted_thinking/i);
  });
});

import { describe, expect, it } from 'vitest';
import { ACTIVITY_ELEMENT_ID, activityLiteral, createActivityElement, parseActivityProgress } from '../src/utils/ActivityProgress';

describe('public activity validation', () => {
  it.each(['public_text', 'reasoning_summary', 'plan', 'tool', 'state'] as const)('accepts %s as literal bounded public text', source => {
    const activity = parseActivityProgress({ source, text: '  Read\nREADME\t\u0000\u202e<&>  ' })!;
    expect(activity).toEqual({ source, text: 'Read README <&>' });
    expect(createActivityElement(activity)).toEqual({ tag: 'markdown', element_id: ACTIVITY_ELEMENT_ID,
      content: 'Running · <raw>Read README &lt;&amp;&gt;</raw>', text_size: 'notation' });
  });

  it.each([undefined, null, [], 'text', { source: 'thought', text: 'private' },
    { source: 'plan', text: [] }, { source: ['tool'], text: 'text' }, { source: 'state', text: '\u0000\u202e\n' }])
    ('rejects malformed or unsupported snapshots: %j', value => expect(parseActivityProgress(value)).toBeUndefined());

  it('bounds code points without cutting astral characters and neutralizes markup', () => {
    const text = '🧪'.repeat(300);
    expect(parseActivityProgress({ source: 'state', text })?.text).toBe('🧪'.repeat(240));
    expect(activityLiteral('</raw><at id=all>&')).toBe('<raw>&lt;/raw&gt;&lt;at id=all&gt;&amp;</raw>');
  });
});

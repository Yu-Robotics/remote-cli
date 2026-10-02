import { describe, expect, it, vi, afterEach } from 'vitest';
import { createDelegationProgressElements, DELEGATION_PROGRESS_ELEMENT_COUNT, type DelegationProgressCardState } from '../src/utils/ToolFormatter';
import { countCardTables } from '../src/utils/CardTables';

const state = (changes: Partial<DelegationProgressCardState> = {}): DelegationProgressCardState => ({
  taskId: 'task-1', backend: 'claude', phase: 'text', startedAt: Date.now() - 5000, ordinal: 2,
  activeToolCount: 0, events: [], hiddenEventCount: 0, ...changes,
});
const render = (changes: Partial<DelegationProgressCardState> = {}) => createDelegationProgressElements(state(changes));
const identity = (elements: any[]) => elements[0].columns[0].elements[0];

describe('delegated worker progress formatting', () => {
  it('identifies DSH workers without exposing the raw backend key', () => {
    expect(identity(render({ backend: 'dsh' })).content).toContain('**DSH**');
  });

  afterEach(() => vi.useRealTimers());

  it.each(['started', 'text', 'tool_use', 'tool_result', 'waiting_input', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'] as const)
    ('keeps identity and four sibling slots stable for %s', phase => {
      const elements = render({ phase });
      expect(elements).toHaveLength(DELEGATION_PROGRESS_ELEMENT_COUNT);
      expect(elements.map(element => element.element_id)).toEqual([
        'delegated_worker_2_header', 'delegated_worker_2_body', 'delegated_worker_2_meta', 'delegated_worker_2_details',
      ]);
      expect(identity(elements).icon).toEqual({ tag: 'standard_icon', token: 'robot_outlined', color: 'purple' });
      expect(elements[0]).toMatchObject({ tag: 'column_set', flex_mode: 'none' });
      expect(elements[0].columns[0]).toMatchObject({ width: 'weighted', weight: 1, vertical_align: 'center' });
      expect(elements[0].columns[1]).toMatchObject({ width: 'auto', vertical_align: 'center' });
      expect(identity(elements).content).not.toContain('<text_tag');
      expect(identity(elements).content).toContain('**Claude Code**');
      expect(identity(elements).content).toContain('· #2');
      expect(identity(elements).content).not.toContain('\n');
      expect(elements[0].columns[1].elements[0].content).not.toContain('🤖');
      expect(elements[1].tag).toBe('markdown');
      expect(elements[3]).toMatchObject({ tag: 'collapsible_panel', expanded: false });
      expect(elements[3].header.title.content).toBe('Activity details');
      expect(elements[3].elements.every((element: any) => element.tag !== 'collapsible_panel')).toBe(true);
    });

  it('renders current activity as Markdown outside the diagnostic fold', () => {
    const elements = render({ phase: 'tool_use', latestText: '## Review\n\n**Checking**\n\n- Evidence\n\n~~~ts\nconst pending = true;',
      currentToolName: 'Read', currentToolStartedAt: Date.now() - 2000, activeToolCount: 2,
      lastActivityAt: Date.now(), events: [{ label: 'Read running' }], objective: 'Sensitive internal task prompt',
    });
    expect(elements[1].content).toContain('**Latest update**\n\n## Review\n\n**Checking**');
    expect(elements[1].content).toContain('const pending = true;');
    expect(elements[2]).toMatchObject({ tag: 'markdown', text_size: 'notation' });
    expect(elements[2].content).toContain('\n<raw>Read</raw> · 2 tools active');
    expect(elements[2].content).toContain('Updated just now');
    expect(elements[3].elements[0].content).toContain('Current tool: <raw>Read</raw> · 2 tools active · 2s');
    expect(elements[3].elements[0].content).toContain('Read running');
    expect(JSON.stringify(elements)).not.toContain('Sensitive internal task prompt');
  });

  it('shows all of a 939-byte snapshot including the newest words', () => {
    const snapshot = 'A'.repeat(900) + '\nLATEST_UPDATE: now checking the result';
    expect(Buffer.byteLength(snapshot)).toBe(939);
    const elements = render({ latestText: snapshot });
    expect(elements[1].content).toContain('LATEST\\_UPDATE: now checking the result');
    expect(elements[1].content).not.toContain('omitted');
  });

  it('keeps completed output rich and visible without exposing worker tags', () => {
    const elements = render({ phase: 'succeeded', summary: '# Review\n\n**Passed**\n\n- Tests pass\n\n<at id=all></at>' });
    expect(elements[1].content).toContain('**Result excerpt**\n\n# Review\n\n**Passed**');
    expect(elements[1].content).toContain('&lt;at id\\=all&gt;');
    expect(elements[1].content).not.toContain('<at');
    expect(elements[3].elements[0].content).not.toContain('Passed');
  });

  it('shows the failure reason above the result and closes cut code fences', () => {
    const elements = render({ phase: 'failed', summary: '~~~ts\n' + 'x'.repeat(1200), error: '**Build failed**\n\n<at id=all></at>',
      events: [{ label: 'Bash failed', isError: true }], hiddenEventCount: 2, toolErrorCount: 1 });
    expect(elements[1].content.indexOf('Reason')).toBeLessThan(elements[1].content.indexOf('Result excerpt'));
    expect(elements[1].content).toContain('**Build failed**');
    expect(elements[1].content).toContain('_Result preview truncated._');
    expect(elements[1].content).not.toContain('<at');
    expect(elements[2].content).toContain('1 tool issue');
    expect(elements[2].content).toContain('see activity details');
    expect(elements[3].elements[0].content).toContain("<text_tag color='red'>Failed</text_tag>");
    expect(elements[3].elements[0].content).toContain('2 earlier activities omitted');
  });

  it('keeps a formatted input request prominent while hiding stale activity', () => {
    const elements = render({ phase: 'waiting_input', inputRequest: '**Choose**\n\n1. Allow\n2. Deny', latestText: 'Old activity' });
    expect(elements[1].content).toContain('Your input is needed');
    expect(elements[1].content).toContain('**Choose**\n\n1. Allow\n2. Deny');
    expect(elements[1].content).not.toContain('Old activity');
    expect(render({ phase: 'waiting_input' })[1].content).toContain('Check the input or approval request');
  });

  it('retains last activity honestly when no terminal result was received', () => {
    const elements = render({ phase: 'interrupted', latestText: '**Reading** files' });
    expect(elements[1].content).toContain('**Last activity · not a final result**\n\n**Reading** files');
    expect(elements[1].content).not.toContain('Result excerpt');
    expect(render({ phase: 'succeeded' })[1].content).toBe('_No result text was received._');
  });

  it('shows factual starting and tool-only fallback text', () => {
    expect(render({ phase: 'started' })[1].content).toBe('Starting…');
    expect(render()[1].content).toBe('Waiting for output…');
    expect(render({ currentToolName: 'Bash', activeToolCount: 1 })[1].content).toBe('<raw>Bash</raw>');
    expect(render()[2].content).not.toContain('Updated');
  });

  it('keeps a tool-only mobile worker compact without duplicate identity or tool metadata', () => {
    vi.useFakeTimers();
    vi.setSystemTime(175_000);
    const elements = render({ backend: 'agy', ordinal: 1, phase: 'tool_use', startedAt: 0,
      lastActivityAt: Date.now(), currentToolName: 'Read', currentToolStartedAt: Date.now(), activeToolCount: 2 });
    expect(identity(elements).content).toBe("**AGY** <font color='grey'>· #1</font>");
    expect(elements[1].content).toBe('<raw>Read</raw> · 2 tools active');
    expect(elements[2].content).toBe('2m 55s · Updated just now');
    expect(JSON.stringify(elements)).not.toContain('Worker #');
    expect(JSON.stringify(elements)).not.toContain('AGY CLI');
    expect(identity(render({ backend: 'codex' })).content).toContain('**Codex**');
    expect(elements[3].elements[0].content).toContain('0s');
  });

  it('keeps tool metadata literal and never exposes task objectives', () => {
    const elements = render({ currentToolName: '<at id=all></at>', latestText: 'Found <raw>untrusted</raw> output.', objective: 'Private prompt' });
    expect(elements[1].content).toContain('&lt;raw&gt;untrusted&lt;/raw&gt;');
    expect(elements[2].content).toContain('&lt;at id=all&gt;');
    expect(JSON.stringify(elements)).not.toContain('Private prompt');
    expect(JSON.stringify(elements)).not.toContain('<at');
  });

  it('uses one table budget across visible failure and result text', () => {
    const table = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';
    const elements = render({ phase: 'failed', error: table, summary: (table + '\n').repeat(4) });
    expect(countCardTables(elements)).toBe(3);
    expect(elements[1].content).toContain('| A | B |');
  });

  it('freezes terminal elapsed time and gives readable long-running metadata', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    expect(render({ phase: 'succeeded', startedAt: 0, finishedAt: 65_000 })[2].content).toBe('1m 5s');
    expect(render({ startedAt: 0, lastActivityAt: 0 })[2].content).toContain('2h 46m');
    expect(render({ lastActivityAt: Date.now() - 40_000 })[2].content).toContain('40s ago');
    expect(render({ lastActivityAt: Date.now() - 120_000 })[2].content).toContain('2m ago');
    expect(render({ lastActivityAt: Date.now() - 7_200_000 })[2].content).toContain('2h ago');
  });

  it('bounds identifiers and diagnostics and handles unknown backends safely', () => {
    const elements = render({ ordinal: NaN, backend: '<at id=all></at>', phase: 'unknown' as any,
      events: [{ label: 'x'.repeat(300) }], toolErrorCount: 2 });
    expect(identity(elements).content).toContain('Agent');
    expect(identity(elements).content).toContain('· #1');
    expect(elements[3].elements[0].content).toContain('…');
    expect(elements[2].content).toContain('2 tool issues');
    expect(elements[0].columns[1].elements[0].content).toContain('Updating');
  });
});

import { describe, expect, it } from 'vitest';
import { createDelegationProgressElement, type DelegationProgressCardState } from '../src/utils/ToolFormatter';

describe('delegated worker progress formatting', () => {
  it('renders active worker activity in an expanded nested panel', () => {
    const state: DelegationProgressCardState = {
      taskId: 'task-1',
      backend: 'claude',
      phase: 'tool_use',
      startedAt: Date.now() - 5_000,
      objective: 'Review the README',
      activeToolCount: 1,
      events: [{ label: 'Read started' }],
      hiddenEventCount: 0,
    };

    const panel = createDelegationProgressElement(state);

    expect(panel).toMatchObject({ tag: 'collapsible_panel', expanded: true });
    expect(panel.header.title.content).toContain('WORKER RUNNING');
    expect(panel.header.title.content).toContain('Claude Code');
    expect(panel.elements[0].content).toContain('1 active tool');
    expect(panel.elements[0].content).toContain('Read started');
  });

  it('collapses terminal progress and renders worker text literally', () => {
    const state: DelegationProgressCardState = {
      taskId: 'task-2',
      backend: 'codex',
      phase: 'failed',
      startedAt: Date.now() - 65_000,
      objective: '<script>unsafe</script>',
      summary: 'Partial result',
      error: '<b>permission denied</b>',
      activeToolCount: 0,
      events: [{ label: 'Bash failed', isError: true }],
      hiddenEventCount: 2,
    };

    const panel = createDelegationProgressElement(state);
    const content = panel.elements[0].content;

    expect(panel).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(panel.header.title.content).toContain('WORKER FAILED');
    expect(content).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    expect(content).toContain('&lt;b&gt;permission denied&lt;/b&gt;');
    expect(content).toContain('2 earlier events hidden');
  });
});

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
      latestText: 'Reading the project structure now.',
      currentToolName: 'Read',
      currentToolStartedAt: Date.now() - 2_000,
      lastToolActivityAt: Date.now() - 2_000,
      activeToolCount: 1,
      events: [{ label: 'Read started' }],
      hiddenEventCount: 0,
    };

    const panel = createDelegationProgressElement(state);

    expect(panel).toMatchObject({ tag: 'collapsible_panel', expanded: true });
    expect(panel.header.title.content).toContain('WORKER RUNNING');
    expect(panel.header.title.content).toContain('Claude Code');
    expect(panel.elements[0].content).toBe('**📝 Current activity**');
    expect(panel.elements[1].content).toBe('Reading the project structure now\\.');
    const metadata = panel.elements[2].content;
    expect(metadata).toContain('**⚙️ Current tool** · <raw>Read');
    expect(metadata).not.toContain('Latest update');
    expect(metadata).toContain('_Elapsed');
    expect(metadata).toContain('Last tool activity');
    expect(metadata).toContain('**📋 Recent activity:**');
    expect(metadata).toContain('- <raw>Read started</raw>');
    expect(metadata).not.toContain('• <raw>Read started</raw>');
  });

  it('collapses terminal progress and renders worker text literally', () => {
    const state: DelegationProgressCardState = {
      taskId: 'task-2',
      backend: 'codex',
      phase: 'failed',
      startedAt: Date.now() - 65_000,
      objective: 'Review the implementation',
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
    expect(panel.elements.at(-1).content).toContain('&lt;b&gt;permission denied&lt;/b&gt;');
    expect(content).toContain('2 earlier events hidden');
  });

  it('renders the terminal result as separate Markdown inside the collapsed panel', () => {
    const panel = createDelegationProgressElement({
      taskId: 'rich-result', backend: 'claude', phase: 'succeeded', startedAt: Date.now(),
      summary: '## Review\n\n**Passed**\n\n- Tests pass\n- Build passes\n\n```ts\nconst ok = true;\n```',
      activeToolCount: 0, events: [], hiddenEventCount: 0,
    });
    expect(panel.expanded).toBe(false);
    expect(panel.elements[1].content).toBe('**Result:**');
    expect(panel.elements[2].content).toContain('## Review\n\n**Passed**');
    expect(panel.elements[2].content).toContain('- Tests pass\n- Build passes');
    expect(panel.elements[2].content).toContain('```ts\nconst ok = true;\n```');
    expect(panel.elements[2].content).not.toContain('<raw>');
  });

  it('keeps a cut code result separate from the literal failure reason', () => {
    const panel = createDelegationProgressElement({
      taskId: 'cut-result', backend: 'agy', phase: 'failed', startedAt: Date.now(),
      summary: '```ts\n' + 'x'.repeat(1200), error: '<at id=all></at>',
      activeToolCount: 0, events: [], hiddenEventCount: 0,
    });
    expect(panel.elements[2].content).toContain('\n```\n\n_Result preview truncated._');
    expect(panel.elements[3].content).toContain('**Reason:** <raw>&lt;at id=all&gt;&lt;/at&gt;</raw>');
  });

  it('does not repeat an active tool as fallback activity when no response text exists', () => {
    const state: DelegationProgressCardState = {
      taskId: 'task-4',
      backend: 'agy',
      phase: 'tool_use',
      startedAt: Date.now() - 5_000,
      currentToolName: 'Bash',
      currentToolStartedAt: Date.now() - 1_000,
      lastToolActivityAt: Date.now() - 1_000,
      activeToolCount: 1,
      events: [],
      hiddenEventCount: 0,
    };

    const content = createDelegationProgressElement(state).elements[0].content;

    expect(content).not.toContain('📝 Current activity');
    expect(content).toContain('**⚙️ Current tool** · <raw>Bash');
  });

  it('shows a concise fallback activity before the worker produces text or starts a tool', () => {
    const state: DelegationProgressCardState = {
      taskId: 'task-5',
      backend: 'claude',
      phase: 'started',
      startedAt: Date.now() - 1_000,
      activeToolCount: 0,
      events: [],
      hiddenEventCount: 0,
    };

    const content = createDelegationProgressElement(state).elements[0].content;

    expect(content).toContain('**📝 Current activity**\n<raw>Starting worker session</raw>');
    expect(content).not.toContain('**⚙️ Current tool**');
  });

  it('renders worker text literally without exposing the task objective as the main body', () => {
    const state: DelegationProgressCardState = {
      taskId: 'task-3',
      backend: 'pi',
      phase: 'text',
      startedAt: Date.now() - 10_000,
      objective: 'Sensitive internal task prompt',
      latestText: 'Found <raw>untrusted</raw> output.',
      activeToolCount: 0,
      events: [],
      hiddenEventCount: 0,
    };

    const panel = createDelegationProgressElement(state);
    const content = panel.elements.map((element: any) => element.content).join('\n');

    expect(content).toContain('📝 Current activity');
    expect(content).toContain('&lt;raw&gt;untrusted&lt;/raw&gt;');
    expect(content).not.toContain('Sensitive internal task prompt');
  });

  it('preserves activity Markdown and closes a streaming code fence before tool metadata', () => {
    const panel = createDelegationProgressElement({
      taskId: 'streaming-markdown', backend: 'agy', phase: 'tool_use', startedAt: Date.now(),
      latestText: '# Review\n\n**Checking**\n\n- Evidence\n\n```ts\nconst pending = true;',
      currentToolName: 'Read', activeToolCount: 1, events: [{ label: 'Read started' }], hiddenEventCount: 0,
    });
    expect(panel.elements[1].content).toContain('# Review\n\n**Checking**\n\n- Evidence');
    expect(panel.elements[1].content).toContain('```ts\nconst pending = true;\n```');
    expect(panel.elements[2].content).toContain('**⚙️ Current tool**');
    expect(panel.elements[2].content).toContain('**📋 Recent activity:**');
  });
});

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
    expect(panel.elements[0].content).toContain('**📝 Current activity**\n<raw>Reading the project structure now.</raw>');
    expect(panel.elements[0].content).toContain('**⚙️ Current tool** · <raw>Read');
    expect(panel.elements[0].content).not.toContain('Latest update');
    expect(panel.elements[0].content).toContain('_Elapsed');
    expect(panel.elements[0].content).toContain('Last tool activity');
    expect(panel.elements[0].content).toContain('- <raw>Read started</raw>');
    expect(panel.elements[0].content).not.toContain('• <raw>Read started</raw>');
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
    expect(content).toContain('&lt;b&gt;permission denied&lt;/b&gt;');
    expect(content).toContain('2 earlier events hidden');
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
    const content = panel.elements[0].content;

    expect(content).toContain('📝 Current activity');
    expect(content).toContain('&lt;raw&gt;untrusted&lt;/raw&gt;');
    expect(content).not.toContain('Sensitive internal task prompt');
  });
});

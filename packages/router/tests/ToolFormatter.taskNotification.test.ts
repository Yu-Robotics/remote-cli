import { describe, it, expect } from 'vitest';
import { createTaskNotificationElement } from '../src/utils/ToolFormatter';
import { TaskNotificationInfo } from '../src/types';

/**
 * Tests for createTaskNotificationElement — the standalone Feishu Card 2.0
 * rendered when a Claude Code 2.x background task reaches a terminal state.
 */
describe('ToolFormatter - createTaskNotificationElement', () => {
  const baseInfo: TaskNotificationInfo = {
    taskId: 'b4a2f1c9',
    status: 'completed',
    summary: 'Build finished successfully',
    outputFile: '/tmp/claude-outputs/b4a2f1c9.log',
  };

  const findPanels = (elements: any[]) => elements.filter(e => e.tag === 'collapsible_panel');
  const findMarkdown = (elements: any[]) => elements.filter(e => e.tag === 'markdown');

  it('should render a green completed header with task ID', () => {
    const elements = createTaskNotificationElement(baseInfo);
    const panels = findPanels(elements);

    expect(panels).toHaveLength(1);
    const header = panels[0].header.title.content;
    expect(header).toContain("color='green'");
    expect(header).toContain('✅ TASK COMPLETED');
    expect(header).toContain('b4a2f1c9');
  });

  it('should render a red failed header', () => {
    const elements = createTaskNotificationElement({ ...baseInfo, status: 'failed' });
    const header = findPanels(elements)[0].header.title.content;

    expect(header).toContain("color='red'");
    expect(header).toContain('❌ TASK FAILED');
  });

  it('should render an orange stopped header', () => {
    const elements = createTaskNotificationElement({ ...baseInfo, status: 'stopped' });
    const header = findPanels(elements)[0].header.title.content;

    expect(header).toContain("color='orange'");
    expect(header).toContain('⏹️ TASK STOPPED');
  });

  it('should include summary and output file inside the panel', () => {
    const elements = createTaskNotificationElement(baseInfo);
    const panel = findPanels(elements)[0];
    const panelText = JSON.stringify(panel.elements);

    expect(panelText).toContain('Build finished successfully');
    expect(panelText).toContain('/tmp/claude-outputs/b4a2f1c9.log');
  });

  it('should be expanded by default so the user sees the result immediately', () => {
    const elements = createTaskNotificationElement(baseInfo);
    expect(findPanels(elements)[0].expanded).toBe(true);
  });

  it('should include a hint that replying to the card continues the thread', () => {
    const elements = createTaskNotificationElement(baseInfo);
    const markdownTexts = findMarkdown(elements).map(e => e.content).join('\n');

    expect(markdownTexts).toMatch(/[Rr]eply to this card/);
  });

  it('should truncate very long summaries', () => {
    const longSummary = 'x'.repeat(3000);
    const elements = createTaskNotificationElement({ ...baseInfo, summary: longSummary });
    const panelText = JSON.stringify(findPanels(elements)[0].elements);

    expect(panelText.length).toBeLessThan(2500);
    expect(panelText).toContain('...');
  });

  it('should handle empty summary gracefully', () => {
    const elements = createTaskNotificationElement({ ...baseInfo, summary: '' });
    const panelText = JSON.stringify(findPanels(elements)[0].elements);

    expect(panelText).toContain('no summary');
  });

  it('should include the thread name in the header when provided', () => {
    const elements = createTaskNotificationElement(baseInfo, 'refactor-login');
    const header = findPanels(elements)[0].header.title.content;

    expect(header).toContain('refactor-login');
  });

  it('should omit the thread segment when no thread name is provided', () => {
    const withName = findPanels(createTaskNotificationElement(baseInfo, 'refactor-login'))[0].header.title.content;
    const withoutName = findPanels(createTaskNotificationElement(baseInfo))[0].header.title.content;

    expect(withoutName).not.toContain('refactor-login');
    expect(withName.length).toBeGreaterThan(withoutName.length);
  });

  it('should render a neutral header for unknown future statuses (forward compatibility)', () => {
    const elements = createTaskNotificationElement({ ...baseInfo, status: 'exploded' as any });
    const header = findPanels(elements)[0].header.title.content;

    // Must not mislabel as stopped/failed — a neutral label is used instead
    expect(header).toContain('TASK ENDED');
    expect(header).not.toContain('STOPPED');
    expect(header).not.toContain('FAILED');
    expect(header).not.toContain('COMPLETED');
  });
});

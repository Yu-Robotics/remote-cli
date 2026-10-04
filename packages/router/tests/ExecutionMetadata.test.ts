import { describe, expect, it } from 'vitest';
import { createExecutionMetadataElement, parseExecutionMetadata } from '../src/utils/ExecutionMetadata';

const metadata = { backend: 'codex', model: 'model-a', modelSource: 'reported', reasoningEffort: 'high', effortSource: 'reported' };

describe('execution metadata wire validation and display', () => {
  it('ignores missing, malformed and unsupported optional metadata', () => {
    for (const value of [undefined, null, 'model-a', [], {}, { ...metadata, backend: 'invalid' }, { ...metadata, modelSource: 'invalid' }, { ...metadata, effortSource: 'invalid' }]) {
      expect(parseExecutionMetadata(value)).toBeUndefined();
      expect(createExecutionMetadataElement(value)).toBeUndefined();
    }
  });

  it('renders a compact gray native-card element and preserves provenance', () => {
    const element = createExecutionMetadataElement(metadata)!;
    expect(element).toMatchObject({ tag: 'markdown', text_size: 'notation' });
    expect(element.content).toContain("<font color='grey'>");
    expect(element.content).toContain('Model: model-a · Effort: high');
    expect(createExecutionMetadataElement({ ...metadata, modelSource: 'configured' })!.content).toContain('model-a (configured)');
    expect(createExecutionMetadataElement({ ...metadata, effortSource: 'configured' })!.content).toContain('high (configured)');
  });

  it('shows defaults and unknowns honestly, including missing reported values', () => {
    const data = parseExecutionMetadata({ ...metadata, model: 123, reasoningEffort: '' })!;
    expect(data).toMatchObject({ modelSource: 'unknown', effortSource: 'unknown' });
    expect(createExecutionMetadataElement(data)!.content).toContain('Model: unknown · Effort: unknown');
    expect(createExecutionMetadataElement({ ...metadata, modelSource: 'default', effortSource: 'default' })!.content)
      .toContain('Model: backend default · Effort: backend default');
  });

  it('bounds identifiers, removes controls and drops unrelated wire fields', () => {
    const data = parseExecutionMetadata({ ...metadata, model: `m\n${'x'.repeat(200)}`, reasoningEffort: 'h'.repeat(100), extra: 'discarded' })!;
    expect(data.model).toHaveLength(128);
    expect(data.reasoningEffort).toHaveLength(64);
    expect(data.model).not.toContain('\n');
    expect(data).not.toHaveProperty('extra');
  });

  it('escapes markup, mentions and Markdown links rather than trusting model identifiers', () => {
    const content = createExecutionMetadataElement({ ...metadata, model: '<at id="all">&</at> ![image](https://example.com) `x_*|~`' })!.content;
    expect(content).not.toContain('<at');
    expect(content).toContain('&lt;at');
    expect(content).toContain('&amp;');
    expect(content).toContain('\\[image\\]\\(');
    expect(content).toContain('\\`x\\_\\*\\|\\~\\`');
  });
});

import type { ExecutionMetadata, ExecutionMetadataSource } from '../types';

const BACKENDS = new Set(['claude', 'codex', 'agy', 'pi', 'opencode', 'kimi', 'zcode', 'dsh']);
const SOURCES = new Set<ExecutionMetadataSource>(['reported', 'configured', 'default', 'unknown']);

/** Copy only bounded display fields from an untrusted optional wire payload. */
export function parseExecutionMetadata(value: unknown): ExecutionMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (typeof data.backend !== 'string' || !BACKENDS.has(data.backend)
    || !SOURCES.has(data.modelSource as ExecutionMetadataSource)
    || !SOURCES.has(data.effortSource as ExecutionMetadataSource)) return undefined;
  const setting = (raw: unknown, source: ExecutionMetadataSource, limit: number) => {
    if (source === 'unknown' || source === 'default') return { source };
    const text = typeof raw === 'string' ? raw.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : '';
    return text ? { value: text, source } : { source: 'unknown' as const };
  };
  const model = setting(data.model, data.modelSource as ExecutionMetadataSource, 128);
  const effort = setting(data.reasoningEffort, data.effortSource as ExecutionMetadataSource, 64);
  return { backend: data.backend, model: model.value, modelSource: model.source,
    reasoningEffort: effort.value, effortSource: effort.source };
}

function escapeLabel(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#!|~]/g, '\\$&');
}

export function createExecutionMetadataElement(value: unknown): { tag: string; content: string; text_size: string } | undefined {
  const data = parseExecutionMetadata(value);
  if (!data) return undefined;
  const label = (text: string | undefined, source: ExecutionMetadataSource) =>
    source === 'default' ? 'backend default' : source === 'unknown' ? 'unknown'
      : `${escapeLabel(text!)}${source === 'configured' ? ' (configured)' : ''}`;
  return { tag: 'markdown', text_size: 'notation',
    content: `<font color='grey'>Model: ${label(data.model, data.modelSource)} · Effort: ${label(data.reasoningEffort, data.effortSource)}</font>` };
}

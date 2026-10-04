import type { ExecutionMetadata, ExecutionMetadataSource } from '../types';
import type { ExecutorExecutionMetadata, IExecutor } from './IExecutor';

export function configuredExecutionMetadata(model?: string, reasoningEffort?: string): ExecutorExecutionMetadata {
  return {
    model,
    modelSource: model ? 'configured' : 'default',
    reasoningEffort: reasoningEffort === 'auto' ? undefined : reasoningEffort,
    effortSource: reasoningEffort && reasoningEffort !== 'auto' ? 'configured' : 'default',
  };
}

function setting(value: unknown, source: ExecutionMetadataSource, limit: number): { value?: string; source: ExecutionMetadataSource } {
  if (source === 'default' || source === 'unknown') return { source };
  if (source !== 'reported' && source !== 'configured') return { source: 'unknown' };
  const text = typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : '';
  return text ? { value: text, source } : { source: 'unknown' };
}

/** Copy a bounded snapshot; metadata errors must never fail an execution. */
export function captureExecutionMetadata(executor: IExecutor, backend: string): ExecutionMetadata | undefined {
  try {
    return boundExecutionMetadata(executor.getExecutionMetadata?.(), backend);
  } catch {
    return undefined;
  }
}

export function boundExecutionMetadata(value: unknown, backend: string): ExecutionMetadata | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const data = value as ExecutorExecutionMetadata;
    const model = setting(data.model, data.modelSource, 128);
    const effort = setting(data.reasoningEffort, data.effortSource, 64);
    return { backend, model: model.value, modelSource: model.source,
      reasoningEffort: effort.value, effortSource: effort.source };
  } catch {
    return undefined;
  }
}

/** Keep launch preferences stable if a next-turn setting changes while a task runs. */
export function mergeReportedExecutionMetadata(
  launch: ExecutionMetadata | undefined, final: ExecutionMetadata | undefined,
): ExecutionMetadata | undefined {
  if (!launch) return final;
  if (!final || launch.backend !== final.backend) return launch;
  return { ...launch,
    ...(final.modelSource === 'reported' ? { model: final.model, modelSource: final.modelSource } : {}),
    ...(final.effortSource === 'reported' ? { reasoningEffort: final.reasoningEffort, effortSource: final.effortSource } : {}),
  };
}

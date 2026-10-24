import type { ExecutorModelInfo } from '../IExecutor';
import { KimiMetadataError, kimiHomeKey, withKimiLocalServer, type KimiLocalServerDependencies } from './KimiLocalServer';

const pending = new Map<string, Promise<ExecutorModelInfo[]>>();
// Validation metadata only: temporary settings executors and live ACP threads
// share newly discovered aliases. Explicit listings never read this cache.
const validationCatalogs = new Map<string, ExecutorModelInfo[]>();
const copyModels = (models: ExecutorModelInfo[]) => models.map(model => ({ ...model,
  supportedReasoningEfforts: model.supportedReasoningEfforts ? [...model.supportedReasoningEfforts] : undefined }));

export function latestKimiModelCatalog(command: string): ExecutorModelInfo[] | undefined {
  const models = validationCatalogs.get(kimiHomeKey(command));
  return models ? copyModels(models) : undefined;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const invalid = () => new KimiMetadataError('Kimi returned an invalid model catalog response. Upgrade Kimi Code or retry.');

function envelope(value: unknown): Record<string, unknown> {
  if (!record(value) || value.code !== 0 || !record(value.data)) throw invalid();
  return value.data;
}

function validateRefresh(value: unknown): void {
  const data = envelope(value);
  for (const field of ['changed', 'unchanged', 'failed']) {
    if (!Array.isArray(data[field]) || data[field].length > 512) throw invalid();
  }
  if ((data.failed as unknown[]).length) {
    throw new KimiMetadataError('Kimi could not refresh the managed model catalog. Check native account access and network connectivity, then retry.');
  }
  for (const entry of data.changed as unknown[]) {
    if (!record(entry) || !label(entry.provider_id) || !label(entry.provider_name)
      || !Number.isSafeInteger(entry.added) || Number(entry.added) < 0
      || !Number.isSafeInteger(entry.removed) || Number(entry.removed) < 0) throw invalid();
  }
  if (!(data.unchanged as unknown[]).every(label)) throw invalid();
  // An empty successful report means there are no OAuth-backed providers.
  // Preserve native model listing for API-key and other configured providers.
}

function models(value: unknown): ExecutorModelInfo[] {
  const data = envelope(value);
  if (!Array.isArray(data.items) || !data.items.length || data.items.length > 512) throw invalid();
  const seen = new Set<string>();
  return data.items.map(item => {
    if (!record(item) || !label(item.model) || (item.display_name !== undefined && !label(item.display_name))
      || seen.has(item.model)) throw invalid();
    seen.add(item.model);
    const efforts = item.support_efforts;
    if (efforts !== undefined && (!Array.isArray(efforts) || efforts.length > 32 || !efforts.every(label))) throw invalid();
    if (item.default_effort !== undefined && !label(item.default_effort)) throw invalid();
    return { id: item.model, displayName: (item.display_name as string | undefined) ?? item.model,
      supportedReasoningEfforts: efforts as string[] | undefined, defaultReasoningEffort: item.default_effort as string | undefined };
  });
}

/** Coalesce only concurrent queries; every later explicit refresh contacts Kimi anew. */
export function refreshKimiModelCatalog(command: string, cwd: string,
  dependencies: KimiLocalServerDependencies = {}): Promise<ExecutorModelInfo[]> {
  const key = kimiHomeKey(command);
  const existing = pending.get(key);
  if (existing) return existing.then(copyModels);
  const operation = withKimiLocalServer(command, cwd, async request => {
    validateRefresh(await request('refreshOAuth'));
    return models(await request('models'));
  }, dependencies).then(result => {
    validationCatalogs.delete(key);
    validationCatalogs.set(key, copyModels(result));
    if (validationCatalogs.size > 64) validationCatalogs.delete(validationCatalogs.keys().next().value!);
    return result;
  });
  pending.set(key, operation);
  const clear = () => { if (pending.get(key) === operation) pending.delete(key); };
  void operation.then(clear, clear);
  return operation;
}

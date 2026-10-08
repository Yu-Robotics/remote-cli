import type { ExecutorModelInfo, ExecutorEffortInfo } from '../IExecutor';

/**
 * Native ModelInfo entry structure from Claude Control initialize response.
 * Verified against Claude 2.1.267 and @anthropic-ai/claude-agent-sdk.
 */
export interface ClaudeControlModelEntry {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsAutoMode?: boolean;
}

/** Maximum number of models accepted from a single catalog response. */
const MAX_CATALOG_MODELS = 512;
const MAX_STRING_LENGTH = 512;

function sanitizeString(val: unknown, maxLength = MAX_STRING_LENGTH): string {
  if (typeof val !== 'string') return '';
  return Array.from(val.replace(/[\x00-\x1f\x7f]/g, ' ')).slice(0, maxLength).join('');
}

function nativeValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_LENGTH
    && !/[\x00-\x1f\x7f]/.test(value);
}

/**
 * Validates and parses the raw models array from control_response initialize.
 * Bounds strings, filters malformed entries, ignores account data.
 */
export function parseClaudeModelsCatalog(
  rawModels: unknown,
  currentModel?: string,
): { models: ExecutorModelInfo[]; rawEntries: ClaudeControlModelEntry[] } {
  if (!Array.isArray(rawModels)) {
    throw new Error('Claude initialization response does not contain a models array');
  }
  if (rawModels.length > MAX_CATALOG_MODELS) throw new Error('Claude model catalog exceeds the supported choice limit');

  const entries: ClaudeControlModelEntry[] = [];
  const modelInfos: ExecutorModelInfo[] = [];
  const seen = new Set<string>();

  for (const raw of rawModels) {
    if (entries.length >= MAX_CATALOG_MODELS) break;
    if (!raw || typeof raw !== 'object') continue;

    const entry = raw as Record<string, unknown>;
    if (!nativeValue(entry.value) || seen.has(entry.value)) continue;
    const value = entry.value;
    seen.add(value);

    const resolvedModel = nativeValue(entry.resolvedModel) ? entry.resolvedModel : undefined;
    const displayName = sanitizeString(entry.displayName, 128) || value;
    const description = sanitizeString(entry.description, 1024) || undefined;
    const supportsEffort = entry.supportsEffort === true;

    let supportedEffortLevels: string[] | undefined;
    if (supportsEffort && Array.isArray(entry.supportedEffortLevels) && entry.supportedEffortLevels.length <= MAX_CATALOG_MODELS) {
      supportedEffortLevels = [...new Set(entry.supportedEffortLevels.filter(nativeValue))];
      if (supportedEffortLevels.length === 0) {
        supportedEffortLevels = undefined;
      }
    }

    const supportsAdaptiveThinking = entry.supportsAdaptiveThinking === true;
    const supportsAutoMode = entry.supportsAutoMode === true;

    const catalogEntry: ClaudeControlModelEntry = {
      value,
      resolvedModel,
      displayName,
      description,
      supportsEffort,
      supportedEffortLevels,
      supportsAdaptiveThinking,
      supportsAutoMode,
    };
    entries.push(catalogEntry);

    modelInfos.push({
      id: value,
      displayName,
      description,
      isDefault: undefined, // Do not infer default
      isCurrent: undefined,
      supportedReasoningEfforts: supportedEffortLevels ? [...supportedEffortLevels] : undefined,
      inputModalities: ['text', 'image'],
    });
  }

  const current = entries.find(entry => entry.value === currentModel)
    ?? entries.find(entry => currentModel !== undefined && entry.resolvedModel === currentModel);
  for (const model of modelInfos) model.isCurrent = current && model.id === current.value ? true : undefined;

  return { models: modelInfos, rawEntries: entries };
}

/**
 * Resolves reasoning effort information for an active model from parsed catalog entries.
 */
export function resolveClaudeEfforts(
  entries: ClaudeControlModelEntry[],
  activeModel?: string,
  configuredEffort?: string,
): ExecutorEffortInfo {
  let targetEntry: ClaudeControlModelEntry | undefined;
  if (activeModel) {
    targetEntry = entries.find(
      e => e.value === activeModel || (e.resolvedModel !== undefined && e.resolvedModel === activeModel),
    );
  } else {
    targetEntry = entries.find(e => e.value === 'default');
  }

  if (!targetEntry) {
    return {
      choices: [],
      current: configuredEffort,
      default: undefined,
      supportsReset: true,
      unavailableReason: activeModel
        ? `Model "${activeModel}" not found in Claude model catalog.`
        : 'No model selected and no default model found in Claude model catalog.',
    };
  }

  if (!targetEntry.supportsEffort || !targetEntry.supportedEffortLevels?.length) {
    return {
      choices: [],
      current: configuredEffort,
      default: undefined,
      supportsReset: true,
      unavailableReason: `Reasoning effort is not supported for ${targetEntry.displayName || targetEntry.value}.`,
    };
  }

  return {
    choices: targetEntry.supportedEffortLevels.map(lvl => ({
      value: lvl,
      displayName: lvl,
    })),
    current: configuredEffort,
    default: undefined,
    supportsReset: true,
  };
}

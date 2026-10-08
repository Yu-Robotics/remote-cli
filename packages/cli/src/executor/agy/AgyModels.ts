import type { ExecutorModelInfo } from '../IExecutor';
import { stripAnsi } from '../../utils/stripAnsi';

/** Maximum number of models accepted from `agy models` output. */
export const MAX_CATALOG_MODELS = 128;
export const MAX_STRING_LENGTH = 512;
export const MAX_DISPLAY_NAME_LENGTH = 128;

export const SUPPORTED_EFFORTS = ['low', 'medium', 'high'] as const;

/**
 * Native IDs are opaque: preserve punctuation and case, rejecting whitespace and control characters.
 * Typical slugs: gemini-3.8-flash-high, claude-sonnet-4-6, gpt-oss-120b-medium
 */
export function isValidModelSlug(value: string): boolean {
  if (!value || value.length > MAX_STRING_LENGTH) return false;
  return !/[\s\x00-\x1f\x7f-\x9f]/u.test(value);
}

export function sanitizeDisplayName(value: string): string {
  if (!value) return '';
  return Array.from(value.replace(/[\x00-\x1f\x7f]/g, ' '))
    .slice(0, MAX_DISPLAY_NAME_LENGTH)
    .join('')
    .trim();
}

/**
 * Known progress / status text emitted by AGY CLI (e.g. "Fetching available models...").
 */
export function isProgressOrHeaderLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.startsWith('fetching available models')) return true;
  if (normalized.startsWith('loading models')) return true;
  if (/^(?:model(?:\s+id)?|slug|id)\s+display\s+name$/.test(normalized)) return true;
  if (/^(?:note|warning|error):(?:\s|$)/.test(normalized)) return true;
  return false;
}

/**
 * Deterministic bounded parser for `agy models` output.
 *
 * Supports:
 * - Two-column tab-delimited format: `<slug>\t<Display Name>`
 * - Two-column multi-space delimited format (e.g. from formatted tables): `<slug>   <Display Name>`
 * - Strips ANSI escapes and carriage returns
 * - Ignores progress spinners / notices (e.g. "Fetching available models...")
 * - Validates model slugs (opaque native IDs preserved exactly)
 * - Sanitizes display names (length bounded, control chars removed)
 * - Deduplicates by slug
 * - Rejects excess entries instead of silently hiding models
 * - Marks `isCurrent` using exact native ID equality
 */
export function parseAgyModels(stdout: string, currentModel?: string): ExecutorModelInfo[] {
  if (typeof stdout !== 'string') return [];

  // Strip ANSI and normalize line endings
  const clean = stripAnsi(stdout);
  // Split on \r?\n or standalone \r (which spinners use for progress overwrites)
  const lines = clean.split(/\r?\n|\r/);
  const seen = new Set<string>();
  const models: ExecutorModelInfo[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || isProgressOrHeaderLine(trimmed)) {
      continue;
    }

    let slug: string | undefined;
    let displayName: string | undefined;

    // Check for tab delimiter first
    const tabIndex = rawLine.indexOf('\t');
    if (tabIndex !== -1) {
      slug = rawLine.slice(0, tabIndex).trim();
      displayName = rawLine.slice(tabIndex + 1).trim();
    } else {
      // Fallback: 2 or more whitespace characters separating columns
      const multiSpaceMatch = rawLine.trim().match(/^(\S+)\s{2,}(.+)$/);
      if (multiSpaceMatch) {
        slug = multiSpaceMatch[1].trim();
        displayName = multiSpaceMatch[2].trim();
      }
    }

    if (!slug || !isValidModelSlug(slug) || seen.has(slug)) {
      continue;
    }
    if (models.length >= MAX_CATALOG_MODELS) {
      throw new Error('AGY model catalog exceeds the supported entry limit.');
    }

    seen.add(slug);
    const sanitizedName = sanitizeDisplayName(displayName || slug) || sanitizeDisplayName(slug);

    const isCurrent = currentModel ? slug === currentModel : undefined;

    models.push({
      id: slug,
      displayName: sanitizedName,
      isDefault: undefined,
      isCurrent,
      supportedReasoningEfforts: [...SUPPORTED_EFFORTS],
      inputModalities: ['text'],
    });
  }

  return models;
}

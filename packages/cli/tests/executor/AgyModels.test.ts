import { describe, it, expect } from 'vitest';
import {
  parseAgyModels,
  isValidModelSlug,
  sanitizeDisplayName,
  isProgressOrHeaderLine,
  MAX_CATALOG_MODELS,
} from '../../src/executor/agy/AgyModels';

describe('AgyModels parser', () => {
  describe('isValidModelSlug', () => {
    it('preserves opaque native model IDs including punctuation', () => {
      expect(isValidModelSlug('gemini-3.8-flash-low')).toBe(true);
      expect(isValidModelSlug('claude-sonnet-4-6')).toBe(true);
      expect(isValidModelSlug('gpt-oss-120b-medium')).toBe(true);
      expect(isValidModelSlug('custom_model.v1')).toBe(true);
      expect(isValidModelSlug('provider/Model:revision')).toBe(true);
    });

    it('rejects slugs with whitespace, control characters, or empty values', () => {
      expect(isValidModelSlug('')).toBe(false);
      expect(isValidModelSlug('slug with spaces')).toBe(false);
      expect(isValidModelSlug('slug\twith\ttab')).toBe(false);
      expect(isValidModelSlug('slug\nnewline')).toBe(false);
      expect(isValidModelSlug('slug\x00null')).toBe(false);
      expect(isValidModelSlug('a'.repeat(513))).toBe(false);
    });
  });

  describe('sanitizeDisplayName', () => {
    it('strips control characters and bounds length', () => {
      expect(sanitizeDisplayName('Gemini 3.8 Flash (Low)')).toBe('Gemini 3.8 Flash (Low)');
      expect(sanitizeDisplayName('Model\x00with\x1fcontrols')).toBe('Model with controls');
      expect(sanitizeDisplayName('   Padded Name   ')).toBe('Padded Name');
      expect(sanitizeDisplayName('a'.repeat(200)).length).toBeLessThanOrEqual(128);
    });
  });

  describe('isProgressOrHeaderLine', () => {
    it('identifies progress spinners and table headers', () => {
      expect(isProgressOrHeaderLine('Fetching available models...')).toBe(true);
      expect(isProgressOrHeaderLine('fetching available models...')).toBe(true);
      expect(isProgressOrHeaderLine('Loading models...')).toBe(true);
      expect(isProgressOrHeaderLine('Model   Display Name')).toBe(true);
      expect(isProgressOrHeaderLine('   ')).toBe(true);
      expect(isProgressOrHeaderLine('')).toBe(true);
      expect(isProgressOrHeaderLine('gemini-3.8-flash-low   Gemini 3.8 Flash (Low)')).toBe(false);
    });
  });

  describe('parseAgyModels', () => {
    it('parses a redacted fourteen-row sample of the observed tab-delimited format', () => {
      const rawOutput = Array.from({ length: 14 }, (_, index) => `model-${index}\tSynthetic Model ${index}\n`).join('');
      const models = parseAgyModels(rawOutput, 'model-2');
      expect(models).toHaveLength(14);
      expect(models[0]).toEqual({
        id: 'model-0',
        displayName: 'Synthetic Model 0',
        isDefault: undefined,
        isCurrent: false,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        inputModalities: ['text'],
      });

      const current = models.find((m) => m.id === 'model-2');
      expect(current).toBeDefined();
      expect(current?.isCurrent).toBe(true);
    });

    it('accepts synthetic two-column samples separated by multiple spaces', () => {
      const formattedOutput =
        'gemini-3.8-flash-high     Gemini 3.8 Flash (High)\r\n' +
        'gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)\r\n' +
        'gemini-3.8-flash-low      Gemini 3.8 Flash (Low)\r\n';

      const models = parseAgyModels(formattedOutput, 'gemini-3.8-flash-high');
      expect(models).toHaveLength(3);
      expect(models[0]).toMatchObject({
        id: 'gemini-3.8-flash-high',
        displayName: 'Gemini 3.8 Flash (High)',
        isCurrent: true,
      });
      expect(models[1]).toMatchObject({
        id: 'gemini-3.8-flash-medium',
        displayName: 'Gemini 3.8 Flash (Medium)',
        isCurrent: false,
      });
      expect(models[2]).toMatchObject({
        id: 'gemini-3.8-flash-low',
        displayName: 'Gemini 3.8 Flash (Low)',
        isCurrent: false,
      });
    });

    it('handles mixed stderr/stdout progress spinners with carriage returns and ANSI codes', () => {
      const noisyOutput =
        '\r\u280b Fetching available models...\r\u2819 Fetching available models...\r\x1b[K' +
        'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n' +
        '\u001b[32mLoading models...\u001b[0m\n' +
        'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n';

      const models = parseAgyModels(noisyOutput);
      expect(models).toHaveLength(2);
      expect(models.map((m) => m.id)).toEqual(['gemini-3.8-flash-high', 'gemini-3.8-flash-low']);
    });

    it('matches currentModel by exact native ID without case folding', () => {
      const output = 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n';
      const models = parseAgyModels(output, 'GEMINI-3.8-FLASH-LOW');
      expect(models[0].isCurrent).toBe(false);
    });

    it('deduplicates duplicate model slugs preserving first entry', () => {
      const output =
        'gemini-3.8-flash-low\tGemini 3.8 Flash Low First\n' +
        'gemini-3.8-flash-low\tGemini 3.8 Flash Low Duplicate\n';

      const models = parseAgyModels(output);
      expect(models).toHaveLength(1);
      expect(models[0].displayName).toBe('Gemini 3.8 Flash Low First');
    });

    it('falls back to slug when displayName is omitted or empty', () => {
      const output = 'gemini-3.8-flash-low\t\n';
      const models = parseAgyModels(output);
      expect(models).toHaveLength(1);
      expect(models[0].displayName).toBe('gemini-3.8-flash-low');
    });

    it('ignores invalid slugs and malformed lines', () => {
      const output =
        'invalid slug with spaces\tSome Display Name\n' +
        'valid-slug\tValid Display Name\n' +
        'another invalid slug!!!@@@###\n';

      const models = parseAgyModels(output);
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('valid-slug');
    });

    it('skips actual column headings and notices without dropping model-prefixed IDs', () => {
      const output = 'Model ID  Display Name\nSlug\tDisplay Name\nNote:  Catalog refreshed\n'
        + 'Warning:  Synthetic notice\nError:  Synthetic notice\n'
        + 'model-custom  Model Display Name\nprovider/Model:v2  Model Two\n';
      expect(parseAgyModels(output).map(model => model.id)).toEqual(['model-custom', 'provider/Model:v2']);
    });

    it('bounds fallback display names while preserving the complete native ID', () => {
      const id = 'x'.repeat(512);
      expect(parseAgyModels(`${id}\t\n`)[0]).toMatchObject({ id, displayName: 'x'.repeat(128) });
    });

    it('rejects excess models without silently truncating the catalog', () => {
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        lines.push(`model-${i}\tModel ${i}`);
      }
      expect(() => parseAgyModels(lines.join('\n'))).toThrow('entry limit');
      expect(parseAgyModels(lines.slice(0, MAX_CATALOG_MODELS).join('\n'))).toHaveLength(MAX_CATALOG_MODELS);
    });

    it('keeps opaque IDs and exact configured selection in formatted catalogs', () => {
      expect(parseAgyModels('provider/Model:revision  Native Model\n', 'provider/Model:revision')[0])
        .toMatchObject({ id: 'provider/Model:revision', isCurrent: true });
    });

    it('returns empty array when input is empty or contains no valid models', () => {
      expect(parseAgyModels('')).toEqual([]);
      expect(parseAgyModels('   \n\n  ')).toEqual([]);
      expect(parseAgyModels('Fetching available models...\nLoading models...\n')).toEqual([]);
    });
  });
});

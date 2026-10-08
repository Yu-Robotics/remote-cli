import { describe, it, expect } from 'vitest';
import { parseClaudeModelsCatalog, resolveClaudeEfforts } from '../../src/executor/claude/ClaudeSettings';

describe('ClaudeSettings', () => {
  describe('parseClaudeModelsCatalog', () => {
    it('throws when rawModels is not an array', () => {
      expect(() => parseClaudeModelsCatalog(null)).toThrow('does not contain a models array');
      expect(() => parseClaudeModelsCatalog({})).toThrow('does not contain a models array');
      expect(() => parseClaudeModelsCatalog('string')).toThrow('does not contain a models array');
    });

    it('parses valid model entries and bounds strings and list sizes', () => {
      const raw = [
        {
          value: 'claude-3-7-sonnet',
          displayName: 'Claude 3.7 Sonnet',
          description: 'Hybrid reasoning model',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
          supportsAdaptiveThinking: true,
        },
        {
          value: 'claude-3-5-haiku',
          displayName: 'Claude 3.5 Haiku',
          description: 'Fast model',
          supportsEffort: false,
        },
        // Malformed entry
        null,
        'invalid',
        { value: '' }, // empty value should be skipped
      ];

      const { models, rawEntries } = parseClaudeModelsCatalog(raw, 'claude-3-7-sonnet');
      expect(models).toHaveLength(2);
      expect(rawEntries).toHaveLength(2);

      expect(models[0]).toEqual({
        id: 'claude-3-7-sonnet',
        displayName: 'Claude 3.7 Sonnet',
        description: 'Hybrid reasoning model',
        isDefault: undefined,
        isCurrent: true,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        inputModalities: ['text', 'image'],
      });

      expect(models[1]).toEqual({
        id: 'claude-3-5-haiku',
        displayName: 'Claude 3.5 Haiku',
        description: 'Fast model',
        isDefault: undefined,
        isCurrent: undefined,
        supportedReasoningEfforts: undefined,
        inputModalities: ['text', 'image'],
      });
    });

    it('preserves all bounded choices and rejects oversized catalogs explicitly', () => {
      const largeList = Array.from({ length: 60 }, (_, i) => ({
        value: `model-${i}`,
        displayName: `Model ${i}`,
      }));

      const { models, rawEntries } = parseClaudeModelsCatalog(largeList);
      expect(models).toHaveLength(60);
      expect(rawEntries).toHaveLength(60);
      expect(models[59].id).toBe('model-59');
      expect(() => parseClaudeModelsCatalog(Array(513).fill({ value: 'model' }))).toThrow('choice limit');
    });

    it('sanitizes display fields but rejects control-containing native identifiers', () => {
      const raw = [
        {
          value: 'claude-test',
          displayName: 'Display\r\nName',
          description: 'Desc\x1fwith\x7fcontrol',
        }, { value: 'claude\x00-test' },
      ];

      const { models, rawEntries } = parseClaudeModelsCatalog(raw);
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('claude-test');
      expect(models[0].displayName).toBe('Display  Name');
      expect(models[0].description).toBe('Desc with control');
      expect(rawEntries[0].value).toBe('claude-test');
    });

    it('ignores sensitive account information if present in payload', () => {
      const raw = [
        {
          value: 'claude-3-5-sonnet',
          account: { email: 'secret@example.com', token: 'secret-token' },
          apiKey: 'sk-ant-api03-secret',
        },
      ];

      const { models, rawEntries } = parseClaudeModelsCatalog(raw);
      expect(models[0]).not.toHaveProperty('account');
      expect(models[0]).not.toHaveProperty('apiKey');
      expect(rawEntries[0]).not.toHaveProperty('account');
      expect(rawEntries[0]).not.toHaveProperty('apiKey');
    });

    it('identifies current values exactly or by an explicit resolved model', () => {
      const raw = [
        {
          value: 'default',
          resolvedModel: 'claude-3-7-sonnet-20250219',
          displayName: 'Default',
        },
      ];

      const res1 = parseClaudeModelsCatalog(raw, 'DEFAULT');
      expect(res1.models[0].isCurrent).toBeUndefined();

      const res2 = parseClaudeModelsCatalog(raw, 'claude-3-7-sonnet-20250219');
      expect(res2.models[0].isCurrent).toBe(true);

      const res3 = parseClaudeModelsCatalog(raw, 'other-model');
      expect(res3.models[0].isCurrent).toBeUndefined();
    });
  });

  describe('resolveClaudeEfforts', () => {
    it('preserves opaque identifiers and effort values without truncation or normalization', () => {
      const value = 'provider/  ' + 'a'.repeat(240);
      const levels = ['native  effort', 'low', 'low', 'invalid\u0000level'];
      const parsed = parseClaudeModelsCatalog([
        { value, displayName: '\ud83d\ude80'.repeat(129), supportsEffort: true, supportedEffortLevels: levels },
        { value }, { value: 'x'.repeat(513) },
      ], value);
      expect(parsed.models).toHaveLength(1);
      expect(parsed.models[0].id).toBe(value);
      expect(Array.from(parsed.models[0].displayName)).toHaveLength(128);
      expect(parsed.models[0].supportedReasoningEfforts).toEqual(['native  effort', 'low']);
      expect(resolveClaudeEfforts(parsed.rawEntries, value).choices.map(choice => choice.value)).toEqual(['native  effort', 'low']);
    });

    const sampleEntries = [
      {
        value: 'default',
        resolvedModel: 'claude-3-7-sonnet',
        displayName: 'Claude 3.7 Sonnet (default)',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
      },
      {
        value: 'claude-3-5-haiku',
        displayName: 'Claude 3.5 Haiku',
        supportsEffort: false,
      },
    ];

    it('returns available effort choices for model supporting effort', () => {
      const efforts = resolveClaudeEfforts(sampleEntries, 'default', 'high');
      expect(efforts).toEqual({
        choices: [
          { value: 'low', displayName: 'low' },
          { value: 'medium', displayName: 'medium' },
          { value: 'high', displayName: 'high' },
        ],
        current: 'high',
        default: undefined,
        supportsReset: true,
      });
    });

    it('matches active model by resolvedModel alias', () => {
      const efforts = resolveClaudeEfforts(sampleEntries, 'claude-3-7-sonnet', 'low');
      expect(efforts.choices).toHaveLength(3);
      expect(efforts.current).toBe('low');
      expect(efforts.unavailableReason).toBeUndefined();
    });

    it('returns honest unavailableReason when active model does not support effort', () => {
      const efforts = resolveClaudeEfforts(sampleEntries, 'claude-3-5-haiku');
      expect(efforts).toEqual({
        choices: [],
        current: undefined,
        default: undefined,
        supportsReset: true,
        unavailableReason: 'Reasoning effort is not supported for Claude 3.5 Haiku.',
      });
    });

    it('returns honest unavailableReason when requested model is not in catalog', () => {
      const efforts = resolveClaudeEfforts(sampleEntries, 'non-existent-model');
      expect(efforts).toEqual({
        choices: [],
        current: undefined,
        default: undefined,
        supportsReset: true,
        unavailableReason: 'Model "non-existent-model" not found in Claude model catalog.',
      });
    });

    it('falls back to default entry when activeModel is undefined', () => {
      const efforts = resolveClaudeEfforts(sampleEntries, undefined, 'medium');
      expect(efforts.choices).toHaveLength(3);
      expect(efforts.current).toBe('medium');
    });

    it('returns honest unavailableReason when activeModel is undefined and default entry is missing', () => {
      const efforts = resolveClaudeEfforts([sampleEntries[1]], undefined);
      expect(efforts.choices).toHaveLength(0);
      expect(efforts.unavailableReason).toBe('No model selected and no default model found in Claude model catalog.');
    });
  });
});

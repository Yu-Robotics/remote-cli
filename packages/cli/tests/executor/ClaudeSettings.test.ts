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

    it('distinguishes same-name aliases and direct models without changing native metadata or order', () => {
      const resolvedModel = 'synthetic-provider/model-pro';
      const raw = [
        { value: 'default', resolvedModel, displayName: 'Default (recommended)' },
        { value: 'opus', resolvedModel, displayName: 'Friendly model', description: 'Native description',
          supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsAdaptiveThinking: true, supportsAutoMode: true },
        { value: 'fable', resolvedModel, displayName: 'Friendly model' },
        { value: resolvedModel, resolvedModel, displayName: 'Friendly model' },
      ];
      const original = structuredClone(raw);
      const { models, rawEntries } = parseClaudeModelsCatalog(raw, 'opus');
      expect(models.map(model => model.id)).toEqual(raw.map(entry => entry.value));
      expect(models.map(model => model.displayName)).toEqual([
        'Default (recommended)', `Opus · ${resolvedModel}`, `Fable · ${resolvedModel}`, 'Friendly model',
      ]);
      expect(models.map(model => model.isCurrent)).toEqual([undefined, true, undefined, undefined]);
      expect(parseClaudeModelsCatalog(raw, resolvedModel).models.map(model => model.isCurrent))
        .toEqual([undefined, undefined, undefined, true]);
      expect(rawEntries.map(entry => entry.displayName)).toEqual(raw.map(entry => entry.displayName));
      expect(rawEntries[1]).toEqual(raw[1]);
      expect(raw).toEqual(original);
      expect(resolveClaudeEfforts(rawEntries, 'opus', 'high').choices.map(choice => choice.value)).toEqual(['low', 'high']);
      expect(resolveClaudeEfforts(rawEntries, 'fable').unavailableReason).toBe('Reasoning effort is not supported for Friendly model.');
      expect(parseClaudeModelsCatalog(rawEntries, 'opus').models).toEqual(models);
    });

    it.each([
      ['opus', 'Opus'], ['fable', 'Fable'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'],
      ['opus[1m]', 'Opus[1m]'], ['fable[1m]', 'Fable[1m]'],
      ['sonnet[1m]', 'Sonnet[1m]'], ['haiku[1m]', 'Haiku[1m]'],
    ])('prefers the exact resolved model over a friendly name for %s', (value, label) => {
      const resolvedModel = 'Synthetic Provider/full-model[1m]';
      const { models, rawEntries } = parseClaudeModelsCatalog([
        { value, resolvedModel, displayName: 'A different friendly name' },
      ], resolvedModel);
      expect(models[0]).toMatchObject({ id: value, displayName: `${label} · ${resolvedModel}`, isCurrent: true });
      expect(rawEntries[0]).toMatchObject({ value, resolvedModel, displayName: 'A different friendly name' });
    });

    it.each([undefined, null, 42, '', 'invalid\nmodel', 'x'.repeat(513)])(
      'uses a sanitized native name when the resolved model is invalid (%j)', resolvedModel => {
        const { models, rawEntries } = parseClaudeModelsCatalog([
          { value: 'sonnet', resolvedModel, displayName: 'Friendly\nmodel' },
        ]);
        expect(models[0].displayName).toBe('Sonnet · Friendly model');
        expect(rawEntries[0]).toMatchObject({ value: 'sonnet', displayName: 'Friendly model' });
        expect(rawEntries[0].resolvedModel).toBeUndefined();
      },
    );

    it.each([undefined, null, 42, ''])('keeps an alias marker when no usable native name is supplied (%j)', displayName => {
      const { models, rawEntries } = parseClaudeModelsCatalog([{ value: 'haiku', displayName }]);
      expect(models[0].displayName).toBe('Haiku · haiku');
      expect(rawEntries[0].displayName).toBe('haiku');
    });

    it('bounds annotated labels by code points while preserving the native resolved identifier', () => {
      const resolvedModel = 'synthetic-provider/' + '\ud83d\ude80'.repeat(180);
      const nativeName = 'Friendly\n' + 'x'.repeat(150);
      const { models, rawEntries } = parseClaudeModelsCatalog([
        { value: 'opus', resolvedModel, displayName: 'Friendly model' },
        { value: 'sonnet', displayName: nativeName },
      ]);
      expect(models[0].displayName).toBe(Array.from(`Opus · ${resolvedModel}`).slice(0, 128).join(''));
      expect(Array.from(models[0].displayName)).toHaveLength(128);
      expect(rawEntries[0].resolvedModel).toBe(resolvedModel);
      expect(rawEntries[0].displayName).toBe('Friendly model');
      expect(models[1].displayName).toBe(('Sonnet · Friendly ' + 'x'.repeat(150)).slice(0, 128));
      expect(rawEntries[1].displayName).toBe(('Friendly ' + 'x'.repeat(150)).slice(0, 128));
    });

    it('leaves default, direct identifiers and names outside the explicit alias set unchanged', () => {
      const values = ['default', 'synthetic-provider/opus', 'claude-sonnet-5', 'best', 'opusplan',
        'Opus', 'sonnet[2m]', 'custom-alias', 'constructor'];
      const { models } = parseClaudeModelsCatalog(values.map(value => ({
        value, resolvedModel: 'synthetic-provider/model', displayName: 'Native\nlabel',
      })));
      expect(models.map(model => model.id)).toEqual(values);
      expect(models.map(model => model.displayName)).toEqual(values.map(() => 'Native label'));
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

import { describe, expect, it, vi } from 'vitest';
import { applyAgySessionSettings } from '../../src/executor/agy/AgySessionSettings';

const state = (model = 'synthetic-model', thought = 'low') => ({ configOptions: [
  { id: 'model', category: 'model', type: 'select', currentValue: model },
  { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: thought },
] });

describe('AGY initial session settings confirmation', () => {
  it('leaves unspecified native defaults untouched', async () => {
    const configure = vi.fn(); await applyAgySessionSettings({}, configure, {});
    expect(configure).not.toHaveBeenCalled();
  });
  it('confirms a model alias before applying an explicit thought-level override', async () => {
    const configure = vi.fn().mockResolvedValueOnce(state('synthetic-model', 'high')).mockResolvedValueOnce(state('synthetic-model', 'low'));
    await applyAgySessionSettings(state(), configure, { model: 'synthetic-model-high', effort: 'low' });
    expect(configure.mock.calls).toEqual([['model', 'synthetic-model-high'], ['thought_level', 'low']]);
  });
  it.each(['low', 'medium', 'high'])('accepts exact canonical model/thought aliases for %s', async thought => {
    const configure = vi.fn().mockResolvedValue(state('synthetic-model', thought));
    await applyAgySessionSettings(state(), configure, { model: `synthetic-model-${thought}` });
    expect(configure).toHaveBeenCalledOnce();
  });
  it.each(['other-model-high', 'synthetic-model-auto', 'synthetic-model-high-extra'])('rejects noncorresponding aliases (%s)', async model => {
    await expect(applyAgySessionSettings(state(), vi.fn().mockResolvedValue(state('synthetic-model', 'high')), { model })).rejects.toThrow('model selection could not be confirmed');
  });
  it('does not invent an effort configuration ID', async () => {
    const configure = vi.fn();
    await expect(applyAgySessionSettings({ configOptions: state().configOptions.slice(0, 1) }, configure, { effort: 'high' })).rejects.toThrow('thought_level selection');
    expect(configure).not.toHaveBeenCalled();
  });
  it('changes only thought level when effort is the only explicit setting', async () => {
    const configure = vi.fn().mockResolvedValue(state('synthetic-default', 'high'));
    await applyAgySessionSettings(state('synthetic-default'), configure, { effort: 'high' });
    expect(configure.mock.calls).toEqual([['thought_level', 'high']]);
    await expect(applyAgySessionSettings(state('synthetic-default'),
      vi.fn().mockResolvedValue(state('unexpected-model', 'high')), { effort: 'high' })).rejects.toThrow('thought_level selection');
  });
  it('rejects ambiguous advertised options before any control is sent', async () => {
    const session = state(); session.configOptions.push({ ...session.configOptions[0], id: 'other-model' });
    const configure = vi.fn();
    await expect(applyAgySessionSettings(session, configure, { model: 'synthetic-model' })).rejects.toThrow('model selection');
    expect(configure).not.toHaveBeenCalled();
  });
  it.each([{}, { configOptions: [] }, state('different'), { configOptions: [{ id: 'model', type: 'select' }] }])('rejects missing or mismatched model confirmations', async reply => {
    await expect(applyAgySessionSettings(state(), vi.fn().mockResolvedValue(reply), { model: 'synthetic-model' })).rejects.toThrow('model selection');
  });
  it('rejects a thought-level response that changes the confirmed model', async () => {
    const configure = vi.fn().mockResolvedValueOnce(state()).mockResolvedValueOnce(state('other', 'high'));
    await expect(applyAgySessionSettings(state(), configure, { model: 'synthetic-model', effort: 'high' })).rejects.toThrow('thought_level selection');
  });
  it('rejects mismatched thought levels and hides raw native error material', async () => {
    await expect(applyAgySessionSettings(state(), vi.fn().mockResolvedValue(state()), { effort: 'high' })).rejects.toThrow('thought_level selection');
    const configure = vi.fn().mockRejectedValue(new Error('Synthetic private native material'));
    const error = await applyAgySessionSettings(state(), configure, { model: 'synthetic-model' }).catch(error => error);
    expect(error.message).not.toContain('private'); expect(error.cause).toBeUndefined();
  });
  it('confirms an advertised mode and rejects missing or mismatched acknowledgements', async () => {
    const mode = (value: string) => ({ configOptions: [...state().configOptions,
      { id: 'mode', category: 'mode', type: 'select', currentValue: value }] });
    const configure = vi.fn().mockResolvedValue(mode('plan'));
    await applyAgySessionSettings(mode('default'), configure, { mode: 'plan' });
    expect(configure).toHaveBeenCalledWith('mode', 'plan');
    await expect(applyAgySessionSettings(mode('default'), vi.fn().mockResolvedValue(mode('default')), { mode: 'plan' })).rejects.toThrow('mode selection');
    await expect(applyAgySessionSettings(state(), configure, { mode: 'plan' })).rejects.toThrow('mode selection');
  });

});

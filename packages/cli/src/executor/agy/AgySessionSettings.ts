import type { AcpConfigOption, AcpSessionResult } from '../acp/AcpTypes';
import type { AcpSessionSetup } from '../acp/AcpClient';

export class AgySessionSettingsError extends Error {
  constructor(readonly stage: 'model' | 'thought_level' | 'mode') {
    super(`AGY ACP ${stage} selection could not be confirmed. No prompt was sent.`);
    this.name = 'AgySessionSettingsError';
  }
}

function selection(session: AcpSessionResult, category: 'model' | 'thought_level' | 'mode'): AcpConfigOption | undefined {
  if (!Array.isArray(session?.configOptions)) return;
  const matches = session.configOptions.filter(option => option && (option.category === category || option.id === category));
  if (matches.length !== 1) return;
  const option = matches[0];
  return option.type === 'select' && typeof option.id === 'string' && option.id.length > 0
    && typeof option.currentValue === 'string' ? option : undefined;
}

/** Confirm native state from control replies, including AGY model/thought-level
 * slug aliases. Never infer success from an RPC acknowledgement alone. */
export async function applyAgySessionSettings(session: AcpSessionResult,
  configure: Parameters<AcpSessionSetup>[1], requested: { model?: string; effort?: string; mode?: string }): Promise<void> {
  let state = session;
  let model = selection(session, 'model')?.currentValue;
  if (requested.model !== undefined) {
    try {
      const option = selection(state, 'model');
      if (!option) throw new AgySessionSettingsError('model');
      state = await configure(option.id, requested.model);
      model = selection(state, 'model')?.currentValue;
      const thought = selection(state, 'thought_level')?.currentValue;
      if (!model || model !== requested.model && !(thought && ['low', 'medium', 'high'].includes(thought)
        && requested.model === `${model}-${thought}`)) throw new AgySessionSettingsError('model');
    } catch { throw new AgySessionSettingsError('model'); }
  }
  if (requested.effort !== undefined) {
    try {
      const option = selection(state, 'thought_level');
      if (!option || !['low', 'medium', 'high'].includes(requested.effort)) throw new AgySessionSettingsError('thought_level');
      state = await configure(option.id, requested.effort);
      if (selection(state, 'thought_level')?.currentValue !== requested.effort
        || model !== undefined && selection(state, 'model')?.currentValue !== model) throw new AgySessionSettingsError('thought_level');
    } catch { throw new AgySessionSettingsError('thought_level'); }
  }
  if (requested.mode !== undefined) {
    try {
      const option = selection(state, 'mode');
      if (!option) throw new AgySessionSettingsError('mode');
      state = await configure(option.id, requested.mode);
      if (selection(state, 'mode')?.currentValue !== requested.mode) throw new AgySessionSettingsError('mode');
    } catch { throw new AgySessionSettingsError('mode'); }
  }

}

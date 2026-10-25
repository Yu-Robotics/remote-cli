import path from 'path';
import catalog from './catalog.zh-CN.json';
import type { TipDefinition } from './TipTypes';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FIELDS = { id: 64, topic: 32, title: 40, problem: 100, benefit: 100,
  action: 180, example: 240, detail: 240, image: 68 } as const;

function imageName(tip: Pick<TipDefinition, 'id' | 'image'>): string {
  if (!ID.test(tip.id) || tip.id.length > FIELDS.id || tip.image !== `${tip.id}.png`) {
    throw new Error('Invalid tip image reference');
  }
  return tip.image;
}

const ids = new Set<string>();
if (!Array.isArray(catalog) || catalog.length !== 27) throw new Error('The tip catalog must contain 27 entries');

/** Only reviewed contract fields leave the resource; illustration data is build-time input. */
export const TIPS: readonly TipDefinition[] = Object.freeze(catalog.map(entry => {
  const tip = {} as TipDefinition;
  for (const key of Object.keys(FIELDS) as (keyof TipDefinition)[]) {
    const value = entry[key];
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()
      || [...value].length > FIELDS[key] || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) {
      throw new Error(`Invalid tip catalog field: ${key}`);
    }
    tip[key] = value;
  }
  if (!ID.test(tip.id) || !ID.test(tip.topic) || ids.has(tip.id)) throw new Error('Invalid or duplicate tip ID/topic');
  imageName(tip);
  ids.add(tip.id);
  return Object.freeze(tip);
}));

/** Works from both src/tips and the packaged dist/tips directory. */
export function tipImagePath(tip: Pick<TipDefinition, 'id' | 'image'>): string {
  return path.join(__dirname, 'assets', imageName(tip));
}

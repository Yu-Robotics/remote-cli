import fs from 'fs/promises';
import { tipImagePath } from './TipCatalog';
import type { TipDefinition } from './TipTypes';

export const TIP_IMAGE_TIMEOUT = 10_000;

/** Cache successful uploads only. A failed upload can be retried by a later request. */
export class TipImages {
  private readonly uploads = new Map<string, Promise<string | null>>();

  constructor(private readonly upload: (data: string, mimeType: string) => Promise<string | null>) {}

  get(tip: TipDefinition): Promise<string | null> {
    const pending = this.uploads.get(tip.id);
    if (pending) return pending;
    const attempt = this.boundedLoad(tip);
    this.uploads.set(tip.id, attempt);
    void attempt.then(key => { if (!key && this.uploads.get(tip.id) === attempt) this.uploads.delete(tip.id); });
    return attempt;
  }

  private async boundedLoad(tip: TipDefinition): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    try {
      return await Promise.race([this.load(tip, () => active), new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), TIP_IMAGE_TIMEOUT);
        timer.unref();
      })]);
    } finally { active = false; if (timer) clearTimeout(timer); }
  }

  private async load(tip: TipDefinition, active: () => boolean): Promise<string | null> {
    try {
      const image = await fs.readFile(tipImagePath(tip));
      if (!active() || !image.length || image.length > 2 * 1024 * 1024) return null;
      return await this.upload(image.toString('base64'), 'image/png');
    } catch {
      return null;
    }
  }
}

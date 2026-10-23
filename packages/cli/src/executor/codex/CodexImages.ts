import * as path from 'path';
import type { ImageBlock } from '../../types';
import { MAX_IMAGE_BYTES, sniffImageMime, validateImageBlock } from '../../utils/ImageValidation';

const MAX_ENCODED_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_ATTEMPTS = 32;
const OMITTED_NOTICE = '\nSome generated images could not be attached automatically (invalid, unsupported, or over the delivery limit).\n';
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);

export type CodexImageArtifact = { image: ImageBlock } | { path: string };

/** Infer absent provider MIME hints, then apply the shared wire-image validator. */
export function validateCodexImageBlock(image: ImageBlock): ImageBlock | null {
  const data = image.data;
  if (typeof data !== 'string' || !data.length || data.length > MAX_ENCODED_LENGTH
    || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== data) return null;
  const mimeType = sniffImageMime(bytes);
  return mimeType ? validateImageBlock({ type: 'image', data, mimeType }) : null;
}

function inlineImage(value: unknown, requireDataUri = false): ImageBlock | null {
  if (typeof value !== 'string' || value.length > MAX_ENCODED_LENGTH + 100) return null;
  let data = value;
  if (value.startsWith('data:')) {
    const comma = value.indexOf(',');
    if (comma < 0 || comma > 100 || !/^data:image\/[a-z0-9.+-]+;base64,$/i.test(value.slice(0, comma + 1))) return null;
    data = value.slice(comma + 1);
  } else if (requireDataUri) return null;
  // Bytes, rather than an absent or incorrect provider MIME hint, determine the format.
  return validateCodexImageBlock({ type: 'image', data, mimeType: 'image/png' });
}

/** One instance belongs to one execute call, including all native goal continuations. */
export class CodexImages {
  private attempts = 0;
  private readonly seen = new Set<string>();
  private warned = false;

  extract(item: unknown, turnId: string | null): { artifacts: CodexImageArtifact[]; notice?: string } {
    const artifacts: CodexImageArtifact[] = [];
    let omitted = false;
    if (!record(item) || item.status !== 'completed' || item.success === false || item.error || item.failure) return { artifacts };
    if (!['imageGeneration', 'mcpToolCall', 'dynamicToolCall'].includes(String(item.type))) return { artifacts };
    if (item.type === 'dynamicToolCall' && item.success !== true) return { artifacts };
    if (typeof item.id !== 'string' || item.id.length > 1024 || (turnId !== null && turnId.length > 1024)) {
      this.attempts = Math.min(this.attempts + 1, MAX_ATTEMPTS);
      return this.result(artifacts, true);
    }
    const keyPrefix = JSON.stringify([turnId, item.id]);
    const admit = (ordinal: number): boolean => {
      // Replays and malformed candidates consume the same finite validation budget.
      if (this.attempts >= MAX_ATTEMPTS) { omitted = true; return false; }
      this.attempts++;
      const key = `${keyPrefix}:${ordinal}`;
      if (this.seen.has(key)) return false;
      this.seen.add(key);
      return true;
    };
    const accept = (image: ImageBlock) => {
      // The collector owns content deduplication and delivery quota. Parsing a
      // candidate does not prove its callback was publishable or accepted.
      artifacts.push({ image });
    };
    if (item.type === 'imageGeneration') {
      if (admit(0)) {
        const image = inlineImage(item.result);
        if (image) accept(image);
        else if (typeof item.savedPath === 'string' && item.savedPath.length > 0 && item.savedPath.length <= 4096
          && !/[\x00-\x1f\x7f]/.test(item.savedPath) && path.isAbsolute(item.savedPath)) {
          artifacts.push({ path: item.savedPath });
        } else omitted = true;
      }
    } else {
      const content = item.type === 'mcpToolCall' ? (record(item.result) ? item.result.content : undefined) : item.contentItems;
      if (Array.isArray(content)) {
        // Bound inspection even when a tool returns many non-image content blocks.
        const length = Math.min(content.length, MAX_ATTEMPTS);
        for (let i = 0; i < length; i++) {
          const block = content[i];
          if (!record(block) || block.type !== (item.type === 'mcpToolCall' ? 'image' : 'inputImage')) continue;
          if (!admit(i)) continue;
          const image = item.type === 'mcpToolCall'
            ? (typeof block.mimeType === 'string' && block.mimeType.length <= 80 && /^image\/[a-z0-9.+-]+$/i.test(block.mimeType)
              ? inlineImage(block.data) : null)
            : inlineImage(block.imageUrl, true);
          if (image) accept(image);
          else omitted = true;
        }
        if (content.length > length) omitted = true;
      }
    }
    return this.result(artifacts, omitted);
  }

  private result(artifacts: CodexImageArtifact[], omitted: boolean): { artifacts: CodexImageArtifact[]; notice?: string } {
    if (!omitted || this.warned) return { artifacts };
    this.warned = true;
    return { artifacts, notice: OMITTED_NOTICE };
  }
}

/** Bounded diagnostic copy: never stringify original media payloads or call toJSON. */
export function codexToolResultText(value: unknown): string {
  let nodes = 0;
  let remaining = 2000;
  const visited = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    if (++nodes > 64 || depth > 6 || remaining <= 0) return '[omitted]';
    if (typeof input === 'string') {
      const prefix = input.slice(0, remaining);
      const text = prefix.replace(/data:(?:image|audio)\/[^\s"'<>]*/gi, '[media omitted]');
      remaining -= prefix.length;
      return text;
    }
    if (input === null || typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input !== 'object') return '[unsupported]';
    if (visited.has(input)) return '[circular]';
    visited.add(input);
    if (record(input) && ['image', 'inputImage', 'audio', 'inputAudio'].includes(String(input.type))) return '[media omitted]';
    if (Array.isArray(input)) {
      const output: unknown[] = [];
      for (let i = 0; i < Math.min(input.length, 32) && nodes < 64 && remaining > 0; i++) output.push(copy(input[i], depth + 1));
      return output;
    }
    const output: Record<string, unknown> = Object.create(null);
    let keys = 0;
    for (const key in input) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      if (++keys > 32 || nodes >= 64 || remaining <= 0) break;
      const name = key.slice(0, 80);
      remaining -= name.length;
      output[name] = ['imageUrl', 'audioUrl'].includes(key) ? '[media omitted]' : copy((input as RecordValue)[key], depth + 1);
    }
    return output;
  };
  const safe = copy(value, 0);
  return (typeof safe === 'string' ? safe : JSON.stringify(safe)).slice(0, 2000);
}

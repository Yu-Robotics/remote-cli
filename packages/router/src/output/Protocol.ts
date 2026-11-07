/** Additive outputFilesV1 metadata. File bytes and local paths never use this protocol. */
export const OUTPUT_LIMITS = { file: 20 * 1024 * 1024, cliBytes: 200 * 1024 * 1024,
  routerBytes: 400 * 1024 * 1024, references: 100, candidates: 16, text: 256 * 1024,
  ttl: 24 * 60 * 60 * 1000, transfer: 120_000, idle: 20_000 } as const;
export const OPAQUE_ID = /^[a-f0-9]{64}$/;
export interface OutputReference {
  discoveryIncomplete?: boolean;
  id: string; messageId: string; threadId: string; taskId: string; generation: number;
  name: string; source: 'workspace' | 'worker' | 'export'; size: number; sha256: string; expiresAt: number;
}
export function validReference(value: any): value is OutputReference {
  return !!value && (value.discoveryIncomplete === undefined || typeof value.discoveryIncomplete === 'boolean') && OPAQUE_ID.test(value.id) && OPAQUE_ID.test(value.sha256)
    && ['messageId', 'threadId', 'taskId'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 200)
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 200
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value.name)
    && ['workspace', 'worker', 'export'].includes(value.source)
    && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= OUTPUT_LIMITS.file
    && Number.isSafeInteger(value.generation) && value.generation >= 0 && Number.isSafeInteger(value.expiresAt);
}

/** Display-only assistant intent. Never authorizes existence, reads, or transfers. */
export interface AttachmentHints { generation: number; names: string[] }
export function parseAttachmentHints(value: unknown): AttachmentHints | undefined {
  const v = value as AttachmentHints | undefined;
  if (!v || !Number.isSafeInteger(v.generation) || v.generation < 0 || !Array.isArray(v.names)
    || !v.names.length || v.names.length > 16 || v.names.some(name => typeof name !== 'string' || !name || name.length > 120
      || /[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name))) return;
  return { generation: v.generation, names: [...new Set(v.names)] };
}

import { describe, expect, it } from 'vitest';
import { CodexImages, codexToolResultText, validateCodexImageBlock } from '../../src/executor/codex/CodexImages';

const png = (suffix = 0) => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, suffix]).toString('base64');
const native = (result: unknown = png(), extra: Record<string, unknown> = {}) => ({
  type: 'imageGeneration', id: 'image', status: 'completed', result, ...extra,
});
const mcp = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'mcpToolCall', id: 'mcp', status: 'completed', result: { content }, ...extra,
});
const dynamic = (contentItems: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'dynamicToolCall', id: 'dynamic', status: 'completed', success: true, contentItems, ...extra,
});
const image = (data: unknown = png()) => ({ type: 'image', mimeType: 'image/png', data });

describe('Codex image validation', () => {
  it.each([
    [[137, 80, 78, 71, 13, 10, 26, 10], 'image/png'],
    [[255, 216, 255, 224], 'image/jpeg'],
    [[...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')], 'image/webp'],
    [[...Buffer.from('GIF87a')], 'image/gif'],
    [[...Buffer.from('GIF89a')], 'image/gif'],
    [[73, 73, 42, 0], 'image/tiff'],
    [[77, 77, 0, 42], 'image/tiff'],
    [[66, 77, ...Array(12).fill(0)], 'image/bmp'],
    [[0, 0, 1, 0, 1, 0], 'image/x-icon'],
  ] as Array<[number[], string]>)('uses magic bytes for %j', (signature, mimeType) => {
    const data = Buffer.from(signature).toString('base64');
    expect(validateCodexImageBlock({ type: 'image', data, mimeType: 'image/png' })).toEqual({ type: 'image', data, mimeType });
  });

  it.each(['', 'not base64', 'aGVsbG8=', 'Qk1=', 'Qk0', 'Qk0=\n', 'Qk0===', 'Qk0_', 'AAAB', 'x'.repeat(2_796_208)])('rejects malformed, non-image or noncanonical data', data => {
    expect(validateCodexImageBlock({ type: 'image', data, mimeType: 'image/png' })).toBeNull();
  });

  it('bounds actual decoded bytes, including the padded size boundary', () => {
    for (const size of [2 * 1024 * 1024, 2 * 1024 * 1024 + 1]) {
      const bytes = Buffer.alloc(size); Buffer.from(png(), 'base64').copy(bytes);
      expect(Boolean(validateCodexImageBlock({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }))).toBe(size === 2 * 1024 * 1024);
    }
    expect(validateCodexImageBlock({ type: 'image', data: Buffer.from([199, 201, 198, 184, 185, 225]).toString('base64'), mimeType: 'image/gif' })).toBeNull();
  });
});

describe('completed Codex artifacts', () => {
  it('prefers validated inline bytes and infers the format when no MIME is supplied', () => {
    const result = new CodexImages().extract(native(`data:image/jpeg;base64,${png()}`, { savedPath: '/workspace/image.png' }), 'turn');
    expect(result).toEqual({ artifacts: [{ image: image() }] });
  });

  it.each([undefined, '', 'invalid', 42, `data:image/png;base64,${'x'.repeat(2_800_000)}`])('falls back only to the explicit native path for invalid inline data', result => {
    expect(new CodexImages().extract(native('', { result, savedPath: '/workspace/image.png' }), null))
      .toEqual({ artifacts: [{ path: '/workspace/image.png' }] });
  });

  it.each(['relative.png', 'https://example.com/image.png', '/workspace/\nimage.png', '', '/'.repeat(4097), null])('rejects unsafe native paths with a generic notice', savedPath => {
    const parsed = new CodexImages().extract(native('', { savedPath }), 'turn');
    expect(parsed.artifacts).toEqual([]);
    expect(parsed.notice).toContain('could not be attached');
    expect(parsed.notice).not.toContain('/workspace');
  });

  it('extracts only authoritative content blocks and ignores nested paths and URLs', () => {
    const parser = new CodexImages();
    expect(parser.extract(mcp([image(), { type: 'text', text: 'ok', savedPath: '/workspace/hidden.png' }]), 'turn').artifacts).toEqual([{ image: image() }]);
    expect(parser.extract(dynamic([{ type: 'inputImage', imageUrl: `data:image/png;base64,${png(1)}` }]), 'turn').artifacts).toEqual([{ image: image(png(1)) }]);
    expect(parser.extract(dynamic([{ type: 'inputImage', imageUrl: 'https://example.com/image.png' }], { id: 'remote' }), 'turn').artifacts).toEqual([]);
    expect(parser.extract(dynamic([{ type: 'inputImage', imageUrl: png(2) }], { id: 'raw' }), 'turn').artifacts).toEqual([]);
    expect(parser.extract(mcp([{ type: 'text', text: 'ok' }], { id: 'nested', result: { content: [], structuredContent: { content: [image()] } } }), 'turn')).toEqual({ artifacts: [] });
  });

  it.each([
    null, 1, [], native(png(), { type: 'imageView' }), native(png(), { status: 'failed' }),
    native(png(), { failure: { reason: 'failed' } }), mcp([image()], { error: { message: 'failed' } }),
    dynamic([{ type: 'inputImage', imageUrl: `data:image/png;base64,${png()}` }], { success: false }),
    dynamic([{ type: 'inputImage', imageUrl: `data:image/png;base64,${png()}` }], { success: null }),
    dynamic([{ type: 'inputImage', imageUrl: `data:image/png;base64,${png()}` }], { success: 'true' }),
  ])('ignores failed and unsupported items', item => {
    expect(new CodexImages().extract(item, null)).toEqual({ artifacts: [] });
  });

  it('bounds identity storage and notices, and validates unknown JSON fields', () => {
    const parser = new CodexImages();
    expect(parser.extract(native(png(), { id: 'x'.repeat(1025) }), 'turn').notice).toBeDefined();
    expect(parser.extract(native(), 'x'.repeat(1025))).toEqual({ artifacts: [] });
    expect(new CodexImages().extract(native(png(), { id: 4 }), null).notice).toBeDefined();
    expect(new CodexImages().extract(mcp([null, 4, image(null), { type: 'image' }, { ...image(), mimeType: 4 }, { ...image(), mimeType: 'text/plain' }]), null).artifacts).toEqual([]);
    expect(new CodexImages().extract(mcp([], { result: null }), null)).toEqual({ artifacts: [] });
  });

  it('counts duplicates and malformed candidates toward the 32-attempt limit', () => {
    const parser = new CodexImages();
    expect(parser.extract(native(), 'turn').artifacts).toHaveLength(1);
    for (let i = 1; i < 32; i++) expect(parser.extract(native(), 'turn').artifacts).toEqual([]);
    expect(parser.extract(native(png(1), { id: 'later' }), 'turn')).toMatchObject({ artifacts: [], notice: expect.any(String) });
    const invalid = new CodexImages();
    for (let i = 0; i < 32; i++) invalid.extract(native('bad', { id: String(i) }), 'turn');
    expect(invalid.extract(native(), 'turn').artifacts).toEqual([]);
  });

  it('leaves byte deduplication to delivery and allows reused item IDs in a new native turn', () => {
    const parser = new CodexImages();
    expect(parser.extract(native(), 'one').artifacts).toHaveLength(1);
    expect(parser.extract(mcp([image()]), 'one').artifacts).toHaveLength(1);
    expect(parser.extract(native(png(1)), 'two').artifacts).toHaveLength(1);
    expect(new CodexImages().extract(native(), 'one').artifacts).toHaveLength(1);
  });

  it('bounds forwarded candidates and content inspection to 32 entries', () => {
    const parser = new CodexImages();
    const parsed = parser.extract(mcp(Array.from({ length: 50 }, (_, i) => image(png(i)))), 'turn');
    expect(parsed.artifacts).toHaveLength(32);
    expect(parsed.notice).toBeDefined();
    expect(parser.extract(native('', { savedPath: '/workspace/late.png' }), 'turn').artifacts).toEqual([]);
    const late = Array.from({ length: 33 }, () => ({ type: 'text', text: 'plain' }));
    expect(new CodexImages().extract(mcp([...late, image()]), 'turn').artifacts).toEqual([]);
  });

  it('does not deduplicate paths whose contents may change between items', () => {
    const parser = new CodexImages();
    for (const id of ['one', 'two']) expect(parser.extract(native('', { id, savedPath: '/workspace/image.png' }), 'turn').artifacts).toHaveLength(1);
  });

  it.each(['data:image/png,AAAA', 'data:image/png;base64', `data:image/${'x'.repeat(101)};base64,AAAA`])('rejects invalid data URIs', result => {
    expect(new CodexImages().extract(native(result), null).artifacts).toEqual([]);
  });
});

describe('bounded tool diagnostics', () => {
  it('removes image and audio bytes before serialization, including failed tool results', () => {
    const bytes = 'private-media-payload'.repeat(100_000);
    const value = { content: [image(bytes), { type: 'inputImage', imageUrl: bytes }, { type: 'audio', data: bytes },
      { type: 'inputAudio', audioUrl: bytes }, { type: 'text', text: 'ordinary result' }], extra: { audioUrl: bytes } };
    const text = codexToolResultText(value);
    expect(text).toContain('ordinary result'); expect(text).toContain('[media omitted]');
    expect(text).not.toContain('private-media-payload');
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it('preserves normal text and small JSON while bounding strings, breadth, depth, and cycles', () => {
    expect(codexToolResultText('ok')).toBe('ok');
    expect(codexToolResultText({ message: 'bad', n: 1, success: false, nothing: null })).toBe('{"message":"bad","n":1,"success":false,"nothing":null}');
    expect(codexToolResultText('x'.repeat(10_000))).toHaveLength(2000);
    expect(codexToolResultText(`preview data:image/png;base64,${png()}`)).toBe('preview [media omitted]');
    const circular: any = {}; circular.self = circular;
    expect(codexToolResultText(circular)).toContain('[circular]');
    expect(codexToolResultText(undefined)).toBe('[unsupported]');
    let nested: unknown = 'end'; for (let i = 0; i < 10; i++) nested = { child: nested };
    expect(codexToolResultText(nested)).not.toContain('end');
    expect(codexToolResultText(Array(500).fill('x'))).toHaveLength(129);
    expect(codexToolResultText(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [String(i), i])))).not.toContain('"499"');
    const toJSON = () => { throw new Error('must not execute'); };
    expect(() => codexToolResultText({ toJSON })).not.toThrow();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatOutputExpiry, formatOutputFileSize, outputFileDiscoveryCard, outputFileEntryCard, outputFileTransferCard } from '../../src/output/OutputFileCards';
import type { OutputReference } from '../../src/output/Protocol';
import type { JobState } from '../../src/output/OutputTransfers';

const expiresAt = Date.UTC(2026, 10, 7, 12, 51, 29, 123);
const reference: OutputReference = { id: 'a'.repeat(64), messageId: 'reply', threadId: 'thread', taskId: 'task',
  generation: 1, name: 'report.md', source: 'workspace', size: 210, sha256: 'b'.repeat(64), expiresAt };
const parse = (content: string) => JSON.parse(content);
const texts = (card: any) => card.body.elements.map((element: any) => element.text?.content ?? element.content ?? '').join('\n');
const button = (card: any) => card.body.elements.find((element: any) => element.tag === 'button');
const transfer = (state: JobState, received = 0, ref = reference, now = expiresAt - 1000) => parse(outputFileTransferCard({
  state, received, revision: 7, refId: reference.id,
}, ref, now));

afterEach(() => vi.unstubAllEnvs());

describe('output file Card 2 presentation', () => {
  it.each([[0, '0 B'], [1, '1 B'], [210, '210 B'], [1023, '1023 B'], [1024, '1 KiB'],
    [1536, '1.5 KiB'], [1024 * 1024, '1 MiB'], [20 * 1024 * 1024, '20 MiB'],
    [-1, '0 B'], [NaN, '0 B'], [Infinity, '0 B']])('formats %s bytes as %s', (bytes, expected) => {
    expect(formatOutputFileSize(bytes as number)).toBe(expected);
  });

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Shanghai'])('uses absolute UTC regardless of host timezone %s', timezone => {
    vi.stubEnv('TZ', timezone);
    expect(formatOutputExpiry(expiresAt)).toBe('07 Nov 2026, 12:51 UTC');
    const content = outputFileEntryCard(reference);
    expect(content).toContain('07 Nov 2026, 12:51 UTC');
    expect(content).not.toContain(new Date(expiresAt).toISOString());
    expect(content).not.toContain('expires in');
  });

  it('handles invalid expiry without throwing or claiming a valid deadline', () => {
    expect(formatOutputExpiry(NaN)).toBe('Unknown expiry (UTC)');
    expect(formatOutputExpiry(Number.MAX_SAFE_INTEGER)).toBe('Unknown expiry (UTC)');
    expect(formatOutputExpiry(0)).toBe('01 Jan 1970, 00:00 UTC');
  });

  it.each([['workspace', 'Workspace file'], ['worker', 'Worker output'], ['export', 'Exported artifact']] as const)(
    'shows a compact %s entry with a primary Get file action', (source, label) => {
      const card = parse(outputFileEntryCard({ ...reference, source }));
      expect(card).toMatchObject({ schema: '2.0', header: { title: { tag: 'plain_text', content: 'File ready' }, template: 'blue' } });
      expect(card.body.elements[0]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: reference.name } });
      expect(texts(card)).toContain(`210 B · ${label}`);
      expect(button(card)).toEqual({ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: 'Get file' },
        behaviors: [{ type: 'callback', value: { action: 'output_file', id: reference.id, op: 'get' } }] });
      expect(button(card)).not.toHaveProperty('value');
    });

  it('keeps Unicode and markup-like filenames literal and separate from trusted Markdown', () => {
    const name = "**report** <at id=all></at> [open](https://example.com) `code` \u6d4b\u8bd5.md";
    for (const card of [parse(outputFileEntryCard({ ...reference, name })), transfer('delivered', 0, { ...reference, name })]) {
      expect(card.body.elements.filter((element: any) => element.tag === 'div' && element.text?.content === name))
        .toEqual([{ tag: 'div', text: { tag: 'plain_text', content: name } }]);
      expect(card.header.title.content).not.toContain(name);
      for (const element of card.body.elements.filter((value: any) => value.tag === 'markdown')) {
        expect(element.content).not.toContain(name);
        expect(element.content).not.toContain('<at');
        expect(element.text_size).toBe('notation');
      }
    }
  });

  it.each([
    ['queued', 'File transfer queued', 'blue'], ['waiting-device', 'Waiting for device', 'orange'],
    ['receiving', 'Receiving file', 'blue'], ['staged-verified', 'File received', 'blue'],
    ['upload-intent', 'Uploading to Feishu', 'blue'], ['file-key-saved', 'Preparing file message', 'blue'],
    ['send-intent', 'Sending file message', 'blue'], ['delivered', 'File delivered', 'green'],
    ['send-uncertain', 'Delivery unconfirmed', 'orange'], ['failed', 'File transfer failed', 'red'],
    ['expired', 'File expired', 'grey'], ['revoked', 'File unavailable', 'grey'],
  ] as const)('renders %s with a distinct truthful header', (state, title, color) => {
    const card = transfer(state);
    expect(card.header).toEqual({ title: { tag: 'plain_text', content: title }, template: color });
    expect(card.body.elements[0].text.content).toBe(reference.name);
    expect(texts(card)).toContain('210 B');
    expect(Boolean(button(card))).toBe(state === 'failed');
    expect(JSON.stringify(card).length).toBeLessThan(16_384);
    if (state === 'delivered') {
      expect(texts(card)).toContain('Find the file message in this chat.');
      expect(texts(card)).not.toContain('already delivered');
    }
    if (state === 'send-uncertain') {
      expect(texts(card)).toContain('could not be confirmed');
      expect(texts(card)).toContain('will not be sent again automatically');
      expect(texts(card)).not.toContain('Retry');
    }
  });

  it('preserves the exact Retry revision and hides Retry at or after expiry', () => {
    expect(button(transfer('failed')).behaviors).toEqual([{ type: 'callback', value: {
      action: 'output_file', id: reference.id, op: 'retry', rev: 7,
    } }]);
    expect(button(transfer('failed')).type).toBe('primary');
    expect(button(transfer('failed')).text.content).toBe('Retry');
    for (const now of [expiresAt, expiresAt + 1]) {
      const card = transfer('failed', 0, reference, now);
      expect(button(card)).toBeUndefined();
      expect(texts(card)).toContain('has expired');
      expect(texts(card)).not.toContain('Use Retry');
    }
  });

  it.each([[-1, 210, '0% · 0 B / 210 B received'], [105, 210, '50% · 105 B / 210 B received'],
    [1000, 210, '100% · 210 B / 210 B received'], [NaN, 210, '0% · 0 B / 210 B received'],
    [Infinity, 210, '0% · 0 B / 210 B received'], [12, 0, '0% · 0 B / 0 B received'],
    [12, NaN, '0% · 0 B / 0 B received'], [1536, 3072, '50% · 1.5 KiB / 3 KiB received']])(
    'bounds receiving progress %s / %s', (received, size, expected) => {
      expect(texts(transfer('receiving', received as number, { ...reference, size: size as number }))).toContain(expected);
      expect(texts(transfer('upload-intent', received as number))).not.toContain('%');
    });

  it('retains a visible discovery-limit warning on the stable entry', () => {
    const card = parse(outputFileEntryCard({ ...reference, discoveryIncomplete: true }));
    expect(texts(card)).toContain('not exhaustive');
    expect(button(card).text.content).toBe('Get file');
    expect(texts(parse(outputFileEntryCard(reference)))).not.toContain('not exhaustive');
  });

  it.each([[1, false, '1 linked file could'], [2, true, '2 linked files could'], [0, true, 'not exhaustive'],
    [0, false, 'Only verified files']])('shows a warning notice for %s unavailable, omitted=%s', (unavailable, omitted, expected) => {
    const card = parse(outputFileDiscoveryCard(unavailable as number, omitted as boolean));
    expect(card.header.template).toBe('orange');
    expect(texts(card)).toContain(expected);
    expect(texts(card).includes('not exhaustive')).toBe(omitted);
    expect(button(card)).toBeUndefined();
  });
});

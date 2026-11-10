import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { parseAttachmentHints } from '../../src/output/Protocol';
import { InlineFileCards, type InlineFileRow, type InlineOwner } from '../../src/output/InlineFileCards';

let root: string, cards: InlineFileCards, owned: boolean, rows: InlineFileRow[], patch: ReturnType<typeof vi.fn>;
const owner: InlineOwner = { messageId: 'request', rootId: 'actual-root-card', openId: 'owner', deviceId: 'device', epoch: 'epoch', threadId: 'thread' };
const body = (text = 'Assistant reply') => JSON.stringify({ schema: '2.0', body: { elements: [
  { tag: 'markdown', content: text }, { tag: 'img', img_key: 'synthetic-image' },
  { tag: 'collapsible_panel', header: { title: { tag: 'plain_text', content: 'Tool' } }, elements: [{ tag: 'markdown', content: 'Tool result' }] },
  { tag: 'markdown', content: 'Completed' }, { tag: 'button', text: { tag: 'plain_text', content: 'Thread control' } },
] } });
const row = (i = 1): InlineFileRow => ({ ...owner, id: i.toString(16).padStart(64, '0'), name: `report-${i}.csv`, generation: 3, status: 'Ready', op: 'get' });
const make = () => new InlineFileCards(path.join(root, 'journal'), { owns: async () => owned, rows: identity => identity.messageId === owner.messageId ? rows : [], patch });
async function bind() { await cards.admit(owner); cards.remember('final-card', owner.rootId, body()); await cards.bind(owner.rootId, 'final-card'); }
const last = () => JSON.parse(patch.mock.calls.at(-1)![1]);
const panel = () => last().body.elements.find((e: any) => e.element_id === 'output_files_inline');
function taggedNodeCount(value: unknown): number {
  const pending = [value]; let count = 0;
  while (pending.length) {
    const next = pending.pop();
    if (!next || typeof next !== 'object') continue;
    if ('tag' in next && typeof next.tag === 'string') count++;
    pending.push(...Object.values(next));
  }
  return count;
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'inline-output-test-')));
  vi.spyOn(os, 'homedir').mockReturnValue(root); owned = true; rows = []; patch = vi.fn(async () => {}); cards = make();
});
afterEach(async () => { vi.useRealTimers(); await cards.destroy(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe('inline file presentation', () => {
  it('shows one heading and separates the literal filename from subdued size, status and absolute UTC expiry', async () => {
    rows = [{ ...row(), size: 1536, expiresAt: Date.UTC(2026, 0, 2, 3, 4) }]; await bind();
    expect(panel()).toMatchObject({ expanded: true, header: { title: { tag: 'plain_text', content: 'Files (1)' } } });
    expect(panel().elements).toEqual([
      { tag: 'div', text: { tag: 'plain_text', content: 'report-1.csv' } },
      { tag: 'markdown', text_size: 'notation', content: "<font color='grey'>1.5 KiB · Ready\nExpires 02 Jan 2026, 03:04 UTC</font>" },
      { tag: 'button', type: 'primary', disabled: false, text: { tag: 'plain_text', content: 'Get file' },
        behaviors: [{ type: 'callback', value: { action: 'output_file', id: row().id, op: 'get' } }] },
    ]);
  });
  it('omits the page indicator for a full single page and does not invent missing metadata', async () => {
    rows = Array.from({ length: 4 }, (_, i) => row(i + 1)); await bind();
    expect(panel().header.title.content).toBe('Files (4)');
    expect(panel().elements.filter((e: any) => e.tag === 'markdown')).toEqual(
      Array(4).fill({ tag: 'markdown', text_size: 'notation', content: "<font color='grey'>Ready</font>" }));
    expect(panel().elements.filter((e: any) => e.tag === 'button')).toHaveLength(4);
  });
  it.each([
    ['</font><at id=all>Alert</at><font color="red">', '&lt;/font&gt;&lt;at id=all&gt;Alert&lt;/at&gt;&lt;font color="red"&gt;'],
    ['[open](https://example.com) ![image](x) **urgent** _text_ `code` \\ | ~ {x} # + -',
      '\\[open\\]\\(https://example\\.com\\) \\!\\[image\\]\\(x\\) \\*\\*urgent\\*\\* \\_text\\_ \\`code\\` \\\\ \\| \\~ \\{x\\} \\# \\+ \\-'],
    ['&lt;at id=all&gt; & text', '&amp;lt;at id=all&amp;gt; &amp; text'],
    ['Ready\n# injected\r\n> quote', 'Ready \\# injected  &gt; quote'],
  ])('keeps malicious names literal and escapes untrusted status (%#)', async (status, escaped) => {
    const name = '\u202e<at id=all>**report**[x]`code`.csv\u0000';
    rows = [{ ...row(), name, status }]; await bind();
    expect(panel().elements[0]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: name.slice(1, -1) } });
    expect(panel().elements[1]).toEqual({ tag: 'markdown', text_size: 'notation', content: `<font color='grey'>${escaped}</font>` });
    expect(panel().elements.filter((e: any) => e.tag === 'markdown').every((e: any) => !e.content.includes('report'))).toBe(true);
  });
  it('retains filename truncation and control-character sanitization on the standalone line', async () => {
    rows = [{ ...row(), name: `\u0000${'a'.repeat(121)}\u202e.csv` }]; await bind();
    expect(panel().elements[0].text).toEqual({ tag: 'plain_text', content: 'a'.repeat(120) });
  });
  it.each([
    ['Ready', 'get'], ['File retrieval queued', 'get'], ['Waiting for the original device to reconnect', 'get'],
    ['Receiving the snapshot', 'get'], ['Snapshot received and verified', 'get'], ['Uploading to Feishu', 'get'],
    ['Upload complete; preparing the file message', 'get'], ['Sending the file message', 'get'],
    ['Retrieval failed', 'retry'], ['Expired', undefined], ['File already delivered', undefined],
    ['File send outcome is unknown', undefined], ['Device ownership changed; retrieval is unavailable', undefined],
  ] as const)('keeps %s visible with the original action semantics', async (status, op) => {
    rows = [{ ...row(), status, op, revision: 7 }]; await bind();
    expect(panel().elements[1]).toEqual({ tag: 'markdown', text_size: 'notation', content: `<font color='grey'>${status}</font>` });
    const button = panel().elements[2];
    expect(button).toMatchObject({ tag: 'button', disabled: !op, type: op ? 'primary' : 'default',
      text: { tag: 'plain_text', content: op === 'retry' ? 'Retry' : 'Get file' } });
    if (op) expect(button.behaviors).toEqual([{ type: 'callback', value: {
      action: 'output_file', id: row().id, op, ...(op === 'retry' ? { rev: 7 } : {}),
    } }]);
    else expect(button.behaviors).toBeUndefined();
  });
  it.each([
    ['disabled', 'File retrieval disabled'], ['approval', 'File approval required'],
    ['upgrade', 'CLI file support required'], ['unavailable', 'Attachment unavailable'], ['ready', 'Attachment not prepared'],
  ] as const)('shows %s hint status in notation metadata with a disabled action', async (status, text) => {
    await bind(); await cards.hints(owner.deviceId, { messageId: owner.messageId, threadId: owner.threadId, generation: 3, names: ['report.csv'] }, status);
    expect(panel().elements[0].text).toEqual({ tag: 'plain_text', content: 'report.csv' });
    expect(panel().elements[1]).toEqual({ tag: 'markdown', text_size: 'notation', content: `<font color='grey'>${text}</font>` });
    expect(panel().elements[2]).toMatchObject({ disabled: true, type: 'default' });
    expect(panel().elements[2].behaviors).toBeUndefined();
  });
  it.each(['disabled', 'approval'] as const)('keeps %s verified rows visibly blocked without a retrieval callback', async status => {
    rows = [row()]; await bind();
    await cards.hints(owner.deviceId, { messageId: owner.messageId, threadId: owner.threadId, generation: 3, names: [row().name] }, status);
    expect(panel().elements[1].content).toBe(`<font color='grey'>${status === 'disabled' ? 'File retrieval disabled' : 'File approval required'}</font>`);
    expect(panel().elements[2].disabled).toBe(true); expect(panel().elements[2].behaviors).toBeUndefined();
  });
  it.each([153, 154, 163, 164, 168])('keeps every row reachable within 180 recursive nodes on a %i-node base card', async budget => {
    rows = Array.from({ length: 16 }, (_, i) => row(i + 1)); await cards.admit(owner);
    const original = { schema: '2.0', header: { title: { tag: 'plain_text', content: 'Assistant' } }, body: { elements: [
      ...Array.from({ length: Math.floor((budget - 1) / 2) }, () => ({ tag: 'div', text: { tag: 'plain_text', content: 'Answer' } })),
      ...(budget % 2 === 0 ? [{ tag: 'markdown', content: 'Tail' }] : []),
    ] } };
    expect(taggedNodeCount(original)).toBe(budget);
    cards.remember('final-card', owner.rootId, JSON.stringify(original)); await cards.bind(owner.rootId, 'final-card');
    const pageSize = budget === 153 ? 4 : budget === 154 ? 3 : budget === 163 ? 2 : 1;
    const pages = Math.ceil(16 / pageSize), seen = new Set<string>();
    for (let page = 0; page < pages; page++) {
      expect(taggedNodeCount(last())).toBeLessThanOrEqual(180);
      expect(last().body.elements.slice(0, -1)).toEqual(original.body.elements);
      expect(panel().elements[0].content).toBe(`Page ${page + 1} of ${pages}`);
      expect(JSON.stringify(panel())).not.toContain('Files ·');
      const actions = panel().elements.filter((e: any) => e.behaviors?.[0]?.value.action === 'output_file');
      expect(actions).toHaveLength(Math.min(pageSize, 16 - page * pageSize));
      for (const action of actions) seen.add(action.behaviors[0].value.id);
      const previous = panel().elements.find((e: any) => e.text?.content === 'Previous');
      const next = panel().elements.find((e: any) => e.text?.content === 'Next');
      if (page === 0) expect(previous).toBeUndefined();
      else {
        expect(previous.behaviors[0].value).toMatchObject({ action: 'output_page', page: page - 1 });
        expect(previous.behaviors[0].value.id).toMatch(/^[a-f0-9]{64}$/);
        if (budget === 168 && next) expect(taggedNodeCount(last())).toBe(180);
      }
      if (page === pages - 1) expect(next).toBeUndefined();
      else {
        expect(next.behaviors[0].value).toMatchObject({ action: 'output_page', page: page + 1 });
        if (previous) expect(next.behaviors[0].value.id).toBe(previous.behaviors[0].value.id);
        expect(await cards.page(owner.openId, 'final-card', next.behaviors[0].value)).toContain('updated');
      }
    }
    expect(seen).toEqual(new Set(rows.map(r => r.id)));
    const previous = panel().elements.find((e: any) => e.text?.content === 'Previous');
    await cards.page(owner.openId, 'final-card', previous.behaviors[0].value);
    expect(panel().elements[0].content).toBe(`Page ${pages - 1} of ${pages}`);
  });
  it('rejects base cards exceeding 168 recursive nodes', async () => {
    rows = [row()]; await bind();
    const send = vi.fn(async () => ({ code: 0 }));
    const oversized = JSON.stringify({ schema: '2.0', body: { elements: Array.from({ length: 169 }, () => ({ tag: 'markdown', content: 'Answer' })) } });
    await expect(cards.write('final-card', owner.rootId, oversized, send)).rejects.toThrow('reserved capacity');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('owned assistant body composition', () => {
  const controls = [
    { tag: 'hr' }, { tag: 'markdown', content: '📍 **Reply from:** Default · workspace' },
    { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'button',
      behaviors: [{ type: 'callback', value: { action: 'switch_thread', threadId: 'thread' } }] }] }] },
    { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'button',
      behaviors: [{ type: 'callback', value: { action: 'new_thread' } }] }] }] },
  ];
  const metadata = { tag: 'markdown', text_size: 'notation', content: "<font color='grey'>Model: synthetic · Effort: unknown</font>" };
  it.each([
    [{ tag: 'markdown', element_id: 'assistant_footer', content: '✅ Completed' }, metadata, ...controls],
    [{ ...controls[0], element_id: 'assistant_threads' }, ...controls.slice(1)],
    [{ tag: 'markdown', content: '✅ Completed · Session: synthetic' }, metadata, ...controls],
    [{ tag: 'markdown', content: '❌ Failed' }, ...controls],
    [{ tag: 'markdown', content: '⏳ Awaiting queue confirmation' }, controls[0], ...controls.slice(2)],
    [{ tag: 'markdown', content: '✅ Completed' }],
    controls,
  ].map(trailing => [trailing]))('expands Files above the complete marked or legacy trailing block (%#)', async trailing => {
    rows = [row()]; await cards.admit(owner);
    const answer = JSON.parse(body()).body.elements.slice(0, 3);
    const original = [...answer, ...trailing];
    cards.remember('final-card', owner.rootId, JSON.stringify({ schema: '2.0', body: { elements: original } }));
    await cards.bind(owner.rootId, 'final-card');
    const elements = last().body.elements;
    expect(elements[answer.length].element_id).toBe('output_files_inline');
    expect(panel().expanded).toBe(true); expect(panel().header.title.content).toBe('Files (1)');
    expect(elements.filter((e: any) => e.element_id !== 'output_files_inline')).toEqual(original);
  });
  it('keeps unrelated trailing actions and answer text ahead of Files', async () => {
    rows = [row()]; await cards.admit(owner);
    const original = [{ tag: 'markdown', content: '✅ Completed inside an answer, not a footer' },
      { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'button',
        behaviors: [{ type: 'callback', value: { action: 'output_file' } }] }] }] }];
    cards.remember('final-card', owner.rootId, JSON.stringify({ schema: '2.0', body: { elements: original } }));
    await cards.bind(owner.rootId, 'final-card');
    expect(last().body.elements.slice(0, -1)).toEqual(original); expect(panel().expanded).toBe(true);
  });
  it('keeps all sixteen rows above legacy controls on every page, progress update and restart', async () => {
    rows = Array.from({ length: 16 }, (_, i) => row(i + 1)); await cards.admit(owner);
    const answer = { tag: 'markdown', content: 'Full answer' };
    cards.remember('final-card', owner.rootId, JSON.stringify({ schema: '2.0', body: { elements: [answer, ...controls] } }));
    await cards.bind(owner.rootId, 'final-card'); const seen = new Set<string>();
    for (let page = 0; page < 4; page++) {
      expect(last().body.elements[1].element_id).toBe('output_files_inline');
      expect(panel().expanded).toBe(true); expect(panel().header.title.content).toBe('Files (16)');
      for (const e of panel().elements) if (e.behaviors?.[0]?.value.action === 'output_file') seen.add(e.behaviors[0].value.id);
      const next = panel().elements.find((e: any) => e.text?.content === 'Next');
      if (next) await cards.page(owner.openId, 'final-card', next.behaviors[0].value);
    }
    expect(seen.size).toBe(16);
    await cards.destroy(); cards = make(); rows = rows.map(r => ({ ...r, status: 'Receiving' })); await cards.refresh(owner.messageId);
    expect(panel().expanded).toBe(true); expect(JSON.stringify(panel())).toContain('Receiving');
    expect(last().body.elements.filter((e: any) => e.element_id !== 'output_files_inline')).toEqual([answer, ...controls]);
    expect(last().body.elements[1].element_id).toBe('output_files_inline');
  });
  it('holds early offers until the complete actual final card body is known', async () => {
    rows = [row()]; await cards.admit(owner); await cards.refresh(owner.messageId); expect(patch).not.toHaveBeenCalled();
    await cards.bind(owner.rootId, owner.messageId); expect(patch).not.toHaveBeenCalled();
    cards.remember('continuation', owner.rootId, body('Full long-reply tail'));
    await cards.bind(owner.rootId, 'continuation');
    expect(patch).toHaveBeenLastCalledWith('continuation', expect.any(String));
    expect(last().body.elements.slice(0, -1)).toEqual(JSON.parse(body('Full long-reply tail')).body.elements);
    expect(panel().elements.some((e: any) => e.behaviors?.[0]?.value.id === row().id)).toBe(true);
    expect(await cards.allows({ ...owner, generation: 3 }, owner.messageId)).toBe(false);
    expect(await cards.allows({ ...owner, generation: 3 }, 'continuation')).toBe(true);
  });
  it('serializes streaming/final body changes with transfer updates and preserves every body element', async () => {
    rows = [row()]; await bind();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }); const sent: any[] = [];
    const writing = cards.write('final-card', owner.rootId, body('New final text'), async content => { sent.push(JSON.parse(content)); await held; return { code: 0 }; });
    let updating: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      rows = [{ ...row(), status: 'Receiving', op: 'get' }]; updating = cards.refresh(owner.messageId);
      release(); await Promise.all([writing, updating]);
      expect(last().body.elements.slice(0, -1)).toEqual(JSON.parse(body('New final text')).body.elements);
      expect(JSON.stringify(panel())).toContain('Receiving');
      expect(last().body.elements.filter((e: any) => e.element_id === 'output_files_inline')).toHaveLength(1);
      const count = patch.mock.calls.length; await cards.refresh(owner.messageId); expect(patch).toHaveBeenCalledTimes(count);
    } finally { release(); await Promise.allSettled([writing, updating]); }
  });
  it('preserves unrelated writes without decorating or replacing a foreign body', async () => {
    await bind(); const send = vi.fn(async () => ({ code: 0 }));
    await cards.write('foreign-card', 'foreign-root', body('Foreign'), send);
    expect(send).toHaveBeenCalledWith(body('Foreign'));
    cards.remember('foreign-card', 'foreign-root', body('Foreign'));
    await cards.bind(owner.rootId, 'foreign-card'); expect(await cards.allows({ ...owner, generation: 3 }, 'foreign-card')).toBe(false);
  });
  it('denies a known card body write through a different root without forwarding it', async () => {
    await bind(); const send = vi.fn(async () => ({ code: 0 }));
    await expect(cards.write('final-card', 'foreign-root', body('Foreign replacement'), send)).rejects.toThrow('ownership changed');
    expect(send).not.toHaveBeenCalled();
    cards.remember('known-continuation', owner.rootId, body('Known tail'));
    await expect(cards.write('known-continuation', 'foreign-root', body('Foreign replacement'), send)).rejects.toThrow('ownership changed');
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['owner', 'device', 'thread', 'epoch', 'root'])('refuses a rebound %s identity', async field => {
    await bind(); const other = { ...owner, [field === 'owner' ? 'openId' : field === 'device' ? 'deviceId' : field === 'thread' ? 'threadId' : field === 'epoch' ? 'epoch' : 'rootId']: 'foreign' };
    await expect(cards.admit(other)).rejects.toThrow('identity changed');
    expect(await cards.allows({ ...owner, openId: 'foreign', generation: 3 }, 'final-card')).toBe(false);
  });
  it.each(['messageId', 'openId', 'deviceId', 'epoch', 'threadId', 'generation'] as const)('joins reference metadata and callbacks against the parent %s', async field => {
    const identity = { ...owner, generation: 3 };
    await cards.admit(identity);
    rows = [{ ...row(), [field]: field === 'generation' ? 4 : 'foreign' }];
    cards.remember('final-card', owner.rootId, body()); await cards.bind(owner.rootId, 'final-card');
    expect(JSON.stringify(patch.mock.calls)).not.toContain('report-1.csv');
    const invalid = { ...identity, [field]: field === 'generation' ? 4 : 'foreign' };
    expect(await cards.allows(invalid, 'final-card')).toBe(false);
    expect(await cards.allows({ ...owner }, 'final-card')).toBe(false);
  });
  it('holds ambiguous generations before any verified generation has been selected', async () => {
    rows = [{ ...row(), expiresAt: Date.now() + 60_000 }, { ...row(2), generation: 4, expiresAt: Date.now() + 60_000 }];
    await bind(); expect(patch).not.toHaveBeenCalled();
    expect(await cards.identityStatus({ ...owner, threadId: 'other' })).toBe('conflict');
    expect(await cards.identityStatus({ ...owner, messageId: 'unknown' })).toBe('unknown');
    expect(await cards.identityStatus(owner)).toBe('match');
  });
  it('recovers only an unpublished pending parent and never retargets a published file panel', async () => {
    await cards.admit(owner);
    const restored = { ...owner, rootId: 'recovery-card' };
    await expect(cards.admit(restored)).rejects.toThrow('identity changed');
    await cards.admit(restored, true);
    expect(cards.hasRoot(owner.rootId)).toBe(false);
    rows = [row()]; cards.remember('recovery-card', restored.rootId, body('Recovered assistant body'));
    await cards.bind(restored.rootId, 'recovery-card');
    expect(await cards.allows({ ...owner, generation: 3 }, 'recovery-card')).toBe(true);
    await expect(cards.admit(owner, true)).rejects.toThrow('identity changed');
    await expect(cards.admit({ ...restored, openId: 'foreign', rootId: 'foreign-card' }, true)).rejects.toThrow('identity changed');
    expect(last().body.elements[0].content).toBe('Recovered assistant body');
  });
  it('rejects ownership changes, expiry, mismatched generations and guessed page controls', async () => {
    rows = [row()]; await bind();
    await cards.hints(owner.deviceId, { messageId: owner.messageId, threadId: owner.threadId, generation: 3, names: ['report.csv'] }, 'ready');
    expect(await cards.allows({ ...owner, generation: 4 }, 'final-card')).toBe(false);
    expect(await cards.page('foreign', 'final-card', { id: 'a'.repeat(64), page: 1 })).toContain('unavailable');
    owned = false; expect(await cards.allows({ ...owner, generation: 3 }, 'final-card')).toBe(false);
    const count = patch.mock.calls.length; await cards.refresh(owner.messageId); expect(patch).toHaveBeenCalledTimes(count);
    owned = true; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 86_400_001);
    expect(await cards.allows({ ...owner, generation: 3 }, 'final-card')).toBe(false);
  });
  it('keeps all sixteen files reachable with bounded pages in the same assistant card', async () => {
    rows = Array.from({ length: 16 }, (_, i) => row(i + 1)); await bind(); const seen = new Set<string>();
    for (let page = 0; page < 4; page++) {
      for (const e of panel().elements) if (e.behaviors?.[0]?.value.action === 'output_file') seen.add(e.behaviors[0].value.id);
      const next = panel().elements.find((e: any) => e.text?.content === 'Next');
      if (next) expect(await cards.page(owner.openId, 'final-card', next.behaviors[0].value)).toContain('updated');
    }
    expect(seen.size).toBe(16); expect(patch.mock.calls.every(call => call[0] === 'final-card')).toBe(true);
    const prev = panel().elements.find((e: any) => e.text?.content === 'Previous');
    expect(await cards.page(owner.openId, 'wrong-card', prev.behaviors[0].value)).toContain('unavailable');
  });
  it.each(['disabled', 'approval', 'upgrade', 'unavailable', 'ready'] as const)('renders %s hints as display-only disabled controls', async status => {
    await bind(); await cards.hints(owner.deviceId, { messageId: owner.messageId, threadId: owner.threadId, generation: 3, names: ['report.csv'] }, status);
    const button = panel().elements.find((e: any) => e.tag === 'button'); expect(button.disabled).toBe(true); expect(button.behaviors).toBeUndefined();
    expect(JSON.stringify(panel())).not.toContain('output_file"');
  });
  it.each([['../private.csv'], ['bad\u0000name.csv'], [], Array(17).fill('report.csv')])('rejects malformed hint lists', async names => {
    await bind(); const count = patch.mock.calls.length;
    await cards.hints(owner.deviceId, { messageId: owner.messageId, threadId: owner.threadId, generation: 3, names }, 'approval');
    expect(patch).toHaveBeenCalledTimes(count);
  });
  it('recovers the complete parent body after restart for late offers without creating new cards', async () => {
    await bind(); await cards.destroy(); cards = make(); rows = [row()]; await cards.refresh(owner.messageId);
    expect(last().body.elements.slice(0, -1)).toEqual(JSON.parse(body()).body.elements);
    expect(await cards.allows({ ...owner, generation: 3 }, 'final-card')).toBe(true);
    expect(patch.mock.calls.every(call => call[0] === 'final-card')).toBe(true);
  });
  it('does not bind guessed card IDs, a changed parent card, or oversized bodies', async () => {
    await bind(); cards.remember('replacement', owner.rootId, body()); await cards.bind(owner.rootId, 'replacement');
    expect(await cards.allows({ ...owner, generation: 3 }, 'replacement')).toBe(false);
    cards.remember('huge', owner.rootId, body('x'.repeat(2_850_001))); await cards.bind(owner.rootId, 'huge');
    expect(await cards.allows({ ...owner, generation: 3 }, 'huge')).toBe(false);
    await expect(cards.write('final-card', owner.rootId, body('x'.repeat(2_850_001)), async () => ({ code: 0 }))).rejects.toThrow('capacity');
  });
  it('bounds uncertain PATCH retries durably and never creates another parent', async () => {
    await bind(); rows = [row()]; patch.mockRejectedValue(new Error('synthetic response lost'));
    for (let i = 0; i < 6; i++) await cards.refresh(owner.messageId).catch(() => {});
    expect(patch).toHaveBeenCalledTimes(3);
    await cards.destroy(); cards = make(); await cards.refresh(owner.messageId); expect(patch).toHaveBeenCalledTimes(3);
    rows = [{ ...row(), status: 'Delivered', op: undefined }]; patch.mockResolvedValue(undefined);
    await cards.refresh(owner.messageId); expect(patch).toHaveBeenCalledTimes(4);
  });
  it('does not treat a missing SDK receipt as a saved complete body', async () => {
    await cards.admit(owner);
    await cards.write('unknown-card', owner.rootId, body(), async () => undefined);
    await cards.bind(owner.rootId, 'unknown-card'); expect(await cards.allows({ ...owner, generation: 3 }, 'unknown-card')).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });
  it('holds journal replacement without modifying a foreign sentinel', async () => {
    await bind(); const directory = path.join(root, 'journal'); await fs.rename(directory, `${directory}-retained`); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'parents.json'), 'foreign sentinel'); rows = [row()];
    await expect(cards.refresh(owner.messageId)).rejects.toThrow(); expect(patch).not.toHaveBeenCalled();
    expect(await cards.allows({ ...owner, generation: 3 }, 'final-card')).toBe(false);
    expect(await fs.readFile(path.join(directory, 'parents.json'), 'utf8')).toBe('foreign sentinel');
  });
  it('evicts dormant reply metadata before it can starve a verified file parent', async () => {
    rows = [];
    for (let i = 0; i < 100; i++) await cards.admit({ ...owner, messageId: `empty-${i}`, rootId: `empty-card-${i}` });
    rows = [row()]; await cards.admit(owner); cards.remember('final-card', owner.rootId, body()); await cards.bind(owner.rootId, 'final-card');
    expect(await cards.allows({ ...owner, generation: 3 }, 'final-card')).toBe(true);
    expect((cards as any).parents.size).toBe(100);
    expect((cards as any).parents.has('empty-0')).toBe(false);
  });
  it('holds malformed or replaced journals and rejects new work after teardown', async () => {
    await bind(); await cards.destroy();
    await fs.writeFile(path.join(root, 'journal', 'parents.json'), JSON.stringify({ version: 1, parents: [{}] })); cards = make();
    await expect(cards.initialize()).rejects.toThrow('Invalid'); await cards.destroy();
    await expect(cards.write('card', 'root', body(), async () => {})).rejects.toThrow('closed');
  });
});


describe('untrusted attachment hint protocol', () => {
  it.each([null, {}, { generation: -1, names: ['a'] }, { generation: 1.1, names: ['a'] },
    { generation: 0, names: [] }, { generation: 0, names: Array(17).fill('a') },
    ...['', 'a/b.csv', 'a\\b.csv', '\u0000.csv', '\u202e.csv', 'a'.repeat(121)].map(name => ({ generation: 0, names: [name] }))])
    ('rejects path-bearing or malformed wire metadata (%j)', value => { expect(parseAttachmentHints(value)).toBeUndefined(); });
  it('copies and deduplicates display-only basenames', () => {
    const names = ['report.csv', 'report.csv']; const parsed = parseAttachmentHints({ generation: 0, names }); names[0] = 'changed.csv';
    expect(parsed).toEqual({ generation: 0, names: ['report.csv'] });
  });
});

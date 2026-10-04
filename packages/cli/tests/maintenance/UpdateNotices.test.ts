import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import ts from 'typescript';
import { UpdateNotices } from '../../src/maintenance/UpdateNotices';
import { PrivateStore } from '../../src/maintenance/PrivateStore';
import { compareNoticeVersions, validNoticeVersion } from '../../src/maintenance/Version';
import { buildReleaseIndex, parseReleaseNotes, releasePage, loadReleaseIndex, USER_SUMMARY_BYTES } from '../../src/maintenance/ReleaseNotes';

describe('upgrade maintenance ledger', () => {
  let directory: string;
  let send: ReturnType<typeof vi.fn>;
  let clients: UpdateNotices[];
  const client = () => { const result = new UpdateNotices(directory, 'https://router.example.com', 'device-fixture', send, 10); clients.push(result); return result; };
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notice-test-')); send = vi.fn(); clients = []; });
  afterEach(async () => { clients.forEach(c => c.stop()); await fs.rm(directory, { recursive: true, force: true }); vi.useRealTimers(); });
  const ack = (message: any) => ({ type: 'update_notice_ack', noticeKey: message.noticeKey, fromVersion: message.fromVersion, toVersion: message.toVersion });
  async function start(version: string, supported = true) { const c = client(); c.registered(supported); await c.started(version); return c; }

  it('adopts a running version silently, including reconnects and all pre-feature history', async () => {
    const c = await start('1.6.122'); c.registered(true); c.disconnected(); c.registered(true);
    c.stop(); await start('1.6.122');
    expect(send).not.toHaveBeenCalled();
    const filename = (await fs.readdir(path.join(directory, 'update-notices')))[0];
    const state = JSON.parse(await fs.readFile(path.join(directory, 'update-notices', filename), 'utf8'));
    expect(state).toMatchObject({ notificationBaselineVersion: '1.6.122', firstAdoptionVersion: '1.6.122' });
    expect(state.pending).toBeUndefined();
  });

  it('coalesces offline upgrades and preserves the silent baseline through a downgrade', async () => {
    (await start('1.6.100', false)).stop();
    (await start('1.6.110', false)).stop();
    (await start('1.6.121', false)).stop();
    (await start('1.6.119')).stop();
    (await start('1.6.119')).stop();
    expect(send).not.toHaveBeenCalled();
    await start('1.6.122');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'update_notice', fromVersion: '1.6.100', toVersion: '1.6.122' }));
  });

  it('ACKs only the exact immutable pending range and retains a delivered high-water mark on re-upgrade', async () => {
    (await start('1.6.122')).stop();
    const old = await start('1.6.123'); const obsolete = send.mock.calls.at(-1)![0]; old.stop();
    const next = await start('1.6.125'); const notice = send.mock.calls.at(-1)![0];
    await next.handle(ack(obsolete)); next.disconnected(); next.registered(true);
    expect(send.mock.calls.at(-1)![0].noticeKey).toBe(notice.noticeKey);
    await next.handle({ ...ack(notice), fromVersion: '1.6.121' });
    await next.handle(ack(notice)); next.stop(); send.mockClear();
    (await start('1.6.123')).stop(); await start('1.6.125');
    expect(send).not.toHaveBeenCalled();
  });

  it('retains pending state with an old Router, send failure, missing ACK, and disconnect', async () => {
    vi.useFakeTimers();
    (await start('1.6.122', false)).stop();
    const c = await start('1.6.123', false);
    expect(send).not.toHaveBeenCalled();
    send.mockImplementationOnce(() => { throw new Error('offline'); }); c.registered(true);
    await vi.advanceTimersByTimeAsync(10); expect(send).toHaveBeenCalledTimes(2);
    c.disconnected(); await vi.advanceTimersByTimeAsync(100); expect(send).toHaveBeenCalledTimes(2);
    c.registered(true); expect(send).toHaveBeenCalledTimes(3);
  });

  it('serves only bounded post-adoption bundled ranges over an opted-in connection', async () => {
    const c = await start('1.6.122');
    const view = { type: 'update_notice_view', requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', noticeKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', fromVersion: '1.6.121', toVersion: '1.6.122', offset: 0 };
    await c.handle(view); expect(send).not.toHaveBeenCalled();
    c.stop(); const next = await start('1.6.124'); send.mockClear();
    await next.handle({ ...view, fromVersion: '1.6.122', toVersion: '1.6.124' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'update_notice_page', requestId: view.requestId }));
    next.disconnected(); send.mockClear(); await next.handle({ ...view, fromVersion: '1.6.122', toVersion: '1.6.124' });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps first adoption silent and aggregates only each device\'s unacknowledged upgrade range', async () => {
    const index = { format: 1, firstVersion: '1.6.123', sections: [
      { version: '1.6.127', text: '- New notice', details: '- Technical notice', changes: [{ topic: 'notices', title: 'Notices', text: 'New notice' }] },
      { version: '1.6.126', text: '- Reminder fix', details: '- Technical reminder', changes: [{ topic: 'reminders', title: 'Reminders', text: 'Reminder fix' }] },
      { version: '1.6.124', text: '- Warning fix', details: '- Technical warning', changes: [{ topic: 'warnings', title: 'Warnings', text: 'Warning fix' }] },
    ] };
    const original = fs.readFile;
    const read = vi.spyOn(fs, 'readFile').mockImplementation((file: any, options: any) =>
      String(file).endsWith('release-notes.json') ? Promise.resolve(JSON.stringify(index)) : original(file, options));
    const sends = [vi.fn(), vi.fn()];
    const device = async (id: string, version: string, output: ReturnType<typeof vi.fn>) => {
      const c = new UpdateNotices(directory, 'https://router.example.com', id, output, 10); clients.push(c);
      c.registered(true); await c.started(version); return c;
    };
    try {
      (await device('older-device-fixture', '1.6.123', sends[0])).stop();
      (await device('recent-device-fixture', '1.6.126', sends[1])).stop();
      expect(sends[0]).not.toHaveBeenCalled(); expect(sends[1]).not.toHaveBeenCalled();
      const older = await device('older-device-fixture', '1.6.127', sends[0]);
      const recent = await device('recent-device-fixture', '1.6.127', sends[1]);
      expect(sends[0].mock.calls[0][0].page.overview).toMatchObject({ totalGroups: 3, totalItems: 3 });
      expect(sends[1].mock.calls[0][0].page.overview).toMatchObject({ totalGroups: 1, totalItems: 1 });
      await older.handle(ack(sends[0].mock.calls[0][0])); older.stop();
      await recent.handle(ack(sends[1].mock.calls[0][0])); recent.stop();
      sends.forEach(s => s.mockClear());
      await device('older-device-fixture', '1.6.127', sends[0]); await device('recent-device-fixture', '1.6.127', sends[1]);
      expect(sends[0]).not.toHaveBeenCalled(); expect(sends[1]).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  it('fails closed on corrupt or symlinked private state, without overwriting it', async () => {
    const filename = path.join(directory, 'store.json'); const store = new PrivateStore(filename, (v: unknown): v is number => typeof v === 'number');
    await store.write(1); expect(await store.read()).toBe(1);
    await fs.writeFile(filename, '{invalid'); await expect(store.read()).rejects.toThrow('could not be read');
    expect(await fs.readFile(filename, 'utf8')).toBe('{invalid');
    const link = path.join(directory, 'link.json'); await fs.symlink(filename, link);
    await expect(new PrivateStore(link, (_v: unknown): _v is number => true).read()).rejects.toThrow();
    const absent = new PrivateStore(path.join(directory, 'absent.json'), (_v: unknown): _v is number => true); expect(await absent.read()).toBeUndefined();
  });
});

describe('bundled release-note ranges', () => {
  const markdown = '# Changelog\n## [Unreleased]\nLater\n## [1.6.125] - 2026-10-03\n### Added\n- Latest\n## 1.6.124\n- Earlier\n## 1.6.123\n- Baseline\n## 1.6.31–1.6.50 — Source History Summary\nNot a release';
  const summary = '### \u66f4\u65b0\n- \u529f\u80fd\u6539\u5584';
  const taggedSummary = summary.replace('- ', '- [feature|Feature] ');
  const summariesFor = (source: string) => parseReleaseNotes(source).map(s => `## ${s.version}\n${taggedSummary}`).join('\n');
  it('parses canonical headings, rejects duplicates, and ignores prose/fenced fake releases', () => {
    const sections = parseReleaseNotes(markdown + '\n```md\n## 9.9.9\n```');
    expect(sections.map(s => s.version)).toEqual(['1.6.125', '1.6.124', '1.6.123']);
    expect(() => parseReleaseNotes('## 1.0.0\na\n## [1.0.0]\nb')).toThrow('Duplicate');
    expect(() => buildReleaseIndex(markdown, '1.6.126', '')).toThrow('changelog');
  });
  it('joins localized summaries to technical records while preserving legacy text for older unsummarized releases', () => {
    const index = buildReleaseIndex(markdown, '1.6.125', `## 1.6.125\n${taggedSummary}`);
    expect(index.sections[0]).toEqual({ version: '1.6.125', text: summary, details: '### Added\n- Latest',
      changes: [{ topic: 'feature', title: 'Feature', text: '\u529f\u80fd\u6539\u5584' }] });
    expect(index.sections[1]).toEqual({ version: '1.6.124', text: '- Earlier' });
    expect(index.sections).toHaveLength(3);
  });
  it('rejects missing, orphaned, duplicate, unlocalized, verbose, and oversized user summaries', () => {
    const build = (userMarkdown: string) => buildReleaseIndex(markdown, '1.6.125', userMarkdown);
    for (const missing of ['', '## 1.6.124\n' + summary, '## 1.6.125\n']) expect(() => build(missing)).toThrow('user release summary');
    expect(() => build(`## 1.6.125\n${taggedSummary}\n## 1.6.123+build\n${taggedSummary}\n## 1.6.123\n${taggedSummary}`)).toThrow('Duplicate');
    expect(() => build(`## 1.6.125\n${taggedSummary}\n## 1.6.124-rc.1\n${taggedSummary}`)).toThrow('matching changelog');
    expect(() => build('## 1.6.125\n### Update\n- A change')).toThrow('Chinese');
    for (const verbose of [summary + '\nA paragraph', summary + '\n- Extra\n- Extra\n- Extra', '- A change', '### ' + 'x'.repeat(101) + '\n- A change']) {
      expect(() => build('## 1.6.125\n' + verbose)).toThrow('one short heading');
    }
    expect(() => build(`## 1.6.125\n${summary}${'x'.repeat(USER_SUMMARY_BYTES)}`)).toThrow('summary budget');
    expect(() => build(`## 1.6.125\n${summary}`)).toThrow('stable feature tag');
    expect(() => build(`## 1.6.125\n${taggedSummary.replace('|Feature]', '| Feature]')}`)).toThrow('feature metadata');
    expect(() => build(`## 1.6.125\n${taggedSummary}\n## 1.6.124\n${taggedSummary.replace('|Feature]', '|Other]')}`)).toThrow('stable display title');
  });
  it('selects the whole upgrade range and distinguishes missing history from display paging', () => {
    const index = buildReleaseIndex(markdown, '1.6.125', summariesFor(markdown));
    expect(releasePage(index, '1.6.123', '1.6.125')).toMatchObject({ coverage: 'complete', totalSections: 2 });
    expect(releasePage(index, '1.6.100', '1.6.125').coverage).toBe('partial');
    expect(releasePage(undefined, '1.6.123', '1.6.125').coverage).toBe('unavailable');
    const manySource = Array.from({ length: 14 }, (_, n) => `## 1.6.${123 + n}\n- Release`).join('\n');
    const many = buildReleaseIndex(manySource, '1.6.136', summariesFor(manySource));
    const first = releasePage(many, '1.6.123', '1.6.136');
    expect(first).toMatchObject({ coverage: 'complete', totalSections: 13, nextOffset: 10 });
    expect(releasePage(many, '1.6.123', '1.6.136', first.nextOffset).sections).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(20 * 1024);
    expect(() => buildReleaseIndex('## 1.6.123\n' + 'x'.repeat(30 * 1024), '1.6.123', `## 1.6.123\n${taggedSummary}`)).toThrow('budget');
    const combinedSource = ['1.6.125', '1.6.124'].map(v => `## ${v}\n${'x'.repeat(11 * 1024)}`).join('\n');
    const combined = buildReleaseIndex(combinedSource, '1.6.125', summariesFor(combinedSource));
    const combinedPage = releasePage(combined, '1.6.123', '1.6.125');
    expect(combinedPage).toMatchObject({ nextOffset: 1, totalSections: 2 });
    expect(combinedPage.sections).toHaveLength(1);
    expect(combinedPage.sections[0]).toMatchObject({ text: summary, details: 'x'.repeat(11 * 1024) });
    expect(Buffer.byteLength(JSON.stringify(combinedPage))).toBeLessThan(20 * 1024);
    expect(releasePage(combined, '1.6.123', '1.6.125', 1).sections).toHaveLength(1);
    const tightSource = '## 1.6.125\n' + 'x'.repeat(19 * 1024 - 300);
    const tight = buildReleaseIndex(tightSource, '1.6.125', summariesFor(tightSource));
    const tightPage = releasePage(tight, '1.6.123', '1.6.125');
    expect(tightPage.sections).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(tightPage))).toBeLessThan(20 * 1024);
  });
  it('aggregates the full per-device range beyond page one and retains the same overview while paging', () => {
    const source = Array.from({ length: 15 }, (_, n) => `## 1.6.${123 + n}\n- Technical ${n}`).join('\n');
    const users = parseReleaseNotes(source).map(s => `## ${s.version}\n${s.version === '1.6.123'
      ? taggedSummary.replace('feature|Feature', 'older-feature|Older') + ' old-only' : taggedSummary}`).join('\n');
    const index = buildReleaseIndex(source, '1.6.137', users);
    const first = releasePage(index, '1.6.122', '1.6.137');
    expect(first.sections).toHaveLength(10);
    expect(first.sections.some(s => s.version === '1.6.123')).toBe(false);
    expect(first.overview).toMatchObject({ totalItems: 2, totalGroups: 2 });
    expect(first.overview!.groups.some(g => g.topic === 'older-feature')).toBe(true);
    expect(releasePage(index, '1.6.122', '1.6.137', first.nextOffset).overview).toEqual(first.overview);
    const recent = releasePage(index, '1.6.136', '1.6.137');
    expect(recent.overview).toMatchObject({ totalItems: 1, totalGroups: 1 });
    expect(recent.overview!.groups.some(g => g.topic === 'older-feature')).toBe(false);
    expect(first.sections.every(s => s.changes === undefined && !s.text.includes('[feature|'))).toBe(true);
  });
  it('loads old and additive package indexes but rejects invalid or oversized technical details', async () => {
    const read = vi.spyOn(fs, 'readFile');
    try {
      const legacy = { format: 1, firstVersion: '1.6.123', sections: [{ version: '1.6.125', text: '- A feature' }] };
      read.mockResolvedValueOnce(JSON.stringify(legacy)); expect(await loadReleaseIndex()).toEqual(legacy);
      const localized = buildReleaseIndex(markdown, '1.6.125', summariesFor(markdown));
      read.mockResolvedValueOnce(JSON.stringify(localized)); expect(await loadReleaseIndex()).toEqual(localized);
      for (const details of [123, null, { text: '- A feature' }, 'x'.repeat(20 * 1024)]) {
        read.mockResolvedValueOnce(JSON.stringify({ ...legacy, sections: [{ ...legacy.sections[0], details }] }));
        expect(await loadReleaseIndex()).toBeUndefined();
      }
      for (const changes of [null, [], 123, [{ topic: 'feature', title: 'Feature', text: '' }]]) {
        read.mockResolvedValueOnce(JSON.stringify({ ...legacy, sections: [{ ...legacy.sections[0], changes }] }));
        expect(await loadReleaseIndex()).toBeUndefined();
      }
    } finally { read.mockRestore(); }
  });
  it('builds the packaged index from canonical notes and fails a missing release in an isolated fixture', async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'release-build-test-'));
    const packageRoot = path.join(fixture, 'packages', 'cli');
    try {
      await fs.mkdir(path.join(packageRoot, 'dist', 'maintenance'), { recursive: true });
      await fs.mkdir(path.join(packageRoot, 'scripts'));
      await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ version: '1.6.125' }));
      await fs.writeFile(path.join(fixture, 'CHANGELOG.md'), markdown);
      await fs.writeFile(path.join(fixture, 'RELEASE_NOTES_ZH.md'), summariesFor(markdown));
      await fs.copyFile(path.resolve(__dirname, '../../scripts/build-release-notes.cjs'), path.join(packageRoot, 'scripts', 'build-release-notes.cjs'));
      for (const name of ['ReleaseNotes', 'ReleaseOverview', 'Version']) {
        const source = await fs.readFile(path.resolve(__dirname, `../../src/maintenance/${name}.ts`), 'utf8');
        const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } });
        await fs.writeFile(path.join(packageRoot, 'dist', 'maintenance', `${name}.js`), output.outputText);
      }
      const script = path.join(packageRoot, 'scripts', 'build-release-notes.cjs');
      execFileSync(process.execPath, [script]);
      const artifact = JSON.parse(await fs.readFile(path.join(packageRoot, 'dist', 'maintenance', 'release-notes.json'), 'utf8'));
      expect(artifact).toMatchObject({ format: 1, firstVersion: '1.6.123' });
      expect(artifact.sections.map((s: any) => s.version)).toEqual(['1.6.125', '1.6.124', '1.6.123']);
      expect(artifact.sections[0]).toMatchObject({ text: summary, details: '### Added\n- Latest' });
      await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ version: '1.6.126' }));
      expect(() => execFileSync(process.execPath, [script], { stdio: 'pipe' })).toThrow();
      await fs.writeFile(path.join(fixture, 'CHANGELOG.md'), '## 1.6.126\n- New release\n' + markdown);
      expect(() => execFileSync(process.execPath, [script], { stdio: 'pipe' })).toThrow();
      await fs.writeFile(path.join(fixture, 'RELEASE_NOTES_ZH.md'), `## 1.6.126\n${taggedSummary}\n${summariesFor(markdown)}`);
      expect(() => execFileSync(process.execPath, [script], { stdio: 'pipe' })).not.toThrow();
      await fs.unlink(path.join(fixture, 'RELEASE_NOTES_ZH.md'));
      expect(() => execFileSync(process.execPath, [script], { stdio: 'pipe' })).toThrow();
      expect(await loadReleaseIndex()).toBeUndefined();
    } finally { await fs.rm(fixture, { recursive: true, force: true }); }
  });
  it('uses proper SemVer precedence without changing automatic-updater comparison', () => {
    expect(compareNoticeVersions('1.2.3-rc.2', '1.2.3-rc.10')).toBeLessThan(0);
    expect(compareNoticeVersions('1.2.3', '1.2.3-rc.10')).toBeGreaterThan(0);
    expect(compareNoticeVersions('1.2.3+build', '1.2.3')).toBe(0);
    expect(validNoticeVersion('1.2.3-01')).toBe(false); expect(validNoticeVersion('1.02.3')).toBe(false);
    expect(compareNoticeVersions('1.2.3-alpha', '1.2.3-beta')).toBeLessThan(0);
    expect(compareNoticeVersions('1.2.3-1', '1.2.3-a')).toBeLessThan(0);
    expect(compareNoticeVersions('1.2.3-alpha', '1.2.3-alpha.1')).toBeLessThan(0);
    expect(() => compareNoticeVersions('invalid', '1.2.3')).toThrow();
  });
});

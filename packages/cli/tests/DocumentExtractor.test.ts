import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { extractDocument } from '../src/files/DocumentExtractor';
import { parseDocument } from '../src/files/DocumentWorker';
import { pdfFixture, zipFixture } from './helpers/documentFixtures';

describe.each(['worker', 'parser'])('bounded document extraction (%s)', mode => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-document-test-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  async function extract(name: string, content: string | Buffer) {
    const filename = path.join(root, 'original'); await fs.writeFile(filename, content);
    // PDF.js uses native ESM import; exercise it in the real worker, not Vitest's VM.
    return mode === 'parser' && !name.endsWith('.pdf') ? parseDocument(filename, name) : extractDocument(filename, name, new AbortController().signal);
  }

  it.each(['report.txt', 'table.csv', 'settings.json', 'script.py', 'config.yaml'])('extracts inert text from %s', async name => {
    const result = await extract(name, 'Hello world\n=SUM(A1:A2)\n');
    expect(result.status).toBe('parsed'); expect(result.text).toContain('=SUM(A1:A2)');
  });
  it('supports BOM-marked UTF-16 and rejects undecodable text', async () => {
    expect((await extract('report.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hello', 'utf16le')]))).text).toBe('Hello');
    await expect(extract('bad.txt', Buffer.from([0xff, 0xff]))).rejects.toThrow();
  });
  it('reads a full document even when the filesystem returns short reads', async () => {
    if (mode !== 'parser') return;
    const open = fs.open.bind(fs);
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await (open as any)(...args);
      const read = handle.read.bind(handle);
      handle.read = (buffer: Buffer, offset: number, length: number, position: number) => read(buffer, offset, Math.min(length, 3), position);
      return handle;
    });
    try { expect((await extract('short.txt', 'complete document')).text).toBe('complete document'); }
    finally { spy.mockRestore(); }
  });
  it('reports UTF-16 to UTF-8 expansion truncation without a broken trailing character', async () => {
    const text = '\u4e2d'.repeat(800_000);
    const result = await extract('large.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    expect(result.status).toBe('partial'); expect(result.text).not.toContain('\ufffd');
    expect(Buffer.byteLength(result.text!)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
  it('truncates large text without returning the whole file or blocking control timers', async () => {
    let ticks = 0; const timer = setInterval(() => ticks++, 1);
    try {
      const result = await extract('large.log', Buffer.alloc(20 * 1024 * 1024, 65));
      expect(result.status).toBe('partial'); expect(Buffer.byteLength(result.text!)).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(ticks).toBeGreaterThan(0);
    } finally { clearInterval(timer); }
  });
  it.each(['archive.zip', 'legacy.doc', 'legacy.xls', 'movie.mp4', 'photo.png'])('retains unsupported originals without claiming to parse %s', async name => {
    expect((await extract(name, 'not interpreted')).status).toBe('unsupported');
  });
  it('detects binary content disguised as text', async () => {
    expect((await extract('binary.txt', Buffer.from([65, 0, 66]))).status).toBe('unsupported');
  });
  it('extracts textual PDF with page provenance and bounds page count', async () => {
    const result = await extract('document.pdf', pdfFixture('Hello PDF', 101));
    expect(result.status).toBe('partial'); expect(result.text).toContain('Page 100'); expect(result.text).not.toContain('Page 101'); expect(result.text).toContain('Hello PDF');
  });
  it('reports scan-only/empty PDFs without inventing OCR output', async () => {
    const result = await extract('scanned.pdf', pdfFixture(''));
    expect(result.status).toBe('unsupported'); expect(result.detail).toContain('OCR'); expect(result.text).toBeUndefined();
  });
  it('rejects corrupt PDFs and ZIP documents', async () => {
    await expect(extract('broken.pdf', 'broken')).rejects.toThrow();
    await expect(extract('broken.docx', 'broken')).rejects.toThrow();
  });
  it('extracts DOCX main text and explicitly reports omitted sections', async () => {
    const result = await extract('report.docx', zipFixture([
      ['word/document.xml', '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Hello &amp; DOCX</w:t></w:r></w:p></w:body></w:document>'],
      ['word/header1.xml', '<w:t>Not included</w:t>'],
    ]));
    expect(result.status).toBe('partial'); expect(result.text).toContain('Hello & DOCX'); expect(result.text).not.toContain('Not included');
  });
  it('extracts XLSX sheet/cell provenance and cached formula values without evaluating formulas', async () => {
    const result = await extract('book.xlsx', zipFixture([
      ['xl/workbook.xml', '<workbook><sheets><sheet name="Results" r:id="r1"/></sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>'],
      ['xl/sharedStrings.xml', '<sst><si><t>Value</t></si></sst>'],
      ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><f>2+3</f><v>5</v></c></row></sheetData></worksheet>'],
    ]));
    expect(result.status).toBe('parsed'); expect(result.text).toContain('Sheet: "Results"'); expect(result.text).toContain('A1\tValue'); expect(result.text).toContain('B1\t5 [cached formula value');
  });
  it('rejects DTD/entity declarations, ZIP traversal, duplicate entries, and macros', async () => {
    for (const entries of [
      [['word/document.xml', '<!DOCTYPE x [<!ENTITY data SYSTEM "file:///etc/passwd">]><x>&data;</x>']],
      [['../outside.xml', 'test'], ['word/document.xml', '<x/>']],
      [['word/document.xml', '<x/>'], ['word/document.xml', '<x/>']],
      [['word/document.xml', '<x/>'], ['word/vbaProject.bin', 'macro']],
    ] as Array<Array<[string, string]>>) await expect(extract('unsafe.docx', zipFixture(entries))).rejects.toThrow();
  });
  it('rejects archive expansion bombs before inflating XML', async () => {
    await expect(extract('bomb.docx', zipFixture([['word/document.xml', Buffer.alloc(41 * 1024 * 1024, 65)]]))).rejects.toThrow('expansion');
  });
  it('honors cancellation and parser deadlines', async () => {
    const filename = path.join(root, 'original'); await fs.writeFile(filename, 'text');
    const abort = new AbortController(); abort.abort();
    await expect(extractDocument(filename, 'file.txt', abort.signal)).rejects.toThrow('cancelled');
    await expect(extractDocument(filename, 'file.txt', new AbortController().signal, 1)).rejects.toThrow('time limit');
  });
  it('does not follow a symlink passed as parser input', async () => {
    const filename = path.join(root, 'file'); await fs.writeFile(filename, 'secret'); await fs.symlink(filename, path.join(root, 'link'));
    await expect(extractDocument(path.join(root, 'link'), 'file.txt', new AbortController().signal)).rejects.toThrow();
  });
});

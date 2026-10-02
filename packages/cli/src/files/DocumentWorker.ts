import { isMainThread, parentPort, workerData } from 'worker_threads';
import fs, { constants } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { ExtractionResult } from './FileInbox';

const OUTPUT_BYTES = 2 * 1024 * 1024;
const XML_BYTES = 16 * 1024 * 1024;
const ZIP_BYTES = 40 * 1024 * 1024;
const LIMIT = Symbol('output limit');

class Output {
  private chunks: string[] = [];
  private bytes = 0;
  add(value: string): void {
    const encoded = Buffer.from(value);
    const remaining = OUTPUT_BYTES - this.bytes;
    if (encoded.length > remaining) {
      // Streaming decode avoids introducing a replacement character at the boundary.
      this.chunks.push(new TextDecoder().decode(encoded.subarray(0, remaining), { stream: true }));
      this.bytes = OUTPUT_BYTES; throw LIMIT;
    }
    this.chunks.push(value); this.bytes += encoded.length;
  }
  text(): string { return this.chunks.join(''); }
}

function parseXml(xml: string, handlers: { open?: (tag: any) => void; close?: (name: string) => void; text?: (text: string) => void }): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD and entity declarations are not supported.');
  const parser = require('sax').parser(true, { strictEntities: true });
  let depth = 0; let nodes = 0;
  parser.onopentag = (tag: any) => {
    if (++depth > 100 || ++nodes > 300_000) throw new Error('XML structure exceeds the parser limit.');
    handlers.open?.(tag);
  };
  parser.onclosetag = (tag: string) => { handlers.close?.(tag); depth--; };
  parser.ontext = (text: string) => handlers.text?.(text);
  parser.oncdata = () => { throw new Error('CDATA is not supported in office documents.'); };
  parser.write(xml).close();
}

async function zipEntries(data: Buffer): Promise<{ names: string[]; read(name: string): Promise<string>; close(): void }> {
  const yauzl = require('yauzl');
  const zip: any = await new Promise((resolve, reject) => yauzl.fromBuffer(data, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error: Error, value: unknown) => error ? reject(error) : resolve(value)));
  const entries = new Map<string, any>();
  let expanded = 0;
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', (entry: any) => {
      expanded += entry.uncompressedSize;
      if (entries.size >= 2_000 || expanded > ZIP_BYTES || entry.isEncrypted()
        || entries.has(entry.fileName) || (entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) {
        zip.close(); reject(new Error('Office archive is encrypted, duplicated, symlinked, or exceeds expansion limits.')); return;
      }
      entries.set(entry.fileName, entry); zip.readEntry();
    });
    zip.readEntry();
  });
  let readBytes = 0;
  return {
    names: [...entries.keys()], close: () => zip.close(),
    async read(name: string): Promise<string> {
      const entry = entries.get(name);
      if (!entry || entry.uncompressedSize > XML_BYTES) throw new Error('Required office XML is missing or exceeds 16 MiB.');
      const stream: any = await new Promise((resolve, reject) => zip.openReadStream(entry, (error: Error, value: unknown) => error ? reject(error) : resolve(value)));
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of stream) {
        length += chunk.length; readBytes += chunk.length;
        if (length > XML_BYTES || readBytes > ZIP_BYTES) { stream.destroy(); throw new Error('Office archive exceeded the actual expansion limit.'); }
        chunks.push(chunk);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    },
  };
}

async function office(data: Buffer, kind: string): Promise<ExtractionResult> {
  const zip = await zipEntries(data);
  const output = new Output();
  let partial = false;
  let detail = '';
  try {
    if (zip.names.some(name => /vbaProject\.bin$/i.test(name))) throw new Error('Macro-enabled office content is not supported.');
    if (kind === '.docx') {
      let inText = false;
      parseXml(await zip.read('word/document.xml'), {
        open: tag => { if (tag.name === 'w:t') inText = true; if (tag.name === 'w:tab') output.add('\t'); if (tag.name === 'w:br') output.add('\n'); },
        close: name => { if (name === 'w:t') inText = false; if (name === 'w:p') output.add('\n'); if (name === 'w:tc') output.add('\t'); },
        text: text => { if (inText) output.add(text); },
      });
      partial = zip.names.some(name => /^word\/(header|footer|footnotes|endnotes|comments)/.test(name));
      detail = 'DOCX main document text only; layout, images, headers, footers, comments and notes are not extracted.';
    } else {
      const sheets: Array<{ name: string; id: string }> = [];
      parseXml(await zip.read('xl/workbook.xml'), { open: tag => {
        if (tag.name.split(':').pop() === 'sheet') sheets.push({ name: tag.attributes.name, id: tag.attributes['r:id'] });
      } });
      const targets = new Map<string, string>();
      parseXml(await zip.read('xl/_rels/workbook.xml.rels'), { open: tag => {
        if (tag.attributes.TargetMode === 'External') return;
        const target = tag.attributes.Target;
        if (typeof target === 'string') {
          const normalized = target.startsWith('/xl/') ? target.slice(1) : path.posix.normalize(`xl/${target}`);
          if (/^xl\/worksheets\/[a-zA-Z0-9_-]+\.xml$/.test(normalized)) targets.set(tag.attributes.Id, normalized);
        }
      } });
      const shared: string[] = []; let sharedText = ''; let inText = false; let sharedBytes = 0;
      if (zip.names.includes('xl/sharedStrings.xml')) parseXml(await zip.read('xl/sharedStrings.xml'), {
        open: tag => { const name = tag.name.split(':').pop(); if (name === 'si') sharedText = ''; if (name === 't') inText = true; },
        close: tag => {
          const name = tag.split(':').pop(); if (name === 't') inText = false;
          if (name === 'si') { sharedBytes += Buffer.byteLength(sharedText); if (sharedBytes > OUTPUT_BYTES || shared.length >= 50_000) throw new Error('Spreadsheet shared strings exceed the parser limit.'); shared.push(sharedText); }
        },
        text: text => { if (inText) sharedText += text; },
      });
      let cells = 0;
      if (sheets.length > 50) partial = true;
      for (const sheet of sheets.slice(0, 50)) {
        const target = targets.get(sheet.id);
        if (!target) { partial = true; continue; }
        output.add(`Sheet: ${JSON.stringify(sheet.name)}\n`);
        let address = ''; let type = ''; let value = ''; let capture = false; let formula = false;
        parseXml(await zip.read(target), {
          open: tag => {
            const name = tag.name.split(':').pop();
            if (name === 'c') { address = tag.attributes.r ?? '?'; type = tag.attributes.t; value = ''; formula = false; }
            if (name === 'v' || name === 't') capture = true;
            if (name === 'f') formula = true;
          },
          text: text => { if (capture) value += text; },
          close: tag => {
            const name = tag.split(':').pop();
            if (name === 'v' || name === 't') capture = false;
            if (name === 'c') {
              if (++cells > 10_000) throw LIMIT;
              const text = type === 's' ? shared[Number(value)] ?? '[unavailable shared string]' : value;
              output.add(`${address}\t${text}${formula ? ' [cached formula value; not recalculated]' : ''}\n`);
            }
          },
        });
      }
      detail = 'XLSX values with sheet names and cell addresses. Formulas use cached values only; external links, macros, charts and formatting are not evaluated.';
    }
  } catch (error) {
    if (error !== LIMIT) throw error;
    partial = true; detail += ' Extraction stopped at the 2 MiB output or 10,000 cell limit.';
  } finally { zip.close(); }
  return { status: partial ? 'partial' : 'parsed', text: output.text(), detail: detail || 'Partial office text extraction.' };
}

async function pdf(data: Buffer): Promise<ExtractionResult> {
  // Native dynamic import is required for PDF.js ESM under the CommonJS build.
  const nativeImport = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
  const pdfjs = await nativeImport(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  const task = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, disableAutoFetch: true, disableStream: true, useWorkerFetch: false });
  // With no password callback, PDF.js rejects promptly with PasswordException.
  const document = await task.promise;
  const output = new Output(); let partial = document.numPages > 100; let characters = 0;
  try {
    for (let index = 1; index <= Math.min(document.numPages, 100); index++) {
      output.add(`Page ${index}\n`);
      const page = await document.getPage(index);
      const reader = page.streamTextContent().getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          for (const item of value.items) if (typeof item.str === 'string') { characters += item.str.trim().length; output.add(item.str + (item.hasEOL ? '\n' : ' ')); }
        }
      } finally { await reader.cancel(); page.cleanup(); }
      output.add('\n');
    }
  } catch (error) { if (error !== LIMIT) throw error; partial = true; }
  finally { await document.destroy(); }
  if (!characters) return { status: 'unsupported', detail: 'No extractable PDF text was found. Scanned PDFs require OCR, which is not included.' };
  return { status: partial ? 'partial' : 'parsed', text: output.text(), detail: `${partial ? 'Partial PDF extraction (100 pages / 2 MiB maximum).' : 'PDF text extracted with page numbers.'} Images, forms, annotations and layout are not interpreted.` };
}

export async function parseDocument(filename: string, name: string): Promise<ExtractionResult> {
  const handle = await fs.promises.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let data: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Invalid parser input size.');
    const buffer = Buffer.alloc(20 * 1024 * 1024 + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > 20 * 1024 * 1024) throw new Error('Invalid parser input size.');
    data = buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return pdf(data);
  if (ext === '.docx' || ext === '.xlsx') return office(data, ext);
  const textTypes = new Set(['.txt', '.md', '.csv', '.json', '.jsonl', '.yaml', '.yml', '.log', '.xml', '.html', '.css', '.js', '.ts', '.py', '.c', '.cpp', '.h', '.rs', '.go', '.sh', '.toml', '.ini', '.sql']);
  if (!textTypes.has(ext)) return { status: 'unsupported', detail: 'Original saved. No built-in parser for this file type; automatic archive extraction, OCR and legacy Office formats are not supported.' };
  let partial = data.length > OUTPUT_BYTES;
  const sample = data.subarray(0, OUTPUT_BYTES);
  const encoding = sample[0] === 0xff && sample[1] === 0xfe ? 'utf-16le' : sample[0] === 0xfe && sample[1] === 0xff ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true }).decode(sample, { stream: partial });
  if (text.includes('\u0000')) return { status: 'unsupported', detail: 'This file appears to contain binary data. Original saved without a text preview.' };
  const output = new Output();
  try { output.add(text); } catch (error) { if (error !== LIMIT) throw error; partial = true; }
  return { status: partial ? 'partial' : 'parsed', text: output.text(), detail: `${encoding} text${partial ? ' truncated to a bounded 2 MiB preview; the complete original is retained' : ' extracted'}.` };
}

if (!isMainThread && workerData?.kind === 'remote-cli-document') {
  // These guards prevent parser-initiated network requests; this is not an OS sandbox.
  const deny = () => { throw new Error('Document parser network access is disabled.'); };
  for (const name of ['http', 'https']) { const module = require(name); module.request = deny; module.get = deny; }
  const net = require('net'); net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;
  globalThis.fetch = async () => { throw new Error('Document parser network access is disabled.'); };
  void parseDocument(workerData.filename, workerData.name).then(result => parentPort!.postMessage(result), error => {
    parentPort!.postMessage({ error: error instanceof Error ? error.message.slice(0, 300) : 'Document parsing failed.' });
  });
}

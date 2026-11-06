import { describe, expect, it } from 'vitest';
import path from 'path';
import { publicationFor, selectedWorker, validSnapshotRecord, visibleRecord, publicReference, duplicateWorker } from '../../src/output/OutputPublication';
import type { SnapshotContext } from '../../src/output/OutputSnapshots';

const cwd = path.resolve('synthetic-worker');
const file = path.join(cwd, 'report.txt');
const context: SnapshotContext = { owner: 'owner', cwd, messageId: 'command', threadId: 'thread', taskId: 'worker', generation: 1, source: 'worker' };
function record() {
  return { reference: { id: 'a'.repeat(64), sha256: 'b'.repeat(64), messageId: 'command', threadId: 'thread', taskId: 'worker',
    generation: 1, name: 'report.txt', source: 'worker' as const, size: 5, expiresAt: Date.now() + 100_000 },
  identity: '1:2', snapshotIdentity: '1:3', publication: publicationFor(context, cwd, file, '1:2:5:123') };
}

describe('private output publication contracts', () => {
  it('keeps legacy receipts public, projects only wire fields and validates new private origins', () => {
    const value: any = record();
    expect(validSnapshotRecord(value)).toBe(true); expect(visibleRecord(value)).toBe(false);
    value.reference.discoveryIncomplete = false; value.reference.privatePath = 'private-sentinel';
    expect(publicReference(value.reference).discoveryIncomplete).toBe(false);
    expect(JSON.stringify(publicReference(value.reference))).not.toContain('private-sentinel');
    delete value.publication; expect(validSnapshotRecord(value)).toBe(true); expect(visibleRecord(value)).toBe(true);
    expect(publicationFor({ ...context, source: 'workspace' }, cwd, file, 'version')).toEqual({ version: 1, visible: true });
  });

  it.each([
    (v: any) => v.reference.id = 'bad', (v: any) => v.identity = '', (v: any) => v.snapshotIdentity = 1,
    (v: any) => v.publication = null, (v: any) => v.publication.version = 2,
    (v: any) => v.publication.visible = 'true', (v: any) => delete v.publication.worker,
    (v: any) => v.publication.worker = null, (v: any) => v.publication.worker.owner = 1,
    (v: any) => v.publication.worker.owner = 'x'.repeat(201), (v: any) => v.publication.worker.messageId = '',
    (v: any) => v.publication.worker.taskId = 'foreign', (v: any) => v.publication.worker.threadId = 'foreign',
    (v: any) => v.publication.worker.generation = -1, (v: any) => v.publication.worker.generation = 2,
    (v: any) => v.publication.worker.cwd = 'relative', (v: any) => v.publication.worker.file = 'relative',
    (v: any) => v.publication.worker.version = '', (v: any) => v.reference.messageId = 'foreign',
    (v: any) => { v.publication.visible = true; v.publication.worker.owner = ''; },
    (v: any) => { v.publication.visible = true; delete v.publication.worker; },
  ])('rejects malformed publication receipts %#', mutate => {
    const value = record(); mutate(value); expect(validSnapshotRecord(value)).toBe(false);
  });

  it('holds missing-owner captures privately and rejects malformed source contexts', () => {
    expect(publicationFor({ ...context, owner: undefined }, cwd, file, 'version').worker?.owner).toBe('');
    expect(() => publicationFor({ ...context, owner: 'x'.repeat(201) }, cwd, file, 'v')).toThrow();
    expect(() => publicationFor(context, 'relative', file, 'v')).toThrow();
    expect(() => publicationFor(context, cwd, 'relative', 'v')).toThrow();
  });

  it('deduplicates only the same private worker identity and versions', () => {
    const first = record();
    expect(duplicateWorker(first, first.publication)).toBe(true);
    for (const [key, value] of Object.entries({ owner: 'other', messageId: 'other', threadId: 'other', generation: 2,
      taskId: 'other', file: path.join(cwd, 'other'), version: 'other' })) {
      expect(duplicateWorker(first, { ...first.publication, worker: { ...first.publication.worker!, [key]: value } })).toBe(false);
    }
    expect(duplicateWorker(first, { version: 1, visible: true })).toBe(false);
  });

  it('selects only scoped original paths or exact export provenance, never basenames', () => {
    const first = record(); const parent = { ...context, taskId: 'parent', source: 'workspace' as const };
    expect(selectedWorker([first], file, parent)).toBe(first);
    expect(selectedWorker([first], path.join(path.dirname(cwd), 'report.txt'), parent)).toBeUndefined();
    expect(selectedWorker([{ ...first, reference: { ...first.reference, expiresAt: 0 } }], file, parent)).toBeUndefined();
    const exported = { file: path.join(path.dirname(cwd), 'export'), path: 'report.txt', taskId: 'worker', bytes: 5, sha256: first.reference.sha256 };
    expect(selectedWorker([first], exported.file, { ...parent, messageId: 'later' }, exported)).toBe(first);
    expect(selectedWorker([first], exported.file, parent, { ...exported, path: path.join('..', 'report.txt') })).toBeUndefined();
    expect(() => selectedWorker([first, record()], file, parent)).toThrow('ambiguous');
  });
});

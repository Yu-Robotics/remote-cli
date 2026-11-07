import { describe, expect, it, vi } from 'vitest';
import { parseAttachmentHints } from '../../src/output/Protocol';
import { OutputDiagnostics } from '../../src/output/OutputDiagnostics';

describe('bounded private attachment diagnostics', () => {
  it.each([['missing', { code: 'ENOENT' }], ['permission', { code: 'EACCES' }], ['permission', { code: 'EPERM' }],
    ['policy', new Error('Output export policy denied this file.')], ['limit', new Error('Output exceeds the configured limit.')],
    ['quota', new Error('Output snapshot quota reached.')], ['changed', new Error('Verified export changed.')],
    ['storage', new Error('Output capture stopped.')], ['unknown', new Error('private diagnostic sentinel')],
    ['unknown', undefined], ['unknown', new Error('__proto__')]])('classifies %s without copying private error text', (reason, error) => {
    const report = vi.fn(); new OutputDiagnostics(report).failure('private-request-sentinel', 'private-path-sentinel.csv', error);
    expect(report).toHaveBeenCalledWith({ event: 'attachment_preparation_failed', reason, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), pathHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(report.mock.calls)).not.toContain('sentinel');
  });
  it('bounds records and does not fail execution if diagnostics are unavailable', () => {
    const report = vi.fn(); const log = new OutputDiagnostics(report);
    for (let i = 0; i < 100; i++) log.failure('request', `path-${i}`, new Error('private'));
    expect(report).toHaveBeenCalledTimes(16);
    expect(() => new OutputDiagnostics(() => { throw Error('unavailable'); }).failure('request', 'file', null)).not.toThrow();
  });
});


describe('display-only attachment hint schema', () => {
  it('accepts bounded basenames, deduplicates and copies them without file access', () => {
    const names = ['report.csv', 'source.go', 'report.csv'];
    const value = parseAttachmentHints({ generation: 0, names });
    names[0] = 'changed.csv';
    expect(value).toEqual({ generation: 0, names: ['report.csv', 'source.go'] });
  });
  it.each([null, {}, { generation: -1, names: ['a'] }, { generation: 1.1, names: ['a'] },
    { generation: 0, names: [] }, { generation: 0, names: Array(17).fill('a') },
    ...['', 'a/b.csv', 'a\\b.csv', '\u0000.csv', '\u202e.csv', 'a'.repeat(121)].map(name => ({ generation: 0, names: [name] }))])
    ('rejects malformed or path-bearing hints (%j)', value => { expect(parseAttachmentHints(value)).toBeUndefined(); });
});

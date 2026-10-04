import { describe, expect, it } from 'vitest';
import { ClaudeStderrFilter, filterClaudeStderr } from '../src/executor/claude/ClaudeStderrFilter';

const prefix = '[claude-code:unrecognized_model]';
const warning = `${prefix} ${JSON.stringify({ model: 'Kimi Code - Coding Plan/kimi-for-coding', query_source: 'sdk' })}`;
const sources = ['sdk', 'generate_session_title'];
const warningFor = (source: string) => `${prefix} ${JSON.stringify({ model: 'custom-provider/model', query_source: source })}`;

describe('Claude model diagnostic filter', () => {
  it.each(sources)('suppresses recognized %s records, including CRLF and reordered JSON', source => {
    const warning = warningFor(source);
    expect(filterClaudeStderr(`${warning}\r\n`)).toBe('');
    expect(filterClaudeStderr(`${prefix}\t { "query_source": "${source}", "model": "custom-provider/model" }\n`)).toBe('');
    expect(filterClaudeStderr(`before\n${warning}\n${warning}\nafter\n`)).toBe('before\nafter\n');
  });

  it.each(sources)('handles every byte split of %s records without corrupting adjacent UTF-8 stderr', source => {
    const warning = warningFor(source);
    const input = Buffer.from(`Error: request failed ⚠️\n${warning}\nretry later\n`);
    for (let split = 0; split <= input.length; split++) {
      const filter = new ClaudeStderrFilter();
      expect(filter.write(input.subarray(0, split)) + filter.write(input.subarray(split)) + filter.flush())
        .toBe('Error: request failed ⚠️\nretry later\n');
    }
    const filter = new ClaudeStderrFilter();
    expect([...input].map(byte => filter.write(Buffer.from([byte]))).join('') + filter.flush())
      .toBe('Error: request failed ⚠️\nretry later\n');
  });

  it.each([
    `${prefix} {invalid JSON`,
    `${prefix} null`,
    `${prefix} {"model":"custom","query_source":"cli"}`,
    `${prefix} {"model":"","query_source":"sdk"}`,
    `${prefix} {"model":42,"query_source":"sdk"}`,
    `${prefix} {"model":"custom","query_source":"sdk","error":"request failed"}`,
    `${prefix} {"model":"custom","query_source":"generate_session_title","error":"request failed"}`,
    `${prefix} {"model":42,"query_source":"generate_session_title"}`,
    `${prefix} {"model":"custom"}`,
    `${prefix}[]`,
    '[claude-code:authentication_error] {"error":"Login required"}',
    '[claude-code:api_error] {"status":401,"error":"Unauthorized"}',
    'API Error: 429 {"error":{"type":"rate_limit_error","message":"Quota exhausted"}}',
    'API Error: 503 {"error":{"type":"api_error","message":"Provider unavailable"}}',
    `${warning} Error: request failed`,
    `${warningFor('generate_session_title')} Error: request failed`,
    `Error context: ${warning}`,
  ])('retains unexpected or potentially meaningful stderr verbatim: %s', line => {
    expect(filterClaudeStderr(line)).toBe(line);
    expect(filterClaudeStderr(`${line}\n`)).toBe(`${line}\n`);
  });

  it('forwards ordinary partial lines immediately, without recognizing embedded diagnostics', () => {
    const filter = new ClaudeStderrFilter();
    expect(filter.write('Error: authentication failed')).toBe('Error: authentication failed');
    expect(filter.write(` ${warning}`)).toBe(` ${warning}`);
    expect(filter.write('\n')).toBe('\n');
    expect(filter.write(`${warning}\n`)).toBe('');
    expect(filter.flush()).toBe('');
  });

  it.each(sources)('flushes unfinished records once while suppressing a final %s record without newline', source => {
    const warning = warningFor(source);
    const filter = new ClaudeStderrFilter();
    expect(filter.write(warning)).toBe('');
    expect(filter.flush()).toBe('');
    expect(filter.flush()).toBe('');
    expect(filter.write('[claude-code:unrecognized_')).toBe('');
    expect(filter.flush()).toBe('[claude-code:unrecognized_');
    expect(filter.flush()).toBe('');
  });

  it('releases oversized candidates and resumes filtering at the next line boundary', () => {
    const filter = new ClaudeStderrFilter();
    const oversized = `${prefix} ${'x'.repeat(8192)}`;
    expect(filter.write(oversized)).toBe(oversized);
    expect(filter.write(`tail\n${warning}\n`)).toBe('tail\n');
    expect(filter.flush()).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { agyDispatchConflicts, agyValidationRejection } from '../../src/executor/agy/AgyValidationRejection';
import type { TranscriptRecord } from '../../src/scheduling/agy/transcript';

const P = '/synthetic/workspace/x.txt';
const missingPath = "invalid arguments:\n- missing property 'Path'";
const planner = (name: string, args?: unknown): TranscriptRecord => ({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE',
  status: 'DONE', tool_calls: [args === undefined ? { name } : { name, args }] });
const receipt = (error: string, overrides: Record<string, unknown> = {}): TranscriptRecord => ({ step_index: 2, source: 'MODEL',
  type: 'GENERIC', status: 'INVALID', error,
  content: 'Created At: 2026-01-01T00:00:00Z\nCompleted At: 2026-01-01T00:00:00Z\nError invalid tool call: ' + error,
  ...overrides } as TranscriptRecord);
const accept = (name: string, args: unknown, error: string, version = '1.5.13') =>
  agyValidationRejection(version, planner(name, args), receipt(error));

/** Rows observed from native AGY 1.5.13 with a synthetic provider; none had hooks or ACP dispatch. */
const NATIVE: Array<[string, unknown, string]> = [
  ['read_file', undefined, "- missing property 'Path'"],
  ['read_file', { StartLine: 1 }, "- missing property 'Path'"],
  ['read_file', { Path: 123 }, "- at '/Path': got number, want string"],
  ['read_file', { Path: P, StartLine: '1' }, "- at '/StartLine': got string, want integer"],
  ['read_file', { Path: P, StartLine: 1.5 }, "- at '/StartLine': got number, want integer"],
  ['read_file', { Path: null }, "- at '/Path': got null, want string"],
  ['read_file', { Path: P, EndLine: true }, "- at '/EndLine': got boolean, want integer"],
  ['read_file', { Path: [P] }, "- at '/Path': got array, want string"],
  ['read_file', { Path: { a: 1 } }, "- at '/Path': got object, want string"],
  ['read_file', { Alpha: 2, Path: P, Zeta: 1 }, "- additional properties 'Alpha', 'Zeta' not allowed"],
  ['read_file', { A: 1, B: 1, Path: '/p', _: 1, a: 1, b: 1 }, "- additional properties '_', 'a', 'b', 'A', 'B' not allowed"],
  ['read_file', { StartLine: 'x', Zeta: 1 },
    "- missing property 'Path'\n- at '/StartLine': got string, want integer\n- additional properties 'Zeta' not allowed"],
  ['read_file', { ByteOffset: 'z', EndLine: 'y', Path: 1, StartLine: 'x' }, "- at '/ByteOffset': got string, want integer\n"
    + "- at '/EndLine': got string, want integer\n- at '/Path': got number, want string\n- at '/StartLine': got string, want integer"],
  ['write_file', undefined, "- missing properties 'Path', 'Content'"],
  ['write_file', { Content: 'c' }, "- missing property 'Path'"],
  ['write_file', { Path: P }, "- missing property 'Content'"],
  ['write_file', { Content: 1, Path: P }, "- at '/Content': got number, want string"],
  ['write_file', { Append: 'yes', Content: 'c', Path: P }, "- at '/Append': got string, want boolean"],
  ['write_file', { Content: 'c', Path: '' }, "- at '/Path': minLength: got 0, want 1"],
  ['write_file', { Content: 'c', Extra: 1, Path: P }, "- additional properties 'Extra' not allowed"],
  ['write_file', { Content: 2, Extra: 1 },
    "- missing property 'Path'\n- at '/Content': got number, want string\n- additional properties 'Extra' not allowed"],
  ['write_file', { Append: 'y', Content: 3, Overwrite: 'n' }, "- missing property 'Path'\n- at '/Append': got string, want boolean\n"
    + "- at '/Content': got number, want string\n- at '/Overwrite': got string, want boolean"],
  ['edit_file', undefined, "- missing properties 'Path', 'Target', 'Replacement'"],
  ['edit_file', { Path: P }, "- missing properties 'Target', 'Replacement'"],
  ['edit_file', { Path: P, Target: 'a' }, "- missing property 'Replacement'"],
  ['edit_file', { Path: P, Replacement: 'b', Target: '' }, "- at '/Target': minLength: got 0, want 1"],
  ['edit_file', { Path: P, Replacement: 'b', Target: 1 }, "- at '/Target': got number, want string"],
  ['edit_file', { Bogus: 1, Replacement: 'b', Target: 3 },
    "- missing property 'Path'\n- at '/Target': got number, want string\n- additional properties 'Bogus' not allowed"],
  ['edit_file', { Path: '', Replacement: 1, Target: '' }, "- at '/Path': minLength: got 0, want 1\n"
    + "- at '/Replacement': got number, want string\n- at '/Target': minLength: got 0, want 1"],
  ['search_web', undefined, "- missing property 'query'"],
  ['search_web', { query: 1 }, "- at '/query': got number, want string"],
  ['search_web', { domain: 2, query: 'q' }, "- at '/domain': got number, want string"],
  ['search_web', { Query: 'q' }, "- missing property 'query'\n- additional properties 'Query' not allowed"],
  ['search_web', { domain: 'd' }, "- missing property 'query'"],
];

describe('agyValidationRejection', () => {
  it.each(NATIVE)('accepts the native 1.5.13 rejection of %s %j', (name, args, lines) => {
    expect(accept(name, args, 'invalid arguments:\n' + lines)).toEqual({ tool: name, args: args ?? {} });
  });
  it('accepts additional properties in any native order, but only the exact set', () => {
    const args = { A: 1, Path: P, b: 1 };
    expect(accept('read_file', args, "invalid arguments:\n- additional properties 'b', 'A' not allowed")).toBeDefined();
    expect(accept('read_file', args, "invalid arguments:\n- additional properties 'A', 'b' not allowed")).toBeDefined();
    for (const list of ["'A'", "'A', 'b', 'A'", "'A', 'b', 'c'", "'A','b'", "'A', 'B'"]) {
      expect(accept('read_file', args, `invalid arguments:\n- additional properties ${list} not allowed`)).toBeUndefined();
    }
  });

  it.each([
    ['unknown version', undefined],
    ['newer version', '1.5.14'],
    ['prefixed version', 'v1.5.13'],
  ])('rejects %s', (_name, version) => {
    expect(agyValidationRejection(version, planner('read_file'), receipt(missingPath))).toBeUndefined();
  });
  it.each(['run_command', 'manage_task', 'schedule', 'ask_question', 'define_subagent', 'invoke_subagent', 'manage_subagents',
    'send_message', 'swarm', 'run_workflow', 'view_file', 'toString', '__proto__', 'mcp_fixture_read_file'])(
    'excludes the unmodeled tool %s', name => {
      expect(accept(name, {}, missingPath)).toBeUndefined();
    });
  it.each<[string, string, unknown, string]>([
    ['valid arguments', 'read_file', { Path: P }, missingPath],
    ['valid arguments with an empty unconstrained string', 'search_web', { query: '' }, "invalid arguments:\n- missing property 'query'"],
    ['a different missing property', 'read_file', {}, "invalid arguments:\n- missing property 'path'"],
    ['singular form for two missing', 'write_file', {}, "invalid arguments:\n- missing property 'Path'\n- missing property 'Content'"],
    ['missing in another order', 'write_file', {}, "invalid arguments:\n- missing properties 'Content', 'Path'"],
    ['an omitted violation', 'read_file', { StartLine: 'x' }, missingPath],
    ['an extra violation line', 'read_file', {}, missingPath + "\n- at '/Path': got null, want string"],
    ['type errors in another order', 'read_file', { EndLine: 'y', Path: P, StartLine: 'x' },
      "invalid arguments:\n- at '/StartLine': got string, want integer\n- at '/EndLine': got string, want integer"],
    ['a wrong reported type', 'read_file', { Path: 1 }, "invalid arguments:\n- at '/Path': got integer, want string"],
    ['additional line before type errors', 'read_file', { Path: 1, Z: 1 },
      "invalid arguments:\n- additional properties 'Z' not allowed\n- at '/Path': got number, want string"],
    ['a missing header', 'read_file', {}, "- missing property 'Path'"],
    ['a trailing newline', 'read_file', {}, missingPath + '\n'],
    ['an unsafe integer', 'read_file', { Path: P, StartLine: 1e20 }, "invalid arguments:\n- at '/StartLine': got number, want integer"],
    ['nested artifact metadata', 'write_file', { ArtifactMetadata: {}, Content: 'c', Path: P },
      "invalid arguments:\n- at '/ArtifactMetadata': missing properties 'Summary', 'UserFacing', 'RequestFeedback'"],
    ['a quoted property name', 'read_file', { Path: P, "it's": 1 }, "invalid arguments:\n- additional properties 'it\\'s' not allowed"],
    ['an empty property name', 'read_file', { Path: P, '': 1 }, "invalid arguments:\n- additional properties '' not allowed"],
    ['a minLength claim on an unconstrained field', 'read_file', { Path: '' }, "invalid arguments:\n- at '/Path': minLength: got 0, want 1"],
    ['array arguments', 'read_file', [], missingPath],
  ])('rejects a lookalike with %s', (_name, name, args, error) => {
    expect(accept(name, args, error)).toBeUndefined();
  });
  it.each([
    ['receipt text mismatch', receipt(missingPath, { content: 'Error invalid tool call: ' + missingPath + ' ' })],
    ['missing error field', receipt(missingPath, { error: undefined })],
    ['error field mismatch', receipt(missingPath, { error: "invalid arguments:\n- missing property 'X'" })],
    ['ERROR status', receipt(missingPath, { status: 'ERROR' })],
    ['DONE status', receipt(missingPath, { status: 'DONE' })],
    ['system source', receipt(missingPath, { source: 'SYSTEM' })],
    ['receipt tool calls', receipt(missingPath, { tool_calls: [{}] })],
    ['step gap', receipt(missingPath, { step_index: 3 })],
    ['post-dispatch error', receipt('failed to unmarshal args: synthetic', { status: 'ERROR' })],
  ])('rejects %s', (_name, row) => {
    expect(agyValidationRejection('1.5.13', planner('read_file'), row)).toBeUndefined();
  });
  it.each([
    ['planner text', { ...planner('read_file'), content: 'Reading.' }],
    ['planner status', { ...planner('read_file'), status: 'RUNNING' }],
    ['extra call field', { ...planner('read_file'), tool_calls: [{ name: 'read_file', id: 'x' }] }],
    ['two calls', { ...planner('read_file'), tool_calls: [{ name: 'read_file' }, { name: 'read_file' }] }],
  ])('rejects a planner with %s', (_name, row) => {
    expect(agyValidationRejection('1.5.13', row as TranscriptRecord, receipt(missingPath))).toBeUndefined();
  });
});

describe('agyDispatchConflicts', () => {
  const rejection = { tool: 'read_file', args: {} };
  it('treats matching or unnamed updates as a possible dispatch', () => {
    expect(agyDispatchConflicts(rejection, { name: 'read_file', rawInput: {} })).toBe(true);
    expect(agyDispatchConflicts(rejection, { name: 'read_file' })).toBe(true);
    expect(agyDispatchConflicts(rejection, { rawInput: {} })).toBe(true);
  });
  it('ignores clearly different calls', () => {
    expect(agyDispatchConflicts(rejection, { name: 'read_file', rawInput: { Path: '/x' } })).toBe(false);
    expect(agyDispatchConflicts(rejection, { name: 'write_file', rawInput: {} })).toBe(false);
  });
});

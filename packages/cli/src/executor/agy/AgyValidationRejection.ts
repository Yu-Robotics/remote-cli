import { isDeepStrictEqual } from 'util';
import { receiptText, type TranscriptRecord } from '../../scheduling/agy/transcript';

type ArgumentType = 'boolean' | 'integer' | 'string';
interface Property { type: ArgumentType; minLength?: 1 }
interface KnownSchema { required: readonly string[]; properties: Readonly<Record<string, Property>>; unsupported?: readonly string[] }

const string: Property = { type: 'string' };
const nonEmpty: Property = { type: 'string', minLength: 1 };
const integer: Property = { type: 'integer' };
const boolean: Property = { type: 'boolean' };

/**
 * ACP does not expose native tool schemas. These ordinary built-in declarations
 * are pinned to the version reported by ACP `initialize` and were captured from
 * the provider request of an isolated AGY 1.5.13 session. All declare
 * `additionalProperties: false`. Native rejected each modeled violation before
 * dispatch, with no tool hooks and no ACP tool update. Management, shell,
 * scheduling, question and subagent tools are deliberately absent.
 * `ArtifactMetadata` is a nested object with its own validation and is not modeled.
 */
const KNOWN_SCHEMAS: Readonly<Record<string, Readonly<Record<string, KnownSchema>>>> = {
  '1.5.13': {
    read_file: { required: ['Path'], properties: { Path: string, StartLine: integer, EndLine: integer, ByteOffset: integer } },
    write_file: { required: ['Path', 'Content'], properties: { Path: nonEmpty, Content: string, Append: boolean, Overwrite: boolean },
      unsupported: ['ArtifactMetadata'] },
    edit_file: { required: ['Path', 'Target', 'Replacement'], properties: { Path: nonEmpty, Target: nonEmpty, Replacement: string },
      unsupported: ['ArtifactMetadata'] },
    search_web: { required: ['query'], properties: { query: string, domain: string } },
  },
};

export interface AgyValidationRejection { tool: string; args: Record<string, unknown> }

const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

// Names that native quotes without escaping. Others are not modeled.
const simpleName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const quote = (name: string) => `'${name}'`;
const ADDITIONAL = /^- additional properties ('[A-Za-z_][A-Za-z0-9_]*'(?:, '[A-Za-z_][A-Za-z0-9_]*')*) not allowed$/;

/** JSON Schema type name native reports for a parsed transcript value, or undefined when unmodeled. */
function jsonType(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? 'number' : undefined;
  if (typeof value === 'string' || typeof value === 'boolean') return typeof value;
  return plainObject(value) ? 'object' : undefined;
}

/**
 * Derive the native 1.5.13 validation lines for a call: missing required
 * properties in declaration order, then type or empty-string violations sorted
 * by property name, then additional properties. Returns undefined when the call
 * has an unmodeled shape; an empty list means the arguments are valid.
 */
function violations(schema: KnownSchema, args: Record<string, unknown>): { lines: string[]; extras: string[] } | undefined {
  const keys = Object.keys(args);
  if (keys.some(key => !simpleName.test(key) || schema.unsupported?.includes(key))) return;
  const missing = schema.required.filter(key => !Object.hasOwn(args, key));
  const lines = missing.length === 1 ? [`- missing property ${quote(missing[0])}`]
    : missing.length ? [`- missing properties ${missing.map(quote).join(', ')}`] : [];
  for (const key of keys.filter(key => Object.hasOwn(schema.properties, key)).sort()) {
    const { type, minLength } = schema.properties[key];
    const value = args[key];
    const actual = jsonType(value);
    if (!actual) return;
    if (type === 'integer' ? Number.isSafeInteger(value) : actual === type) {
      if (minLength && value === '') lines.push(`- at '/${key}': minLength: got 0, want 1`);
    } else lines.push(`- at '/${key}': got ${actual}, want ${type}`);
  }
  return { lines, extras: keys.filter(key => !Object.hasOwn(schema.properties, key)) };
}

/** Native lists additional properties in nondeterministic order. Compare them as a set. */
function matchesNative(error: string, expected: { lines: string[]; extras: string[] }): boolean {
  const lines = error.split('\n');
  if (lines.shift() !== 'invalid arguments:') return false;
  if (!expected.extras.length) return isDeepStrictEqual(lines, expected.lines);
  const additional = ADDITIONAL.exec(lines.pop() ?? '');
  if (!additional || !isDeepStrictEqual(lines, expected.lines)) return false;
  const names = additional[1].slice(1, -1).split("', '");
  return names.length === expected.extras.length && isDeepStrictEqual([...names].sort(), [...expected.extras].sort());
}

/**
 * Returns the rejected call only when its planner and native INVALID receipt
 * match a pinned schema exactly: every reported violation is derived from the
 * declaration, at least one exists, and the error field and receipt text agree.
 */
export function agyValidationRejection(version: string | undefined, planner: TranscriptRecord | undefined,
  receipt: TranscriptRecord | undefined): AgyValidationRejection | undefined {
  if (!version || !Object.hasOwn(KNOWN_SCHEMAS, version) || !planner || !receipt) return;
  if (planner.source !== 'MODEL' || planner.type !== 'PLANNER_RESPONSE' || planner.status !== 'DONE'
    || planner.content || planner.step_index !== receipt.step_index - 1 || planner.tool_calls?.length !== 1) return;
  const call = planner.tool_calls[0];
  if (!plainObject(call) || Object.keys(call).some(key => key !== 'name' && key !== 'args') || typeof call.name !== 'string') return;
  const schemas = KNOWN_SCHEMAS[version];
  if (!Object.hasOwn(schemas, call.name)) return;
  const args = call.args === undefined ? {} : call.args;
  if (!plainObject(args)) return;
  const expected = violations(schemas[call.name], args);
  if (!expected || !expected.lines.length && !expected.extras.length) return;
  const native = receipt as TranscriptRecord & { error?: unknown };
  if (receipt.source !== 'MODEL' || receipt.type !== 'GENERIC' || receipt.status !== 'INVALID' || receipt.tool_calls?.length
    || typeof native.error !== 'string' || receiptText(receipt) !== 'Error invalid tool call: ' + native.error
    || !matchesNative(native.error, expected)) return;
  return { tool: call.name, args: structuredClone(args) };
}

/** True when an ACP tool update could be the dispatch of a rejected call. */
export function agyDispatchConflicts(rejection: AgyValidationRejection, update: { name?: unknown; rawInput?: unknown }): boolean {
  if (update.name !== undefined && update.name !== rejection.tool) return false;
  return update.rawInput === undefined || isDeepStrictEqual(update.rawInput, rejection.args);
}

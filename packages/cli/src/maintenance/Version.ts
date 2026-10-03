/** Strict SemVer precedence for maintenance notices; updater semantics are unchanged. */
const PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parse(value: unknown): { core: number[]; pre: string[] } | undefined {
  if (typeof value !== 'string' || value.length > 100) return;
  const match = PATTERN.exec(value);
  if (!match) return;
  const core = match.slice(1, 4).map(Number);
  const pre = match[4]?.split('.') ?? [];
  if (core.some(n => !Number.isSafeInteger(n)) || pre.some(s => /^\d+$/.test(s) && (s.length > 1 && s[0] === '0'))) return;
  return { core, pre };
}

export function validNoticeVersion(value: unknown): value is string { return Boolean(parse(value)); }

export function compareNoticeVersions(a: string, b: string): number {
  const left = parse(a), right = parse(b);
  if (!left || !right) throw new Error('Invalid maintenance version.');
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const l = left.pre[i], r = right.pre[i];
    if (l === undefined || r === undefined) return l === r ? 0 : l === undefined ? -1 : 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    if (ln && rn) return l.length === r.length ? (l < r ? -1 : 1) : l.length < r.length ? -1 : 1;
    return ln !== rn ? ln ? -1 : 1 : l < r ? -1 : 1;
  }
  return 0;
}

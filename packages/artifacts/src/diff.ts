export interface DiffEntry {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

/** Structural diff of two JSON values. Arrays of objects with an `id` are matched by id, not position. */
export function diffJson(before: unknown, after: unknown, path = '', out: DiffEntry[] = [], limit = 500): DiffEntry[] {
  if (out.length >= limit) return out;
  if (JSON.stringify(before) === JSON.stringify(after)) return out;
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const byId = (v: unknown): v is { id: string }[] => Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === 'string');

  if (byId(before) && byId(after)) {
    const a = new Map(before.map((x) => [x.id, x]));
    const b = new Map(after.map((x) => [x.id, x]));
    for (const [id, x] of b) {
      if (!a.has(id)) out.push({ path: `${path}[${id}]`, kind: 'added', after: x });
      else diffJson(a.get(id), x, `${path}[${id}]`, out, limit);
    }
    for (const [id, x] of a) if (!b.has(id)) out.push({ path: `${path}[${id}]`, kind: 'removed', before: x });
    return out;
  }
  if (isObj(before) && isObj(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in before)) out.push({ path: p, kind: 'added', after: after[k] });
      else if (!(k in after)) out.push({ path: p, kind: 'removed', before: before[k] });
      else diffJson(before[k], after[k], p, out, limit);
    }
    return out;
  }
  out.push({ path: path || '(root)', kind: 'changed', before, after });
  return out;
}

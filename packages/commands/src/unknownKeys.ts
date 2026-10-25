import type { z } from 'zod';

// Commands accept JSON from agents and scripts, which sometimes invent fields (e.g. bypassReview).
// Zod objects strip those silently, so a misspelt field looks like it was accepted. This walker
// finds every unknown key path before parsing, so the executor can reject it (strict mode) or warn.

export interface UnknownInputKey {
  /** Dotted path into the input, e.g. `bypassReview` or `content.foo` (array indexes included). */
  path: string;
  /** Keys the schema accepts at that level, for the error message. */
  allowed: string[];
}

type Def = { type: string; [key: string]: unknown };
type Walker = (schema: z.ZodType, value: unknown, path: string) => UnknownInputKey[];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The schema behind optional, nullable, default, readonly, catch and similar wrappers. */
function unwrap(schema: z.ZodType): z.ZodType {
  const def = schema.def as Def;
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
      return unwrap(def.innerType as z.ZodType);
    case 'pipe':
      return unwrap(def.in as z.ZodType);
    case 'lazy':
      return unwrap((def.getter as () => z.ZodType)());
    default:
      return schema;
  }
}

/** Merges unknown keys found in separate branches of a union/intersection. */
function mergeUnknown(...lists: UnknownInputKey[][]): UnknownInputKey[] {
  const byPath = new Map<string, Set<string>>();
  for (const list of lists) {
    for (const item of list) {
      const allowed = byPath.get(item.path) ?? new Set<string>();
      for (const key of item.allowed) allowed.add(key);
      byPath.set(item.path, allowed);
    }
  }
  return [...byPath].map(([path, allowed]) => ({ path, allowed: [...allowed] }));
}

/** Keeps the keys that are unknown in every branch: a union branch that allows the key makes it known. */
function intersectUnknown(lists: UnknownInputKey[][]): UnknownInputKey[] {
  if (!lists.length) return [];
  const [first, ...rest] = lists;
  return first
    .filter((item) => rest.every((list) => list.some((other) => other.path === item.path)))
    .map((item) => {
      const allowed = new Set(item.allowed);
      for (const list of rest) for (const other of list) if (other.path === item.path) for (const key of other.allowed) allowed.add(key);
      return { path: item.path, allowed: [...allowed] };
    });
}

/**
 * Every key in `input` that `schema` does not accept, with the keys allowed at that level.
 * Arrays and nested objects are walked; records and `unknown`/`any` accept any key.
 */
export function findUnknownInputKeys(schema: z.ZodType, input: unknown): UnknownInputKey[] {
  const walk: Walker = (current, value, path) => {
    const s = unwrap(current);
    const def = s.def as Def;
    const prefix = path ? `${path}.` : '';
    switch (def.type) {
      case 'object':
      case 'interface': {
        if (!isPlainObject(value)) return [];
        const shape = def.shape as Record<string, z.ZodType>;
        const catchall = def.catchall === undefined ? undefined : unwrap(def.catchall as z.ZodType);
        const catchallType = (catchall?.def as Def | undefined)?.type;
        const found: UnknownInputKey[] = [];
        for (const key of Object.keys(value)) {
          const field = shape[key];
          if (field) found.push(...walk(field, value[key], `${prefix}${key}`));
          else if (catchall && catchallType !== 'never') found.push(...walk(catchall, value[key], `${prefix}${key}`));
          else found.push({ path: `${prefix}${key}`, allowed: Object.keys(shape) });
        }
        return found;
      }
      case 'array': {
        if (!Array.isArray(value)) return [];
        return value.flatMap((item, i) => walk(def.element as z.ZodType, item, `${prefix}${i}`));
      }
      case 'tuple': {
        if (!Array.isArray(value)) return [];
        const items = def.items as z.ZodType[];
        const rest = def.rest as z.ZodType | undefined;
        return value.flatMap((item, i) =>
          i < items.length ? walk(items[i]!, item, `${prefix}${i}`) : rest ? walk(rest, item, `${prefix}${i}`) : [],
        );
      }
      case 'union': {
        const options = def.options as z.ZodType[];
        const discriminator = def.discriminator as string | string[] | undefined;
        let branches = options;
        if (discriminator && isPlainObject(value)) {
          const fields = Array.isArray(discriminator) ? discriminator : [discriminator];
          const matching = options.filter((option) => {
            const shape = (unwrap(option).def as Def).shape as Record<string, z.ZodType> | undefined;
            return shape && fields.every((field) => shape[field]?.safeParse(value[field]).success);
          });
          if (matching.length) branches = matching;
        }
        // A plain union: a key any branch allows is not unknown (zod picks the branch and validates).
        return intersectUnknown(branches.map((option) => walk(option, value, path)));
      }
      case 'intersection':
        return intersectUnknown([walk(def.left as z.ZodType, value, path), walk(def.right as z.ZodType, value, path)]);
      case 'record':
      case 'unknown':
      case 'any':
        return [];
      default:
        return [];
    }
  };
  return mergeUnknown(walk(schema, input, ''));
}

/** One actionable sentence per unknown key, e.g. for an invalid_input error or a warning. */
export function unknownKeyMessages(command: string, unknown: UnknownInputKey[]): string[] {
  return unknown.map((item) => `Unknown input key "${item.path}" for ${command}. Allowed keys: ${item.allowed.join(', ') || '(none)'}.`);
}

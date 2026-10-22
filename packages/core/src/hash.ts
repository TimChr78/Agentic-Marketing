import { createHash } from 'node:crypto';

/** JSON with sorted object keys, so equal values always serialise (and hash) identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

export const hashValue = (value: unknown): string => sha256(canonicalJson(value));

import { createHash } from 'node:crypto';

// Every public archive request re-renders stored e-mail HTML. The parts are pure functions of that
// HTML, so a small LRU keeps repeat requests to a hash and a lookup instead of a full parse. Both
// bounds matter: an issue count limit alone could pin hundreds of megabytes, and a byte limit alone
// would still thrash the map with millions of tiny entries.

export interface CachedEmailParts {
  body: string;
  styles: string;
}

export const EMAIL_PARTS_CACHE_MAX_ENTRIES = 256;
export const EMAIL_PARTS_CACHE_MAX_BYTES = 32 * 1024 * 1024;

interface Entry {
  value: CachedEmailParts;
  bytes: number;
}

/** Least-recently-used map bounded by entry count and by the UTF-8 bytes it holds. */
export class EmailPartsCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = EMAIL_PARTS_CACHE_MAX_ENTRIES,
    private readonly maxBytes = EMAIL_PARTS_CACHE_MAX_BYTES,
  ) {}

  get(key: string): CachedEmailParts | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Re-insert so Map insertion order stays least-recently-used first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: CachedEmailParts): void {
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(value.body) + Buffer.byteLength(value.styles);
    // One value larger than the whole budget is not cached at all rather than emptying the cache.
    if (bytes > this.maxBytes) return;
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.bytes -= existing.bytes;
    }
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      this.bytes -= entry.bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get byteSize(): number {
    return this.bytes;
  }
}

const cache = new EmailPartsCache();

export const emailPartsCacheKey = (html: string): string => createHash('sha256').update(html).digest('hex');

/** The cached parts for `html`, computing them once when this hash is new. */
export function cachedEmailParts(html: string, compute: (html: string) => CachedEmailParts): CachedEmailParts {
  const key = emailPartsCacheKey(html);
  const hit = cache.get(key);
  if (hit) return hit;
  const parts = compute(html);
  cache.set(key, parts);
  return parts;
}

/** Tests only: forget every cached issue so a cold parse can be measured. */
export function clearEmailPartsCache(): void {
  cache.clear();
}

/** Tests only: what the process currently holds. */
export function emailPartsCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: cache.byteSize };
}

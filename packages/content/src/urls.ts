import { sha256 } from '@agentic-marketing/core';

// Canonical links and title keys (#140). Dedupe is deterministic: the same article from two feeds
// must produce the same key, and a re-fetch must update the item instead of adding another.

const TRACKING = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src', 'source', 'campaign']);

const STOP_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'with']);

/**
 * The link an item is compared by: no fragment, no tracking parameters, a stable query order and
 * no trailing slash. Relative links are resolved against the feed URL.
 */
export function canonicalUrl(raw: string, base?: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return raw.trim();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw.trim();
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || TRACKING.has(lower)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

/** The key that keeps a re-fetched canonical link on the same row. */
export function dedupeKey(canonical: string): string {
  return sha256(`content:${canonical}`);
}

/** Lower-case title with punctuation and accents removed, for exact-title matching and similarity. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokens(title: string): Set<string> {
  return new Set(
    titleKey(title)
      .split(' ')
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
  );
}

/**
 * Jaccard similarity of meaningful title words, 0…1. Two feeds often title the same story
 * differently by a word or a suffix ("… for marketers"); 0.9 is high enough not to merge two
 * genuinely different stories.
 */
export function titleSimilarity(a: string, b: string): number {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

/** The common title-similarity threshold for treating two links as one story. */
export const TITLE_SIMILARITY_THRESHOLD = 0.9;

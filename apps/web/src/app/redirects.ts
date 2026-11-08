// Legacy admin URLs (#446). The Phase 24 contract keeps every old bookmark working: each rule
// replaces history before the page fetches, preserves every other query value and the hash, and
// lets a destination's required tab win over an old `tab`. Unknown tails are not silently
// discarded; redirectTarget returns null and the router renders Not found.
//
// `:id` is carried verbatim after URL decoding/encoding once, so a percent-encoded id survives.

/** An id segment, decoded and encoded exactly once. */
function carry(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    // Malformed percent escapes: carry the raw segment rather than dropping the destination.
    return encodeURIComponent(segment);
  }
}

/** A journey id as the old Journey stats picker used it: a prefix and a body, never empty. */
const JOURNEY_ID = /^[a-z]{2,5}_[A-Za-z0-9._-]+$/i;

function query(search: URLSearchParams, opts: { set?: Record<string, string>; remove?: string[] } = {}): string {
  const next = new URLSearchParams(search);
  for (const key of opts.remove ?? []) next.delete(key);
  for (const [key, value] of Object.entries(opts.set ?? {})) next.set(key, value);
  const text = next.toString();
  return text ? `?${text}` : '';
}

function target(path: string, search: URLSearchParams, hash: string, opts?: { set?: Record<string, string>; remove?: string[] }) {
  return `${path}${query(search, opts)}${hash}`;
}

interface Rule {
  /** Exactly the list route or exactly one id segment; deeper tails are Not found. */
  pattern: RegExp;
  to: (id: string) => string;
  set?: Record<string, string>;
}

/**
 * List and detail rules. Order matters only for readability: every pattern is anchored, so a
 * `/build/segments/:id` rule cannot swallow `/build/segments/foo/bar`.
 */
const RULES: Rule[] = [
  { pattern: /^\/demo-signed-in$/, to: () => '/' },

  { pattern: /^\/build\/campaigns$/, to: () => '/marketing/campaigns' },
  { pattern: /^\/build\/campaigns\/([^/]+)$/, to: (id) => `/marketing/campaigns/${carry(id)}` },
  { pattern: /^\/build\/broadcasts$/, to: () => '/marketing/broadcasts' },
  { pattern: /^\/build\/broadcasts\/([^/]+)$/, to: (id) => `/marketing/broadcasts/${carry(id)}` },
  { pattern: /^\/build\/journeys$/, to: () => '/marketing/journeys' },
  { pattern: /^\/build\/journeys\/([^/]+)$/, to: (id) => `/marketing/journeys/${carry(id)}` },
  { pattern: /^\/build\/experiences$/, to: () => '/marketing/experiences' },
  { pattern: /^\/build\/experiences\/([^/]+)$/, to: (id) => `/marketing/experiences/${carry(id)}` },
  { pattern: /^\/build\/segments$/, to: () => '/audience/segments' },
  { pattern: /^\/build\/segments\/([^/]+)$/, to: (id) => `/audience/segments/${carry(id)}` },
  { pattern: /^\/build\/forms$/, to: () => '/audience/forms' },
  { pattern: /^\/build\/forms\/([^/]+)$/, to: (id) => `/audience/forms/${carry(id)}` },

  { pattern: /^\/build\/prompts$/, to: () => '/work/agents', set: { tab: 'library' } },
  { pattern: /^\/build\/prompts\/([^/]+)$/, to: (id) => `/work/agents/library/${carry(id)}` },
  { pattern: /^\/build\/topics$/, to: () => '/audience/consent', set: { tab: 'topics' } },
  { pattern: /^\/build\/recipes$/, to: () => '/content/templates', set: { tab: 'starters' } },

  { pattern: /^\/design\/templates$/, to: () => '/content/templates' },
  { pattern: /^\/design\/templates\/([^/]+)$/, to: (id) => `/content/templates/${carry(id)}` },
  { pattern: /^\/design\/blocks$/, to: () => '/content/templates', set: { tab: 'blocks' } },
  { pattern: /^\/design\/blocks\/([^/]+)$/, to: (id) => `/content/templates/blocks/${carry(id)}` },
  { pattern: /^\/design\/assets$/, to: () => '/content/assets' },
  { pattern: /^\/design\/hosted-pages$/, to: () => '/content/brand', set: { tab: 'subscriber-pages' } },
  { pattern: /^\/design\/brand$/, to: () => '/content/brand' },

  { pattern: /^\/audience\/imports$/, to: () => '/audience/people', set: { tab: 'imports' } },

  { pattern: /^\/settings\/agents$/, to: () => '/work/agents' },
  { pattern: /^\/settings\/agents\/([^/]+)$/, to: (id) => `/work/agents/${carry(id)}` },
  { pattern: /^\/settings\/purposes$/, to: () => '/audience/consent', set: { tab: 'purposes' } },
  { pattern: /^\/settings\/preferences$/, to: () => '/preferences' },

  { pattern: /^\/insights\/ai$/, to: () => '/insights/analytics', set: { tab: 'ai' } },
];

/**
 * The canonical destination for an old URL, or null when the URL is not a legacy address. The
 * caller must call this before mounting a page, so a redirect never fetches the old page.
 */
export function redirectTarget(pathname: string, search: URLSearchParams, hash = ''): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';

  // `/insights/journeys` used the query for selection, so it has three cases rather than a rule.
  if (path === '/insights/journeys') {
    const journey = search.get('journey');
    if (journey !== null && JOURNEY_ID.test(journey)) {
      return target(`/marketing/journeys/${carry(journey)}`, search, hash, {
        set: { tab: 'report' },
        remove: ['journey'],
      });
    }
    // A present but empty/invalid id never becomes a fetch for `undefined`.
    return target('/marketing/journeys', search, hash, {
      set: { view: 'reports', ...(journey !== null ? { invalidJourney: '1' } : {}) },
      remove: ['journey'],
    });
  }

  for (const rule of RULES) {
    const match = rule.pattern.exec(path);
    if (!match) continue;
    return target(rule.to(match[1] ?? ''), search, hash, { set: rule.set });
  }
  return null;
}

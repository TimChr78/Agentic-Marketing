import type { ContentScoreComponent, ContentScoreExplanation, ContentSourceCategory } from '@agentic-marketing/db';

// Deterministic, explainable relevance scoring (#140). The policy is a code constant with a
// version: the same item, source authority and clock produce the same score, and every item stores
// the components that produced it. Changing the rules bumps CONTENT_POLICY_VERSION.

export const CONTENT_POLICY_VERSION = '1';

export const CONTENT_SECTIONS = ['Big moves', 'Tools & launches', 'Agent playbook', 'Deep dive', 'Open source', 'Community'] as const;
export type ContentSection = (typeof CONTENT_SECTIONS)[number];

export const CONTENT_SOURCE_CATEGORIES: ContentSourceCategory[] = [
  'platform',
  'publication',
  'vendor',
  'community',
  'open source',
  'thought leader',
  'other',
];

interface KeywordGroup {
  name: 'high' | 'medium' | 'other';
  points: number;
  cap: number;
  keywords: string[];
}

export const CONTENT_POLICY = {
  version: CONTENT_POLICY_VERSION,
  keywordGroups: [
    {
      name: 'high',
      points: 12,
      cap: 36,
      keywords: [
        'acquisition',
        'acquires',
        'acquired',
        'funding round',
        'raises',
        'series a',
        'series b',
        'ipo',
        'merger',
        'agentic',
        'ai agent',
        'ai agents',
        'autonomous agent',
        'generative ai',
        'large language model',
        'llm',
      ],
    },
    {
      name: 'medium',
      points: 6,
      cap: 24,
      keywords: [
        'martech',
        'marketing technology',
        'crm',
        'customer data',
        'personalization',
        'campaign',
        'automation',
        'workflow',
        'segmentation',
        'email marketing',
        'analytics',
        'privacy',
        'consent',
        'open source',
        'api',
      ],
    },
    {
      name: 'other',
      points: 3,
      cap: 12,
      keywords: [
        'newsletter',
        'webinar',
        'podcast',
        'report',
        'survey',
        'benchmark',
        'research',
        'launch',
        'release',
        'beta',
        'community',
        'event',
        'appoints',
      ],
    },
  ] satisfies KeywordGroup[],
  authority: { maxPoints: 20 },
  recency: [
    { withinHours: 24, points: 20, label: 'published in the last 24 hours' },
    { withinHours: 72, points: 12, label: 'published in the last 3 days' },
    { withinHours: 168, points: 6, label: 'published in the last 7 days' },
  ],
  category: {
    publication: 6,
    vendor: 5,
    platform: 4,
    'open source': 4,
    'thought leader': 3,
    community: 3,
    other: 0,
  } satisfies Record<ContentSourceCategory, number>,
  sections: [
    {
      name: 'Big moves',
      keywords: [
        'acquisition',
        'acquires',
        'acquired',
        'funding',
        'raises',
        'series a',
        'series b',
        'ipo',
        'merger',
        'appoints',
        'partnership',
      ],
    },
    {
      name: 'Tools & launches',
      keywords: ['launch', 'launches', 'released', 'release', 'beta', 'now available', 'new feature', 'ships', 'general availability'],
    },
    {
      name: 'Agent playbook',
      keywords: ['agentic', 'ai agent', 'ai agents', 'agents', 'autonomous', 'workflow', 'prompt', 'llm', 'rag', 'evaluation', 'copilot'],
    },
    {
      name: 'Deep dive',
      keywords: ['research', 'study', 'report', 'survey', 'benchmark', 'analysis', 'data', 'trends'],
    },
    {
      name: 'Open source',
      keywords: ['open source', 'github', 'repository', 'license', 'oss', 'self hosted'],
    },
    {
      name: 'Community',
      keywords: ['community', 'event', 'webinar', 'podcast', 'meetup', 'conference', 'award', 'newsletter'],
    },
  ] satisfies { name: ContentSection; keywords: string[] }[],
} as const;

/** Lower-case words with punctuation folded to spaces, so phrase matching has word boundaries. */
function normalise(value: string): string {
  return ` ${value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

function matches(haystack: string, phrase: string): boolean {
  return haystack.includes(` ${phrase} `);
}

export interface ScoreInput {
  title: string;
  excerpt: string;
  publishedAt: Date | null;
  authority: number;
  category: ContentSourceCategory;
  now?: Date;
}

export interface ScoreResult {
  score: number;
  section: ContentSection;
  matchedKeywords: string[];
  explanation: ContentScoreExplanation;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function scoreItem(input: ScoreInput): ScoreResult {
  const now = input.now ?? new Date();
  const text = normalise(`${input.title} ${input.excerpt}`);
  const components: ContentScoreComponent[] = [];
  const matchedKeywords: string[] = [];
  const hits: string[] = [];

  for (const group of CONTENT_POLICY.keywordGroups) {
    const found = group.keywords.filter((keyword) => matches(text, keyword));
    if (!found.length) continue;
    const points = Math.min(group.cap, found.length * group.points);
    matchedKeywords.push(...found);
    hits.push(`${found.length} ${group.name} keyword${found.length === 1 ? '' : 's'}`);
    components.push({
      kind: 'keyword',
      label: `${group.name[0]!.toUpperCase()}${group.name.slice(1)} keywords`,
      points,
      detail: found.join(', '),
    });
  }

  const authority = clamp(Math.round(input.authority), 1, 5);
  const authorityPoints = Math.round(((authority - 1) / 4) * CONTENT_POLICY.authority.maxPoints);
  components.push({
    kind: 'authority',
    label: 'Source authority',
    points: authorityPoints,
    detail: `${authority} of 5`,
  });

  const ageHours = input.publishedAt ? Math.max(0, (now.getTime() - input.publishedAt.getTime()) / 3_600_000) : null;
  const band = ageHours === null ? null : CONTENT_POLICY.recency.find((r) => ageHours <= r.withinHours);
  const recencyPoints = band?.points ?? 0;
  if (band) components.push({ kind: 'recency', label: 'Recency', points: recencyPoints, detail: band.label });
  else if (ageHours !== null) components.push({ kind: 'recency', label: 'Recency', points: 0, detail: 'older than 7 days' });

  const categoryPoints = CONTENT_POLICY.category[input.category] ?? 0;
  if (categoryPoints) components.push({ kind: 'category', label: 'Category', points: categoryPoints, detail: input.category });

  // The section is the one whose rules the item matches most strongly; ties follow the fixed
  // section order, so two runs over the same text always agree.
  let section: ContentSection = 'Community';
  let sectionHits = 0;
  let sectionKeyword = '';
  for (const rule of CONTENT_POLICY.sections) {
    const found = rule.keywords.filter((keyword) => matches(text, keyword));
    if (found.length > sectionHits) {
      section = rule.name;
      sectionHits = found.length;
      sectionKeyword = found[0] ?? '';
    }
  }
  components.push({
    kind: 'section',
    label: 'Section',
    points: 0,
    detail: sectionHits ? `${section} (matched "${sectionKeyword}")` : `${section} (no section rule matched)`,
  });

  const score = components.reduce((sum, c) => sum + c.points, 0);
  const summary = [`score ${score}`, ...hits, `authority ${authority}`, band ? `recency ${recencyPoints}` : 'no date']
    .filter(Boolean)
    .join('; ');

  return {
    score,
    section,
    matchedKeywords: [...new Set(matchedKeywords)],
    explanation: {
      policyVersion: CONTENT_POLICY_VERSION,
      total: score,
      matchedKeywords: [...new Set(matchedKeywords)],
      section,
      components,
      summary,
    },
  };
}

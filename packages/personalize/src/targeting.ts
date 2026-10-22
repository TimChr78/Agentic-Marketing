import { createHash } from 'node:crypto';
import type { DecideCondition, ExperienceDefinition } from '@agentic-marketing/artifacts';
import type { ProfileSnapshot, Session } from '@agentic-marketing/hotstate';

// Decide-time targeting and allocation, as pure functions over hot state.

export interface DecideContext {
  /** Whether the visitor allows personalization; without it only the page itself may be used. */
  personalized: boolean;
  snapshot: ProfileSnapshot | null;
  session: Session | null;
  page: { url: string; path: string; referrer: string };
  utmSource: string | null;
  device: 'mobile' | 'desktop';
}

/** Conditions that read the person, rather than the page. */
export function personal(c: DecideCondition): boolean {
  if ('all' in c) return c.all.some(personal);
  if ('any' in c) return c.any.some(personal);
  if ('not' in c) return personal(c.not);
  return 'trait' in c || 'segment' in c || 'session' in c || 'newVisitor' in c;
}

export function matches(c: DecideCondition, ctx: DecideContext): boolean {
  if ('all' in c) return c.all.every((x) => matches(x, ctx));
  if ('any' in c) return c.any.some((x) => matches(x, ctx));
  // Without consent a personal condition is unknown, and "not unknown" must not become true.
  if ('not' in c) return (ctx.personalized || !personal(c.not)) && !matches(c.not, ctx);
  if ('page' in c) {
    const p = c.page;
    return (
      (!p.path || ctx.page.path === p.path) &&
      (!p.pathPrefix || ctx.page.path.startsWith(p.pathPrefix)) &&
      (!p.urlContains || ctx.page.url.includes(p.urlContains))
    );
  }
  if ('referrer' in c) return ctx.page.referrer.includes(c.referrer.contains);
  if ('utmSource' in c) return (ctx.utmSource ?? ctx.session?.utmSource ?? '') === c.utmSource;
  if ('device' in c) return ctx.device === c.device;
  if (!ctx.personalized) return false;
  if ('segment' in c) return !!ctx.snapshot?.segments.includes(c.segment);
  if ('newVisitor' in c) return (ctx.snapshot === null && (ctx.session?.isNew ?? true)) === c.newVisitor;
  if ('session' in c) {
    const n = c.session === 'page' ? (ctx.session?.pageViews ?? 0) : (ctx.session?.counts[c.session] ?? 0);
    const min = c.count?.gte ?? (c.count?.lte === undefined ? 1 : 0);
    return n >= min && (c.count?.lte === undefined || n <= c.count.lte);
  }
  const v = ctx.snapshot?.traits[c.trait];
  switch (c.op) {
    case 'exists':
      return v !== undefined && v !== null;
    case 'eq':
      return v === c.value;
    case 'neq':
      return v !== c.value;
    case 'in':
      return Array.isArray(c.value) && c.value.some((x) => x === v);
    default: {
      if (typeof v !== 'number' || typeof c.value !== 'number') return false;
      return c.op === 'gt' ? v > c.value : c.op === 'gte' ? v >= c.value : c.op === 'lt' ? v < c.value : v <= c.value;
    }
  }
}

const unit = (key: string) => createHash('sha256').update(key).digest().readUInt32BE(0) / 2 ** 32;

/**
 * Sticky allocation: the same person always lands in the same bucket of an experience (by
 * profile when known, so it holds across devices). Returns the variant, or null for the holdout.
 */
export function allocate(experienceId: string, stableId: string, e: Pick<ExperienceDefinition, 'variants' | 'holdoutPercent'>) {
  if (unit(`${experienceId}:holdout:${stableId}`) * 100 < e.holdoutPercent) return null;
  const total = e.variants.reduce((a, v) => a + v.weight, 0);
  let r = unit(`${experienceId}:variant:${stableId}`) * total;
  for (const v of e.variants) {
    if (r < v.weight) return v;
    r -= v.weight;
  }
  return e.variants[e.variants.length - 1];
}

export function deviceOf(userAgent: string | undefined): 'mobile' | 'desktop' {
  return /Mobi|Android|iPhone|iPad/i.test(userAgent ?? '') ? 'mobile' : 'desktop';
}

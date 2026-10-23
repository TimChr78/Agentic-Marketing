import { createHash } from 'node:crypto';
import type { ExperienceDefinition } from '@agentic-marketing/artifacts';
import { allocate, type DecideContext, matches } from './targeting';

// The decision itself, as pure functions shared by the decision API on the server and the edge
// worker on Cloudflare: which experience each placement shows, and which variant. Nothing here
// reads a database; callers bring the experiences, the visitor's snapshot and the source.

export interface PublishedExperience {
  id: string;
  version: number;
  def: ExperienceDefinition;
}

export interface Decision {
  placement: string;
  experienceId: string;
  version: number;
  /** "holdout" when the person is in the control group and sees the default content. */
  variantId: string;
  content: { html?: string; json?: Record<string, unknown> } | null;
  trigger: ExperienceDefinition['trigger'];
}

/** What the edge needs to know about a write key (the server reads the same from Postgres). */
export interface EdgeSource {
  workspaceId: string;
  kind: 'browser' | 'server';
  requiredPurpose: string | null;
  enabled: boolean;
  allowedOrigins: string[];
}

/** The hash a write key is stored under (same as ingest's sources table). */
export const writeKeyHash = (key: string) => createHash('sha256').update(`write-key:${key}`).digest('hex');

/** Same rule as ingest's originAllowed: browser keys only from their sites. */
export function originOk(source: Pick<EdgeSource, 'kind' | 'allowedOrigins'>, origin: string | undefined) {
  return (
    source.kind !== 'browser' || source.allowedOrigins.includes('*') || (!!origin && source.allowedOrigins.includes(origin.toLowerCase()))
  );
}

/** Same rule as ingest's consentAllows: consent needs an explicit yes, other bases hold unless refused. */
export function purposeOk(purpose: string, purposes: { key: string; basis: string }[], consent: Record<string, boolean> | undefined) {
  const p = purposes.find((x) => x.key === purpose);
  const signal = consent?.[purpose];
  if (!p || p.basis === 'consent') return signal === true;
  return signal !== false;
}

/** The visitor's consent signals from a decide request's context. */
export function consentFrom(context: Record<string, unknown> | undefined): Record<string, boolean> | undefined {
  const prefs = (context?.consent as { categoryPreferences?: unknown } | undefined)?.categoryPreferences;
  if (!prefs || typeof prefs !== 'object') return undefined;
  return Object.fromEntries(Object.entries(prefs).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>;
}

/**
 * One decision per placement: the highest-priority experience whose targeting matches, and a
 * sticky variant. `preview` forces a variant of one experience (the visual editor's preview
 * link); it never shows a variant that does not exist.
 */
export function decideAll(
  experiences: PublishedExperience[],
  placements: string[],
  ctx: DecideContext,
  stableId: string,
  preview?: { experienceId: string; variantId: string },
): Decision[] {
  const wanted = experiences.filter((e) => placements.includes(e.def.placement)).sort((a, b) => b.def.priority - a.def.priority);
  const decisions: Decision[] = [];
  for (const placement of placements) {
    const forced = preview ? wanted.find((x) => x.id === preview.experienceId && x.def.placement === placement) : undefined;
    const e = forced ?? wanted.find((x) => x.def.placement === placement && (!x.def.targeting || matches(x.def.targeting, ctx)));
    if (!e) continue;
    const pinned = forced ? e.def.variants.find((v) => v.id === preview?.variantId) : undefined;
    const v = pinned ?? (stableId ? allocate(e.id, stableId, e.def) : e.def.variants[0]);
    decisions.push({
      placement,
      experienceId: e.id,
      version: e.version,
      variantId: v?.id ?? 'holdout',
      content: v?.content ?? null,
      trigger: e.def.trigger,
    });
  }
  return decisions;
}

import { newId } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { ParsedFeedItem } from './parse';
import { scoreItem } from './score';
import { dedupeKey, TITLE_SIMILARITY_THRESHOLD, titleKey, titleSimilarity } from './urls';

// Turning parsed entries into library rows (#140). A canonical link is the dedupe key; a title
// that is the same story under another link (an aggregator, a re-post) updates the existing row
// instead of adding a second one. The same inputs always produce the same item, score and section.

export type ContentSourceRow = typeof schema.contentSources.$inferSelect;

export interface IngestResult {
  added: number;
  updated: number;
}

/** How far back a title-similar item is looked for. */
const SIMILARITY_WINDOW_DAYS = 14;

async function findByCanonical(tx: Tx, workspaceId: string, key: string) {
  const [row] = await tx
    .select()
    .from(schema.contentItems)
    .where(and(eq(schema.contentItems.workspaceId, workspaceId), eq(schema.contentItems.dedupeKey, key)))
    .limit(1);
  return row;
}

/** A recent item with the same normalised title, or one whose title is similar enough to be a re-post. */
async function findByTitle(tx: Tx, workspaceId: string, title: string, now: Date) {
  const windowStart = new Date(now.getTime() - SIMILARITY_WINDOW_DAYS * 86_400_000);
  const candidates = await tx
    .select({
      id: schema.contentItems.id,
      title: schema.contentItems.title,
      titleKey: schema.contentItems.titleKey,
    })
    .from(schema.contentItems)
    .where(and(eq(schema.contentItems.workspaceId, workspaceId), gte(schema.contentItems.fetchedAt, windowStart)))
    .orderBy(desc(schema.contentItems.fetchedAt))
    .limit(200);
  const exact = titleKey(title);
  return candidates.find((c) => c.titleKey === exact || titleSimilarity(c.title, title) >= TITLE_SIMILARITY_THRESHOLD);
}

async function saveItem(tx: Tx, source: ContentSourceRow, item: ParsedFeedItem, now: Date): Promise<'added' | 'updated'> {
  const workspaceId = source.workspaceId;
  const key = dedupeKey(item.url);
  const scored = scoreItem({
    title: item.title,
    excerpt: item.excerpt,
    publishedAt: item.publishedAt,
    authority: source.authority,
    category: source.category,
    now,
  });
  const existing = await findByCanonical(tx, workspaceId, key);
  const duplicate = existing ? null : await findByTitle(tx, workspaceId, item.title, now);

  if (existing || duplicate) {
    const id = existing?.id ?? duplicate!.id;
    await tx
      .update(schema.contentItems)
      .set({
        title: item.title || existing?.title || duplicate?.title || '',
        excerpt: item.excerpt || existing?.excerpt || '',
        author: item.author ?? existing?.author ?? null,
        publishedAt: item.publishedAt ?? existing?.publishedAt ?? null,
        fetchedAt: now,
        lastSeenAt: now,
        titleKey: titleKey(item.title),
        section: scored.section,
        relevanceScore: scored.score,
        scoreExplanation: scored.explanation,
        policyVersion: scored.explanation.policyVersion,
        updatedAt: now,
      })
      .where(and(eq(schema.contentItems.workspaceId, workspaceId), eq(schema.contentItems.id, id)));
    return 'updated';
  }

  await tx.insert(schema.contentItems).values({
    workspaceId,
    id: newId('citem'),
    sourceId: source.id,
    canonicalUrl: item.url,
    title: item.title,
    excerpt: item.excerpt,
    author: item.author,
    publishedAt: item.publishedAt,
    fetchedAt: now,
    lastSeenAt: now,
    dedupeKey: key,
    titleKey: titleKey(item.title),
    language: source.language,
    section: scored.section,
    status: 'new',
    relevanceScore: scored.score,
    scoreExplanation: scored.explanation,
    policyVersion: scored.explanation.policyVersion,
    createdAt: now,
    updatedAt: now,
  });
  return 'added';
}

/** Store a parsed feed, newest first, capped so one large feed cannot fill the library in a run. */
export async function ingestFeed(
  tx: Tx,
  source: ContentSourceRow,
  items: ParsedFeedItem[],
  now: Date,
  maxItems: number,
): Promise<IngestResult> {
  const result: IngestResult = { added: 0, updated: 0 };
  const unique = new Map<string, ParsedFeedItem>();
  for (const item of items) {
    if (!unique.has(item.url)) unique.set(item.url, item);
  }
  for (const item of [...unique.values()].slice(0, Math.max(0, maxItems))) {
    const outcome = await saveItem(tx, source, item, now);
    result[outcome]++;
  }
  return result;
}

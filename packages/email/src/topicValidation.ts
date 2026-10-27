import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import type { Tx } from '@agentic-marketing/db';
import { findTopic } from '@agentic-marketing/profiles';

/**
 * A template or broadcast may name a topic, but only one defined under its own purpose (#84).
 * Checked when publishing, so a typo cannot quietly make a topic gate apply to another purpose.
 */
export async function topicProblems(tx: Tx, purpose: string, topic: string | undefined): Promise<string[]> {
  if (!topic) return [];
  const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
  const found = findTopic(purposes, topic);
  if (!found) return [`topic "${topic}" is not defined under any purpose`];
  if (found.purpose.key !== purpose) return [`topic "${topic}" belongs to purpose "${found.purpose.key}", not "${purpose}"`];
  return [];
}

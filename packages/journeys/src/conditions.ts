import type { SegmentCondition } from '@agentic-marketing/artifacts';
import { schema, type Tx } from '@agentic-marketing/db';
import type { BusEvent, EventStore } from '@agentic-marketing/events';
import { contextFor, evaluate, type PublishedSegment } from '@agentic-marketing/segments';
import { and, eq } from 'drizzle-orm';

// waitUntil reuses the segment DSL. A direct { segment } check reads the materialised membership,
// as a branch does, so a just-published Segment Entered is visible at once; other conditions are
// evaluated for this one person, never for everyone.

export async function matchesCondition(
  tx: Tx,
  workspaceId: string,
  events: EventStore,
  segments: PublishedSegment[],
  profileId: string,
  condition: SegmentCondition,
  pending?: Map<string, BusEvent[]>,
): Promise<boolean> {
  if ('segment' in condition) {
    const [m] = await tx
      .select({ profileId: schema.segmentMemberships.profileId })
      .from(schema.segmentMemberships)
      .where(and(eq(schema.segmentMemberships.segmentId, condition.segment), eq(schema.segmentMemberships.profileId, profileId)));
    return !!m;
  }
  const ids = await evaluate(condition, contextFor(tx, workspaceId, events, segments, { scope: [profileId], pending }));
  return ids.has(profileId);
}

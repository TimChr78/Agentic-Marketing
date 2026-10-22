import { type Db, schema } from '@agentic-marketing/db';
import type { HotState } from '@agentic-marketing/hotstate';
import type { ResolvedEvent } from '@agentic-marketing/profiles';
import { and, inArray, isNull } from 'drizzle-orm';

/**
 * Keeps profile snapshots in Valkey current: after a batch of events is applied (and segments
 * updated), the people it touched get a fresh snapshot of their non-personal traits and segment
 * memberships under each of their ids.
 */
export function snapshotHook(deps: { db: Db; hot: HotState }) {
  return async (workspaceId: string, resolved: ResolvedEvent[]) => {
    const people = [...new Set(resolved.map((r) => r.profileId))];
    if (!people.length) return;
    const data = await deps.db.withWorkspace(
      workspaceId,
      async (tx) => {
        const profiles = await tx
          .select({ id: schema.profiles.id, traits: schema.profiles.traits })
          .from(schema.profiles)
          .where(and(inArray(schema.profiles.id, people), isNull(schema.profiles.mergedInto)));
        const ids = await tx
          .select({ type: schema.identifiers.type, value: schema.identifiers.value, profileId: schema.identifiers.profileId })
          .from(schema.identifiers)
          .where(and(inArray(schema.identifiers.profileId, people), inArray(schema.identifiers.type, ['anonymous_id', 'user_id'])));
        const members = await tx
          .select({ profileId: schema.segmentMemberships.profileId, segmentId: schema.segmentMemberships.segmentId })
          .from(schema.segmentMemberships)
          .where(inArray(schema.segmentMemberships.profileId, people));
        return { profiles, ids, members };
      },
      { snapshot: true },
    );
    const at = new Date().toISOString();
    await Promise.all(
      data.profiles.map((p) =>
        deps.hot.writeSnapshot(
          workspaceId,
          {
            anonymousIds: data.ids.filter((i) => i.profileId === p.id && i.type === 'anonymous_id').map((i) => i.value),
            userIds: data.ids.filter((i) => i.profileId === p.id && i.type === 'user_id').map((i) => i.value),
          },
          { profileId: p.id, traits: p.traits, segments: data.members.filter((m) => m.profileId === p.id).map((m) => m.segmentId), at },
        ),
      ),
    );
  };
}

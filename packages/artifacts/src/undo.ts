import { registerUndoHandler } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, eq } from 'drizzle-orm';
import { publishArtifactVersion, unpublishArtifactVersion } from './commands';

// Reversing an agent's publish (ADR-0016 §5.4, #255). The previous version goes live through the
// same publish checks and listeners as any publish; a first publish is taken out of service again
// and its version becomes a draft. A person's undo is audited by `agents.undo` itself.

registerUndoHandler(async (ctx, undo) => {
  if (undo.kind !== 'republish') return null;
  // Only the agent's own version is reverted: if a newer one went live since, undoing would discard
  // someone else's work, so a person decides by hand (#281). Locked so a publish cannot slip in.
  const [live] = await ctx.tx
    .select({ publishedVersion: schema.artifacts.publishedVersion })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.workspaceId, ctx.principal.workspaceId), eq(schema.artifacts.id, undo.artifactId)))
    .for('update');
  if (undo.publishedVersion !== undefined && live?.publishedVersion !== undo.publishedVersion)
    throw new AppError(
      'conflict',
      live?.publishedVersion == null
        ? `${undo.artifactId} is no longer live, so there is nothing of this action to undo.`
        : `${undo.artifactId} v${live.publishedVersion} was published after this action (it published v${undo.publishedVersion}); undoing it would discard newer work. Change it by hand instead.`,
    );
  if (undo.previousVersion === null) {
    const version = await unpublishArtifactVersion(ctx, undo.artifactId);
    if (version === null) return `${undo.artifactId} was not live any more.`;
    return `Unpublished ${undo.artifactId}; v${version} is a draft again.`;
  }
  await publishArtifactVersion(ctx, undo.artifactId, undo.previousVersion);
  return `Republished ${undo.artifactId} v${undo.previousVersion}.`;
});

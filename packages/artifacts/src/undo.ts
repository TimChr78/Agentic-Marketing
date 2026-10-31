import { registerUndoHandler } from '@agentic-marketing/commands';
import { publishArtifactVersion, unpublishArtifactVersion } from './commands';

// Reversing an agent's publish (ADR-0016 §5.4, #255). The previous version goes live through the
// same publish checks and listeners as any publish; a first publish is taken out of service again
// and its version becomes a draft. A person's undo is audited by `agents.undo` itself.

registerUndoHandler(async (ctx, undo) => {
  if (undo.kind !== 'republish') return null;
  if (undo.previousVersion === null) {
    const version = await unpublishArtifactVersion(ctx, undo.artifactId);
    if (version === null) return `${undo.artifactId} was not live any more.`;
    return `Unpublished ${undo.artifactId}; v${version} is a draft again.`;
  }
  await publishArtifactVersion(ctx, undo.artifactId, undo.previousVersion);
  return `Republished ${undo.artifactId} v${undo.previousVersion}.`;
});

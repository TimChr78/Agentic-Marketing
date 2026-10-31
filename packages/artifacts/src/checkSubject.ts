import { schema, type Tx } from '@agentic-marketing/db';
import { and, eq } from 'drizzle-orm';
import { type DiffEntry, diffJson } from './diff';

// What the independent check (#261, ADR-0016 §4.5) reviews: the command input alone says only
// *which* artifact or template is published, not what it says. This loads the version being
// published and its diff against the live one, so a second model can judge the content itself.

export interface PublishedArtifact {
  type: string;
  name: string;
  version: number;
  publishedVersion: number | null;
  content: unknown;
  diff: { from: number | null; to: number; changes: DiffEntry[] };
}

export interface PublishedTemplate {
  type: string;
  name: string;
  version: number;
  purpose: unknown;
  subject: unknown;
  mjml: unknown;
  text: unknown;
}

/** The subject of a check: what the action publishes, in the shape the prompt shows. */
export interface CheckSubject {
  artifacts?: PublishedArtifact[];
  template?: PublishedTemplate;
}

async function loadArtifact(tx: Tx, workspaceId: string, artifactId: string) {
  const [a] = await tx
    .select()
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.workspaceId, workspaceId), eq(schema.artifacts.id, artifactId)));
  return a ?? null;
}

async function contentAt(tx: Tx, workspaceId: string, artifactId: string, version: number | null | undefined) {
  if (!version) return null;
  const [v] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(
      and(
        eq(schema.artifactVersions.workspaceId, workspaceId),
        eq(schema.artifactVersions.artifactId, artifactId),
        eq(schema.artifactVersions.number, version),
      ),
    );
  return v?.content ?? null;
}

/** One artifact being published: its latest (draft) version, and the diff from the live version. */
async function publishedArtifact(tx: Tx, workspaceId: string, artifactId: string): Promise<PublishedArtifact | null> {
  const a = await loadArtifact(tx, workspaceId, artifactId);
  if (!a) return null;
  const content = await contentAt(tx, workspaceId, a.id, a.latestVersion);
  const live = await contentAt(tx, workspaceId, a.id, a.publishedVersion);
  return {
    type: a.type,
    name: a.name,
    version: a.latestVersion,
    publishedVersion: a.publishedVersion,
    content,
    diff: { from: a.publishedVersion, to: a.latestVersion, changes: diffJson(live ?? {}, content) },
  };
}

/** The template a direct send uses: what the gateway will render, not just its id. */
async function publishedTemplate(tx: Tx, workspaceId: string, templateId: string): Promise<PublishedTemplate | null> {
  const a = await loadArtifact(tx, workspaceId, templateId);
  if (!a) return null;
  if (a.type !== 'email_template' || !a.publishedVersion) return null;
  const content = (await contentAt(tx, workspaceId, a.id, a.publishedVersion)) as Record<string, unknown> | null;
  return {
    type: a.type,
    name: a.name,
    version: a.publishedVersion,
    purpose: content?.purpose ?? null,
    subject: content?.subject ?? null,
    mjml: content?.mjml ?? null,
    text: content?.text ?? null,
  };
}

/**
 * The content the given command would publish, or null for commands whose input is the content
 * (or which the check does not need to look further into). `config.import` asks its own decision
 * with `artifacts.requestPublish` and that command's input, so it is covered by the first case.
 */
export async function checkSubjectOf(tx: Tx, workspaceId: string, command: string, input: unknown): Promise<CheckSubject | null> {
  if (!input || typeof input !== 'object') return null;
  const fields = input as Record<string, unknown>;
  if (command === 'artifacts.requestPublish') {
    if (typeof fields.artifactId !== 'string') return null;
    const artifact = await publishedArtifact(tx, workspaceId, fields.artifactId);
    return artifact ? { artifacts: [artifact] } : null;
  }
  if (command === 'artifacts.requestPublishBundle') {
    if (!Array.isArray(fields.artifactIds)) return null;
    const artifacts: PublishedArtifact[] = [];
    for (const id of new Set(fields.artifactIds.filter((x): x is string => typeof x === 'string'))) {
      const artifact = await publishedArtifact(tx, workspaceId, id);
      if (artifact) artifacts.push(artifact);
    }
    return artifacts.length ? { artifacts } : null;
  }
  if (command === 'messages.sendEmail') {
    if (typeof fields.templateId !== 'string') return null;
    const template = await publishedTemplate(tx, workspaceId, fields.templateId);
    return template ? { template } : null;
  }
  return null;
}

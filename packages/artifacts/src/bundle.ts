import { agentPolicy, autonomySettings, defineCommand, PolicyDeniedError, recordAgentAction } from '@agentic-marketing/commands';
import { AppError, canonicalJson, hashValue } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { author, requestPublish, updateDraft, validateContent } from './commands';
import { diffJson } from './diff';
import { type ArtifactType, artifactTypeEnum, artifactTypes } from './types';

// Config as code: a workspace's artifacts as one JSON bundle, to keep in git, review as diffs and
// promote from staging to production. Ids travel with the bundle (they are unique per
// workspace), so references between artifacts (a journey's template, a segment's segments) hold in
// the target workspace too. Importing goes through the same drafts and approval policy as any edit.
//
// `includeSettings` adds the non-secret workspace settings (name, time zone, approval policy,
// seed list, autonomy ceilings). Provider credentials, API tokens, agents and people are never
// part of a bundle; secrets stay in the environment or the encrypted secret store.

export const BUNDLE_FORMAT = 'agentic-marketing/artifacts@1' as const;

const TimeZone = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'timeZone must be an IANA time zone name, e.g. Europe/Copenhagen' },
  );

/** The non-secret `workspaces` columns. Never add credentials, tokens, agents or people here. */
export const BundleSettings = z
  .object({
    name: z.string().trim().min(1).max(120),
    timeZone: TimeZone,
    approvalPolicy: z.enum(['none', 'agent_changes', 'all_publishes']),
    seedList: z.array(z.email().max(320)).max(50),
    autonomy: z.record(z.string(), z.unknown()).describe('Agent autonomy ceilings and limits; defaults are filled in on import'),
  })
  .strict();

const BundleArtifact = z.object({
  id: z.string().regex(/^[a-z]{3}_[0-9a-f]{32}$/),
  type: artifactTypeEnum,
  name: z.string().min(1).max(120),
  version: z.number().int().positive().optional().describe('The version exported (informational)'),
  content: z.unknown(),
});
const Bundle = z.object({
  format: z.literal(BUNDLE_FORMAT),
  exportedAt: z.string().optional(),
  settings: BundleSettings.optional().describe('Non-secret workspace settings, present only when exported with includeSettings'),
  artifacts: z.array(BundleArtifact).max(2000),
});

const SettingsOut = BundleSettings.extend({
  autonomy: z.record(z.string(), z.unknown()),
});

export const exportConfig = defineCommand({
  name: 'config.export',
  title: 'Export artifacts as a bundle',
  description:
    'Every artifact of the workspace (published version, or the latest draft with includeDrafts) as one JSON bundle for git and config.import. includeSettings adds the non-secret workspace settings (name, time zone, approval policy, seed list, autonomy); credentials, API tokens, agents and people are never included. Archived artifacts are left out.',
  input: z.object({
    types: z.array(artifactTypeEnum).optional().describe('Only these types (default: all)'),
    includeDrafts: z.boolean().default(false).describe('Export the latest version, also when it is not published'),
    includeSettings: z
      .boolean()
      .default(false)
      .describe('Also export the non-secret workspace settings; needs workspace:admin. Never includes secrets or credentials'),
  }),
  output: Bundle.extend({ exportedAt: z.string(), settings: SettingsOut.optional() }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const rows = await ctx.tx
      .select({ a: schema.artifacts, v: schema.artifactVersions })
      .from(schema.artifacts)
      .innerJoin(
        schema.artifactVersions,
        and(
          eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
          eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        ),
      )
      .where(and(eq(schema.artifacts.archived, false), input.types ? inArray(schema.artifacts.type, input.types) : undefined));
    const artifacts = rows
      .filter(({ a, v }) => v.number === (input.includeDrafts ? a.latestVersion : a.publishedVersion))
      .sort((x, y) => x.a.type.localeCompare(y.a.type) || x.a.name.localeCompare(y.a.name) || x.a.id.localeCompare(y.a.id))
      .map(({ a, v }) => ({ id: a.id, type: a.type as ArtifactType, name: a.name, version: v.number, content: v.content }));
    let settings: z.infer<typeof SettingsOut> | undefined;
    if (input.includeSettings) {
      if (!ctx.principal.permissions.has('workspace:admin'))
        throw new AppError('forbidden', 'Exporting workspace settings needs workspace:admin.');
      const [w] = await ctx.tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, ctx.principal.workspaceId));
      settings = {
        name: w.name,
        timeZone: w.timeZone,
        approvalPolicy: w.approvalPolicy,
        seedList: w.seedList,
        autonomy: autonomySettings(w.autonomy),
      };
    }
    return {
      format: BUNDLE_FORMAT,
      exportedAt: new Date().toISOString(),
      artifacts,
      ...(settings ? { settings } : {}),
    };
  },
});

/** Publishing order: what others refer to goes first. Within a type, later passes retry what had to wait. */
const ORDER: ArtifactType[] = [
  'purposes',
  'tracking_plan',
  'delivery_policy',
  'brand',
  'segment',
  'email_block',
  'email_template',
  'sms_template',
  'push_template',
  'prompt',
  'form',
  'conversion_map',
  'experience',
  'audience_sync',
  'broadcast',
  'journey',
  'campaign',
  'note',
];

const Change = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  action: z.enum(['create', 'update', 'unchanged']),
  publish: z.enum(['published', 'in_review', 'on_hold', 'failed', 'skipped']).optional(),
  problem: z.string().optional(),
});

const SETTING_KEYS = ['name', 'timeZone', 'approvalPolicy', 'seedList', 'autonomy'] as const;

const SettingChange = z.object({
  key: z.enum(SETTING_KEYS),
  action: z.enum(['update', 'unchanged']),
  from: z.unknown(),
  to: z.unknown(),
});

type NormalizedSettings = {
  name: string;
  timeZone: string;
  approvalPolicy: 'none' | 'agent_changes' | 'all_publishes';
  seedList: string[];
  autonomy: ReturnType<typeof autonomySettings>;
};

/** Same normalisation on both sides, so a clone's dry run reports only real differences. */
function normalizeSettings(w: {
  name: string;
  timeZone: string;
  approvalPolicy: 'none' | 'agent_changes' | 'all_publishes';
  seedList: string[];
  autonomy: unknown;
}): NormalizedSettings {
  return {
    name: w.name,
    timeZone: w.timeZone,
    approvalPolicy: w.approvalPolicy,
    seedList: [...new Set(w.seedList.map((address) => address.trim().toLowerCase()))].filter(Boolean).sort(),
    autonomy: autonomySettings(w.autonomy),
  };
}

function diffSettings(current: NormalizedSettings, next: NormalizedSettings): z.infer<typeof SettingChange>[] {
  return SETTING_KEYS.map((key) => ({
    key,
    action: canonicalJson(current[key]) === canonicalJson(next[key]) ? ('unchanged' as const) : ('update' as const),
    from: current[key],
    to: next[key],
  }));
}

const DriftDetail = z.object({
  path: z.string(),
  kind: z.enum(['added', 'removed', 'changed']),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

const Drift = z.object({
  kind: z.enum(['artifact', 'setting']),
  key: z.string().describe('The artifact id or the setting name'),
  type: z.string().optional(),
  name: z.string().optional(),
  status: z.enum(['create', 'update', 'unchanged', 'conflict']),
  details: z.array(DriftDetail).optional().describe('Field-level differences, for update and conflict'),
});

export const driftConfig = defineCommand({
  name: 'config.drift',
  title: 'Compare a bundle with the workspace',
  description:
    'Read-only: compares a config.export bundle (artifacts and, when present, settings) with this workspace and lists what would be created, updated, unchanged or conflicting. Writes nothing, so it is safe to run in CI before config.import.',
  input: z.object({ bundle: Bundle }),
  output: z.object({
    format: z.literal(BUNDLE_FORMAT),
    drift: z.array(Drift),
    summary: z.object({
      create: z.number().int(),
      update: z.number().int(),
      unchanged: z.number().int(),
      conflict: z.number().int(),
    }),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    if (input.bundle.settings && !ctx.principal.permissions.has('workspace:admin'))
      throw new AppError('forbidden', 'Comparing workspace settings needs workspace:admin.');
    const existing = await ctx.tx
      .select({ a: schema.artifacts, hash: schema.artifactVersions.contentHash, content: schema.artifactVersions.content })
      .from(schema.artifacts)
      .innerJoin(
        schema.artifactVersions,
        and(
          eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
          eq(schema.artifactVersions.artifactId, schema.artifacts.id),
          eq(schema.artifactVersions.number, schema.artifacts.latestVersion),
        ),
      );
    const byId = new Map(existing.map((entry) => [entry.a.id, entry]));
    const singletons = new Map(
      existing.filter((entry) => 'singleton' in artifactTypes[entry.a.type as ArtifactType]).map((entry) => [entry.a.type, entry]),
    );
    const drift: z.infer<typeof Drift>[] = [];
    for (const item of input.bundle.artifacts) {
      const content = validateContent(item.type, item.content, 'draft');
      const current = byId.get(item.id) ?? ('singleton' in artifactTypes[item.type] ? singletons.get(item.type) : undefined);
      if (current && current.a.type !== item.type) {
        drift.push({
          kind: 'artifact',
          key: item.id,
          type: item.type,
          name: item.name,
          status: 'conflict',
          details: [{ path: 'type', kind: 'changed', before: current.a.type, after: item.type }],
        });
        continue;
      }
      const equal = current && current.hash === hashValue(content) && current.a.name === item.name;
      const status = !current ? 'create' : equal ? 'unchanged' : 'update';
      const entry: z.infer<typeof Drift> = {
        kind: 'artifact',
        key: current?.a.id ?? item.id,
        type: item.type,
        name: item.name,
        status,
      };
      if (status === 'update' && current) {
        const details = diffJson(current.content, content) as z.infer<typeof DriftDetail>[];
        if (current.a.name !== item.name) details.unshift({ path: 'name', kind: 'changed', before: current.a.name, after: item.name });
        if (details.length) entry.details = details;
      }
      drift.push(entry);
    }
    if (input.bundle.settings) {
      const [w] = await ctx.tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, ctx.principal.workspaceId));
      const current = normalizeSettings(w);
      const next = normalizeSettings(input.bundle.settings);
      for (const change of diffSettings(current, next)) {
        const details = diffJson(change.from, change.to) as z.infer<typeof DriftDetail>[];
        drift.push({
          kind: 'setting',
          key: change.key,
          status: change.action === 'unchanged' ? 'unchanged' : 'update',
          ...(details.length ? { details } : {}),
        });
      }
    }
    // Stable order for a Git-friendly report: artifacts by type/name/id, then settings by name.
    drift.sort(
      (x, y) =>
        (x.kind === y.kind ? 0 : x.kind === 'artifact' ? -1 : 1) ||
        (x.type ?? '').localeCompare(y.type ?? '') ||
        (x.name ?? '').localeCompare(y.name ?? '') ||
        x.key.localeCompare(y.key),
    );
    const count = (status: z.infer<typeof Drift>['status']) => drift.filter((entry) => entry.status === status).length;
    return {
      format: BUNDLE_FORMAT,
      drift,
      summary: { create: count('create'), update: count('update'), unchanged: count('unchanged'), conflict: count('conflict') },
    };
  },
});

export const importConfig = defineCommand({
  name: 'config.import',
  title: 'Import a bundle of artifacts',
  description:
    'Apply a bundle from config.export: creates missing artifacts (keeping their ids), puts changed content in a new draft, leaves equal ones alone. A bundle with settings also applies the non-secret workspace settings, as a person with workspace:admin. With publish, the drafts go through artifacts.requestPublish in dependency order, so the approval policy applies. Starts as a dry run; pass dryRun: false to apply. Nothing is deleted.',
  input: z.object({
    bundle: Bundle,
    dryRun: z.boolean().default(true),
    publish: z.boolean().default(false),
    note: z.string().min(1).max(1000).default('Imported from a config bundle'),
  }),
  output: z.object({ dryRun: z.boolean(), changes: z.array(Change), settings: z.array(SettingChange) }),
  permission: 'artifacts:write',
  effect: 'write',
  // The import itself writes drafts; each publish in it is decided per artifact by the policy
  // engine (its class, impact and the mandate), and bundle settings are refused to agents (#268).
  actionClass: 'draft',
  handler: async (input, ctx) => {
    if (input.publish && !input.dryRun && !ctx.principal.permissions.has('artifacts:publish'))
      throw new AppError(
        'forbidden',
        'Publishing an import needs the artifacts:publish permission. Import without publish to create drafts.',
      );
    // Settings are a person's decision, like workspace.update: never applied by an agent or token.
    if (input.bundle.settings && (ctx.principal.type !== 'user' || !ctx.principal.permissions.has('workspace:admin')))
      throw new AppError(
        'forbidden',
        'Importing workspace settings needs a person with workspace:admin. Import the artifacts without settings, or ask a person.',
      );
    const ws = ctx.principal.workspaceId;
    const existing = await ctx.tx
      .select({ a: schema.artifacts, hash: schema.artifactVersions.contentHash })
      .from(schema.artifacts)
      .innerJoin(
        schema.artifactVersions,
        and(
          eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
          eq(schema.artifactVersions.artifactId, schema.artifacts.id),
          eq(schema.artifactVersions.number, schema.artifacts.latestVersion),
        ),
      );
    const byId = new Map(existing.map((e) => [e.a.id, e]));
    const singletons = new Map(existing.filter((e) => 'singleton' in artifactTypes[e.a.type as ArtifactType]).map((e) => [e.a.type, e]));
    const changes: z.infer<typeof Change>[] = [];
    const toPublish: { id: string; type: ArtifactType; change: z.infer<typeof Change> }[] = [];
    for (const item of input.bundle.artifacts) {
      // An unknown type (a typo, a bundle from a newer release) is invalid input, not a crash (#247).
      const def = artifactTypes[item.type as ArtifactType] as { peopleOnly?: boolean } | undefined;
      if (!def)
        throw new AppError(
          'invalid_input',
          `${item.id} has the type "${item.type}", which this server does not know. Call artifacts.types for the list.`,
        );
      if (ctx.principal.type === 'agent' && def.peopleOnly)
        throw new AppError('forbidden', `${item.id} is a ${item.type}: only people can import it.`);
      const content = validateContent(item.type, item.content, 'draft');
      // A workspace has one of each singleton type, whatever its id.
      const current = byId.get(item.id) ?? ('singleton' in artifactTypes[item.type] ? singletons.get(item.type) : undefined);
      if (current && current.a.type !== item.type)
        throw new AppError('conflict', `${item.id} is a ${current.a.type} here, not a ${item.type}.`);
      const id = current?.a.id ?? item.id;
      const action = !current ? 'create' : current.hash !== hashValue(content) || current.a.name !== item.name ? 'update' : 'unchanged';
      const change: z.infer<typeof Change> = { id, type: item.type, name: item.name, action };
      changes.push(change);
      if (input.dryRun || action === 'unchanged') continue;
      if (action === 'create') {
        await ctx.tx.insert(schema.artifacts).values({ workspaceId: ws, id, type: item.type, name: item.name, latestVersion: 1 });
        await ctx.tx.insert(schema.artifactVersions).values({
          workspaceId: ws,
          artifactId: id,
          number: 1,
          state: 'draft',
          content,
          contentHash: hashValue(content),
          note: input.note,
          ...author(ctx),
        });
      } else await updateDraft.handler({ artifactId: id, content, name: item.name, note: input.note }, ctx);
      if (input.publish) toPublish.push({ id, type: item.type, change });
    }
    // Settings go in after the drafts and before publishing, so a clone publishes under the copied
    // approval policy rather than the empty target's default.
    let settingChanges: z.infer<typeof SettingChange>[] = [];
    if (input.bundle.settings) {
      const [w] = await ctx.tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws));
      const current = normalizeSettings(w);
      const next = normalizeSettings(input.bundle.settings);
      settingChanges = diffSettings(current, next);
      if (!input.dryRun) await ctx.tx.update(schema.workspaces).set(next).where(eq(schema.workspaces.id, ws));
    }

    // An agent's publishes are decided one by one, exactly as artifacts.requestPublish would decide
    // them (its class, its reach, the threshold, the mandate), and each is recorded in the ledger
    // (#239). The import's own decision (class settings) only covers creating the drafts.
    const publishOne = async (artifactId: string) => {
      const agent = ctx.principal.agent;
      if (!agent) return requestPublish.handler({ artifactId, note: input.note }, ctx);
      const request = { artifactId, note: input.note };
      const impact = await requestPublish.impact!(request, ctx);
      const policy = await agentPolicy(ctx.tx, ctx.services, ctx.principal, {
        command: requestPublish.name,
        actionClass: impact.actionClass ?? 'content.publish',
        impact,
        approvable: true,
        input: request,
      });
      if (policy.decision === 'deny') {
        await recordAgentAction(ctx.tx, agent.id, requestPublish, policy, 'internal', artifactId, policy.reasons.join(' '), input.note);
        throw new PolicyDeniedError(policy);
      }
      // Each publish sets its own reversal; a held step leaves the collector empty.
      ctx.undo?.set(null);
      const out = await requestPublish.handler(request, { ...ctx, policy });
      // The same facts the executor adds after requestPublish, e.g. the approval it created (#293).
      const extra = requestPublish.ledgerImpact?.(out);
      const recorded = extra ? { ...policy, impact: { ...policy.impact, ...extra } } : policy;
      await recordAgentAction(
        ctx.tx,
        agent.id,
        requestPublish,
        recorded,
        'internal',
        artifactId,
        null,
        input.note,
        ctx.undo?.get() ?? null,
      );
      return out;
    };
    // Publish in dependency order; what fails for want of another artifact is retried in a later pass.
    let pending = toPublish.sort((x, y) => ORDER.indexOf(x.type) - ORDER.indexOf(y.type));
    for (let pass = 0; pending.length && pass < 5; pass++) {
      const failed: typeof pending = [];
      for (const p of pending)
        try {
          p.change.publish = (await publishOne(p.id)).status;
          p.change.problem = undefined;
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          p.change.publish = 'failed';
          p.change.problem = err.message;
          // A refusal by the agent policy is final; other failures may need another artifact first.
          if (!(err instanceof PolicyDeniedError)) failed.push(p);
        }
      if (failed.length === pending.length) break;
      pending = failed;
    }
    for (const c of changes) if (input.publish && !input.dryRun && c.action === 'unchanged') c.publish = 'skipped';
    // The nested publishes recorded their own reversals; the import itself is not undoable as a whole.
    ctx.undo?.set(null);
    return { dryRun: input.dryRun, changes, settings: settingChanges };
  },
});

export const configCommands = [exportConfig, importConfig, driftConfig] as const;

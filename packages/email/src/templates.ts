import {
  contentValidators,
  DEFAULT_PURPOSES,
  type EmailTemplate,
  publishedSingleton,
  publishValidators,
} from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema, type Tx } from '@agentic-marketing/db';
import type { HotState } from '@agentic-marketing/hotstate';
import { profileForMessage } from '@agentic-marketing/profiles';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { blockPublishProblems, blockResolver } from './blocks';
import { type AssetInfo, checkEmailTemplate, emailPublishProblems, type LinkCache, memoryLinkCache } from './checks';
import { isMarketing } from './policy';
import { renderTemplate, validateTemplate } from './render';
import { sendTestMessages, testRecipientsInput, testSendOutput } from './testSend';

contentValidators.set('email_template', (c) => validateTemplate(c as EmailTemplate));

// Publishing runs the same checks as templates.check, without link reachability: a blocking finding
// (no unsubscribe link, a javascript: link, a missing asset) refuses the publish; warnings never do.
publishValidators.set('email_template', async (content, tx) => {
  // Blocks first: a template naming an unpublished block can't render, so the checks below can't run.
  const blockProblems = await blockPublishProblems(content, tx);
  if (blockProblems.length) return blockProblems;
  const t = content as EmailTemplate;
  const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
  const purpose = purposes.find((p) => p.key === t.purpose);
  return emailPublishProblems(t, {
    marketing: isMarketing(purpose?.basis ?? 'consent'),
    purposeChannels: purpose?.channels,
    assets: (ids) => assetInfo(tx, ids),
    render: { blocks: blockResolver(tx) },
  });
});

export const previewTemplate = defineCommand({
  name: 'templates.preview',
  title: 'Preview an e-mail template',
  description:
    'Render a template version (default: the latest) to subject, HTML and text, with its sample data, data you pass, or a real person (needs profiles:pii). Nothing is sent.',
  input: z.object({
    artifactId: z.string().regex(/^eml_[0-9a-f]{32}$/),
    version: z.number().int().min(1).optional(),
    data: z.record(z.string(), z.unknown()).optional().describe('Variables, merged over the template sample data'),
    profileId: z
      .string()
      .regex(/^prf_[0-9a-f]{32}$/)
      .optional(),
  }),
  output: z.object({
    version: z.number().int(),
    subject: z.string(),
    preheader: z.string().optional(),
    html: z.string(),
    text: z.string(),
    warnings: z.array(z.string()),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const [v] = await ctx.tx
      .select()
      .from(schema.artifactVersions)
      .where(
        and(
          eq(schema.artifactVersions.artifactId, input.artifactId),
          input.version ? eq(schema.artifactVersions.number, input.version) : undefined,
        ),
      )
      .orderBy(desc(schema.artifactVersions.number))
      .limit(1);
    if (!v) throw new AppError('not_found', `No template ${input.artifactId}${input.version ? ` version ${input.version}` : ''}.`);
    const t = v.content as EmailTemplate;
    let vars: Record<string, unknown> = { ...(t.sampleData ?? {}), ...(input.data ?? {}) };
    if (input.profileId) {
      if (!ctx.principal.permissions.has('profiles:pii'))
        throw new AppError(
          'forbidden',
          'Previewing with a real person shows their personal data and needs profiles:pii. Use sample data instead.',
        );
      const p = await profileForMessage(ctx.tx, ctx.principal.workspaceId, input.profileId, ctx.services.keyProvider);
      if (!p) throw new AppError('not_found', `No profile ${input.profileId}.`);
      vars = { ...vars, profile: p.vars };
    }
    try {
      return { version: v.number, ...(await renderTemplate(t, vars, { blocks: blockResolver(ctx.tx) })) };
    } catch (e) {
      throw new AppError('invalid_input', `The template could not be rendered with this data: ${(e as Error).message.split('\n')[0]}`);
    }
  },
});

export const sendTestEmail = defineCommand({
  name: 'templates.sendTest',
  title: 'Send a test e-mail',
  description:
    'Send a template version through the provider the real send would use: by default the latest draft (or the latest version when there is no draft). Recipients are limited to workspace members and the admin-configured seed list (workspace.setSeedList), at most 10 per call; `to` defaults to you. Rendered with each recipient’s profile when the workspace knows their address, otherwise with sample data, and with "[Test]" in the subject. Purpose/consent checks are skipped, suppressions still apply, and each copy is recorded as a test message (never counted in reporting) and an audit entry. No profile or consent is written; agents drafting newsletters can run it with the artifacts:write scope. Approvers may run it without `to`, sending to themselves only.',
  input: z.object({
    artifactId: z.string().regex(/^eml_[0-9a-f]{32}$/),
    version: z.number().int().min(1).optional().describe('Default: the latest draft, else the latest version'),
    to: testRecipientsInput,
  }),
  output: testSendOutput,
  permission: 'artifacts:write',
  // An approver often wants the e-mail in their own inbox before approving; a test to anyone else
  // still needs artifacts:write.
  selfService: { permission: 'artifacts:approve', allows: (input) => input.to === undefined },
  effect: 'write',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const [artifact] = await ctx.tx
      .select({ latestVersion: schema.artifacts.latestVersion })
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.id, input.artifactId), eq(schema.artifacts.type, 'email_template')));
    if (!artifact) throw new AppError('not_found', `No e-mail template ${input.artifactId}.`);
    let version: number;
    if (input.version) version = input.version;
    else {
      const [draft] = await ctx.tx
        .select({ number: schema.artifactVersions.number })
        .from(schema.artifactVersions)
        .where(and(eq(schema.artifactVersions.artifactId, input.artifactId), eq(schema.artifactVersions.state, 'draft')))
        .orderBy(desc(schema.artifactVersions.number))
        .limit(1);
      version = draft?.number ?? artifact.latestVersion;
    }
    const [v] = await ctx.tx
      .select()
      .from(schema.artifactVersions)
      .where(and(eq(schema.artifactVersions.artifactId, input.artifactId), eq(schema.artifactVersions.number, version)));
    if (!v) throw new AppError('not_found', `No template ${input.artifactId} version ${version}.`);
    const t = v.content as EmailTemplate;

    // The provider is the one the real send would use for this purpose's stream.
    const purposes = (await publishedSingleton(ctx.tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
    const basis = purposes.find((p) => p.key === t.purpose)?.basis ?? 'consent';
    const stream = basis === 'contract' || basis === 'legal_obligation' ? 'transactional' : 'marketing';
    return sendTestMessages(ctx, {
      templateId: input.artifactId,
      templateVersion: version,
      template: t,
      purpose: t.purpose,
      stream,
      to: input.to,
    });
  },
});

const CheckFinding = z.object({
  id: z.string().describe('Stable across runs; the same problem keeps the same id'),
  severity: z.enum(['blocking', 'warning', 'info']),
  category: z.enum(['compliance', 'links', 'images', 'rendering', 'personalisation', 'subject']),
  message: z.string(),
  location: z.string().optional().describe('The link, image, field or purpose the finding is about'),
  fix: z.string().optional().describe('The concrete change that resolves it'),
});

/** Image sizes come from the asset table; the checker never fetches an image itself. */
async function assetInfo(tx: Tx, ids: string[]): Promise<Map<string, AssetInfo>> {
  if (!ids.length) return new Map();
  const rows = await tx
    .select({
      id: schema.assets.id,
      byteSize: schema.assets.byteSize,
      contentType: schema.assets.contentType,
      width: schema.assets.width,
      height: schema.assets.height,
    })
    .from(schema.assets)
    .where(and(inArray(schema.assets.id, ids), isNull(schema.assets.deletedAt)));
  const renditions = await tx
    .select({ assetId: schema.assetRenditions.assetId, byteSize: schema.assetRenditions.byteSize })
    .from(schema.assetRenditions)
    .where(inArray(schema.assetRenditions.assetId, ids));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        byteSize: r.byteSize,
        contentType: r.contentType,
        width: r.width,
        height: r.height,
        renditionByteSize: renditions.find((x) => x.assetId === r.id)?.byteSize ?? null,
      },
    ]),
  );
}

/** Link results are shared by every process through Valkey when it is available, else kept here. */
function linkCache(hot: HotState | undefined): LinkCache {
  if (!hot) return memoryLinkCache;
  return {
    get: (key) => hot.cached(key).catch(() => null),
    set: async (key, value, ttlSeconds) => {
      await hot.cache(key, value, ttlSeconds).catch(() => {});
    },
  };
}

/** Our own links: assets, unsubscribe, click tracking, confirmation and the web version. */
function platformUrl(emailUrl: string) {
  let own: URL | null = null;
  try {
    own = new URL(emailUrl);
  } catch {
    own = null;
  }
  return (raw: string) => {
    try {
      const u = new URL(raw);
      // example.invalid is the placeholder render uses for links only a real send can build.
      return (own !== null && u.host === own.host) || /(^|\.)invalid$/i.test(u.hostname);
    } catch {
      return false;
    }
  };
}

async function templateVersion(ctx: { tx: Tx }, artifactId: string, version?: number) {
  const [v] = await ctx.tx
    .select()
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, artifactId), version ? eq(schema.artifactVersions.number, version) : undefined))
    .orderBy(desc(schema.artifactVersions.number))
    .limit(1);
  return v;
}

export const checkTemplate = defineCommand({
  name: 'templates.check',
  title: 'Check an e-mail before sending',
  description:
    'Run the pre-send checks on a template version (default: the latest), rendered with its sample data as the preview is: unsubscribe and purpose compliance, links (malformed, unsafe schemes, shorteners, missing text), images (alt text, missing assets, weight, SVG), rendering size and preheader, unresolved personalisation, and the subject line. Returns concrete findings with severity, category, location and a fix; nothing is sent. Always run it before artifacts.requestPublish and fix what it finds. Blocking findings also stop publishing. With checkLinks: true it also fetches up to 30 links (HEAD, GET fallback, 5 s timeout, serial by 4, cached for an hour): 404/410/5xx are warnings, 401/403/405 are unverified notes. It never fetches a personalised URL or the platform’s own links, and private addresses are refused by the egress policy.',
  input: z.object({
    artifactId: z.string().regex(/^eml_[0-9a-f]{32}$/),
    version: z.number().int().min(1).optional(),
    checkLinks: z.boolean().optional().describe('Also fetch the links (slow, up to about 30); off by default so checks stay instant'),
  }),
  output: z.object({
    version: z.number().int(),
    findings: z.array(CheckFinding),
    checkedAt: z.string(),
    summary: z.object({ blocking: z.number().int(), warning: z.number().int(), info: z.number().int() }),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const v = await templateVersion(ctx, input.artifactId, input.version);
    if (!v) throw new AppError('not_found', `No template ${input.artifactId}${input.version ? ` version ${input.version}` : ''}.`);
    const t = v.content as EmailTemplate;
    const purposes = (await publishedSingleton(ctx.tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
    const purpose = purposes.find((p) => p.key === t.purpose);
    let result: Awaited<ReturnType<typeof checkEmailTemplate>>;
    try {
      result = await checkEmailTemplate(t, {
        marketing: isMarketing(purpose?.basis ?? 'consent'),
        purposeChannels: purpose?.channels,
        checkLinks: input.checkLinks ?? false,
        platformUrl: platformUrl(ctx.services.email.publicUrl),
        request: ctx.services.email.checkLinks,
        assets: (ids) => assetInfo(ctx.tx, ids),
        cache: linkCache(ctx.services.hot),
        render: { blocks: blockResolver(ctx.tx) },
      });
    } catch (e) {
      throw new AppError('invalid_input', `The template could not be rendered with this data: ${(e as Error).message.split('\n')[0]}`);
    }
    return { version: v.number, ...result };
  },
});

export const templateCommands = [previewTemplate, sendTestEmail, checkTemplate] as const;

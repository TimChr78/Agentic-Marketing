import { contentValidators, DEFAULT_PURPOSES, type EmailTemplate, publishedSingleton } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { profileForMessage } from '@agentic-marketing/profiles';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { renderTemplate, validateTemplate } from './render';
import { sendTestMessages, testRecipientsInput, testSendOutput } from './testSend';

contentValidators.set('email_template', (c) => validateTemplate(c as EmailTemplate));

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
      return { version: v.number, ...(await renderTemplate(t, vars)) };
    } catch (e) {
      throw new AppError('invalid_input', `The template could not be rendered with this data: ${(e as Error).message.split('\n')[0]}`);
    }
  },
});

export const sendTestEmail = defineCommand({
  name: 'templates.sendTest',
  title: 'Send a test e-mail',
  description:
    'Send a template version through the provider the real send would use: by default the latest draft (or the latest version when there is no draft). Recipients are limited to workspace members and the admin-configured seed list (workspace.setSeedList), at most 10 per call; `to` defaults to you. Rendered with each recipient’s profile when the workspace knows their address, otherwise with sample data, and with "[Test]" in the subject. Purpose/consent checks are skipped, suppressions still apply, and each copy is recorded as a test message (never counted in reporting) and an audit entry. No profile or consent is written; agents drafting newsletters can run it with the artifacts:write scope.',
  input: z.object({
    artifactId: z.string().regex(/^eml_[0-9a-f]{32}$/),
    version: z.number().int().min(1).optional().describe('Default: the latest draft, else the latest version'),
    to: testRecipientsInput,
  }),
  output: testSendOutput,
  permission: 'artifacts:write',
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

export const templateCommands = [previewTemplate, sendTestEmail] as const;

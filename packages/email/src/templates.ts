import { contentValidators, DEFAULT_PURPOSES, type EmailTemplate, publishedSingleton } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newUuid } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { profileForMessage } from '@agentic-marketing/profiles';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { tagLinks } from './links';
import { transportFor } from './providers';
import { renderTemplate, validateTemplate } from './render';

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

/** People's names and e-mail addresses (provided by the auth package). */
interface MemberDirectory {
  users(ids: string[]): Promise<Map<string, { email: string; name: string }>>;
}

export const sendTestEmail = defineCommand({
  name: 'templates.sendTest',
  title: 'Send a test e-mail',
  description:
    'Send a template version (default: the latest, drafts included) to a member of this workspace (default: you), rendered with its sample data and "[Test]" in the subject, through the provider the real send would use. Not recorded as a message; links are not tracked.',
  input: z.object({
    artifactId: z.string().regex(/^eml_[0-9a-f]{32}$/),
    version: z.number().int().min(1).optional(),
    to: z.email().optional().describe("A workspace member's e-mail address; default: the caller's"),
  }),
  output: z.object({ to: z.string(), subject: z.string(), provider: z.string() }),
  permission: 'messages:send',
  effect: 'write',
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
    if (!v) throw new AppError('not_found', `No template ${input.artifactId}.`);
    const t = v.content as EmailTemplate;
    // Only to members: a test send must never become a way to mail arbitrary people.
    const directory = (ctx.services as { directory?: MemberDirectory }).directory;
    const memberIds = (await ctx.tx.select({ userId: schema.workspaceMembers.userId }).from(schema.workspaceMembers)).map((m) => m.userId);
    const members = directory ? await directory.users(memberIds) : new Map();
    const emails = new Map([...members].map(([id, u]) => [u.email.toLowerCase(), id]));
    const own = members.get(ctx.principal.userId)?.email;
    const to = (input.to ?? own ?? '').toLowerCase();
    if (!emails.has(to)) throw new AppError('forbidden', 'Test e-mails go to members of this workspace only.');

    const purposes = (await publishedSingleton(ctx.tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
    const basis = purposes.find((p) => p.key === t.purpose)?.basis ?? 'consent';
    const stream = basis === 'contract' || basis === 'legal_obligation' ? 'transactional' : 'marketing';
    const provider = (await ctx.tx.select().from(schema.emailProviders).where(eq(schema.emailProviders.enabled, true))).find((p) =>
      p.useFor.includes(stream),
    );
    if (!provider) throw new AppError('conflict', `No enabled e-mail provider is set up for ${stream} messages.`);
    let rendered: Awaited<ReturnType<typeof renderTemplate>>;
    try {
      rendered = await renderTemplate(t, {
        ...(t.sampleData ?? {}),
        unsubscribe_url: `${ctx.services.email.publicUrl}/u/test`,
        preferences_url: `${ctx.services.email.publicUrl}/u/test`,
        confirm_url: `${ctx.services.email.publicUrl}/f/confirm/test`,
      });
    } catch (e) {
      throw new AppError('invalid_input', `The template could not be rendered: ${(e as Error).message.split('\n')[0]}`);
    }
    const html = t.utm ? tagLinks(rendered.html, t.utm, [ctx.services.email.publicUrl]) : rendered.html;
    const transport = await transportFor(ctx.tx, provider, ctx.services.keyProvider, ctx.services.email.adapterDeps);
    const subject = `[Test] ${rendered.subject}`;
    try {
      await transport.send({
        messageId: `test_${newUuid()}`,
        from: { email: provider.fromEmail, name: provider.fromName || undefined },
        replyTo: provider.replyTo ?? undefined,
        to,
        subject,
        html,
        text: rendered.text,
        headers: {},
        stream,
      });
    } catch (e) {
      throw new AppError('conflict', `${provider.name} refused the test e-mail: ${(e as Error).message}`);
    }
    return { to, subject, provider: provider.name };
  },
});

export const templateCommands = [previewTemplate, sendTestEmail] as const;

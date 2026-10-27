import type { EmailTemplate } from '@agentic-marketing/artifacts';
import type { CommandContext } from '@agentic-marketing/commands';
import { AppError, newId, newUuid } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { personCrypto, profileForMessage } from '@agentic-marketing/profiles';
import { logger } from '@agentic-marketing/telemetry';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { MESSAGE_ID_HEADER } from './adapters';
import { blockResolver } from './blocks';
import { tagLinks, tagTextLinks } from './links';
import { transportFor } from './providers';
import { renderTemplate } from './render';

// Test sends (#46): the same template and provider a real send would use, to a workspace member
// or an address on the admin-configured seed list. Purpose and consent are skipped on purpose;
// the message is recorded as a test, no profile or consent is written, and links stay inert.

const MAX_RECIPIENTS = 10;

/** Test recipients: a member address, the seed list, or up to ten of those. */
export const testRecipientsInput = z
  .union([z.email().max(320), z.array(z.email().max(320)).min(1).max(MAX_RECIPIENTS)])
  .optional()
  .describe('Workspace members or seed-list addresses; default: you');

export const testSendOutput = z.object({
  to: z.string().describe('The recipients, comma-separated'),
  subject: z.string(),
  provider: z.string(),
  recipients: z.array(z.string()),
  messages: z.array(
    z.object({
      email: z.string(),
      messageId: z.string(),
      status: z.string(),
      reason: z.string().nullable(),
      subject: z.string(),
    }),
  ),
  skipped: z.array(z.object({ email: z.string(), reason: z.string() })),
});

/** People's names and e-mail addresses (provided by the auth package). */
interface MemberDirectory {
  users(ids: string[]): Promise<Map<string, { email: string; name: string }>>;
}

export interface TestSendOptions {
  templateId: string;
  templateVersion: number;
  template: EmailTemplate;
  purpose: string;
  stream: 'marketing' | 'transactional';
  /** Broadcast id when this is a broadcast test, so the message log shows where it came from. */
  journeyId?: string | null;
  to?: string | string[];
}

export interface TestSendResult {
  /** The recipients, comma-separated (kept for the single-recipient shape of earlier versions). */
  to: string;
  subject: string;
  provider: string;
  recipients: string[];
  messages: { email: string; messageId: string; status: string; reason: string | null; subject: string }[];
  skipped: { email: string; reason: string }[];
}

const normalize = (email: string) => email.trim().toLowerCase();

/**
 * Sends one test copy per recipient through the configured provider for `stream`, recording a
 * message row with `test = true` for each. Recipients must be members or on the workspace's seed
 * list; suppressed addresses are recorded but not sent.
 */
export async function sendTestMessages(ctx: CommandContext, opts: TestSendOptions): Promise<TestSendResult> {
  const ws = ctx.principal.workspaceId;
  const directory = (ctx.services as { directory?: MemberDirectory }).directory;
  const requested = (opts.to === undefined ? [] : Array.isArray(opts.to) ? opts.to : [opts.to]).map(normalize);
  const memberIds = (await ctx.tx.select({ userId: schema.workspaceMembers.userId }).from(schema.workspaceMembers)).map((m) => m.userId);
  const people = directory ? await directory.users(memberIds) : new Map<string, { email: string; name: string }>();
  const members = new Set([...people.values()].map((u) => normalize(u.email)));
  if (!requested.length) {
    const own = directory ? (await directory.users([ctx.principal.userId])).get(ctx.principal.userId)?.email : undefined;
    if (!own) throw new AppError('invalid_input', 'Pass `to` with one or more e-mail addresses; your own address is unknown.');
    requested.push(normalize(own));
  }
  // A test send must never become a way to mail arbitrary people.
  const [workspace] = await ctx.tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws));
  const seed = new Set((workspace?.seedList ?? []).map(normalize));
  const recipients = [...new Set(requested)];
  if (recipients.length > MAX_RECIPIENTS)
    throw new AppError('invalid_input', `A test send goes to at most ${MAX_RECIPIENTS} addresses; ${recipients.length} were given.`);
  for (const email of recipients) {
    if (!members.has(email) && !seed.has(email))
      throw new AppError(
        'forbidden',
        `${email} is not a member of this workspace or on its seed list. Test e-mails go only to members of this workspace or addresses an admin added with workspace.setSeedList.`,
      );
  }

  const providers = await ctx.tx.select().from(schema.emailProviders).where(eq(schema.emailProviders.enabled, true));
  const provider = providers.find((p) => p.useFor.includes(opts.stream));
  if (!provider) throw new AppError('conflict', `No enabled e-mail provider is set up for ${opts.stream} messages.`);

  // Inert links: the /u/ route refuses a token it did not sign, so a test can never unsubscribe
  // anyone. No click tracking is added either.
  const noop = `${ctx.services.email.publicUrl}/u/test`;
  const crypto = personCrypto(ctx.tx, ws, ctx.services.keyProvider);
  const transport = await transportFor(ctx.tx, provider, ctx.services.keyProvider, ctx.services.email.adapterDeps);

  const messages: TestSendResult['messages'] = [];
  const skipped: TestSendResult['skipped'] = [];
  try {
    for (const email of recipients) {
      const recipientHash = await crypto.matchHash('email', email);
      const [sup] = await ctx.tx
        .select()
        .from(schema.suppressions)
        .where(and(eq(schema.suppressions.channel, 'email'), eq(schema.suppressions.valueHash, recipientHash)));
      if (sup) {
        const reason = `suppressed: the address is on the suppression list (${sup.reason})`;
        const [m] = await ctx.tx
          .insert(schema.messages)
          .values({
            workspaceId: ws,
            id: newId('msg'),
            idempotencyKey: `test:${newUuid()}`,
            profileId: null,
            purpose: opts.purpose,
            templateId: opts.templateId,
            templateVersion: opts.templateVersion,
            journeyId: opts.journeyId ?? null,
            providerId: provider.id,
            status: 'suppressed',
            reason,
            recipientHash,
            test: true,
          })
          .returning();
        skipped.push({ email, reason });
        messages.push({ email, messageId: m.id, status: m.status, reason, subject: '' });
        continue;
      }

      // Render with the person if this workspace knows the address; never create a profile.
      const [ident] = await ctx.tx
        .select({ profileId: schema.identifiers.profileId })
        .from(schema.identifiers)
        .where(
          and(eq(schema.identifiers.workspaceId, ws), eq(schema.identifiers.type, 'email'), eq(schema.identifiers.value, recipientHash)),
        );
      const person = ident ? await profileForMessage(ctx.tx, ws, ident.profileId, ctx.services.keyProvider) : null;
      const [message] = await ctx.tx
        .insert(schema.messages)
        .values({
          workspaceId: ws,
          id: newId('msg'),
          idempotencyKey: `test:${newUuid()}`,
          profileId: person?.id ?? null,
          purpose: opts.purpose,
          templateId: opts.templateId,
          templateVersion: opts.templateVersion,
          journeyId: opts.journeyId ?? null,
          providerId: provider.id,
          status: 'sending',
          recipientHash,
          test: true,
        })
        .returning();

      let rendered: Awaited<ReturnType<typeof renderTemplate>>;
      try {
        rendered = await renderTemplate(
          opts.template,
          {
            ...(opts.template.sampleData ?? {}),
            profile: person?.vars ?? {},
            unsubscribe_url: noop,
            preferences_url: noop,
            confirm_url: `${ctx.services.email.publicUrl}/f/confirm/test`,
          },
          { blocks: blockResolver(ctx.tx) },
        );
      } catch (e) {
        const reason = `render_error: ${(e as Error).message.split('\n')[0]}`;
        await ctx.tx
          .update(schema.messages)
          .set({ status: 'failed', reason, updatedAt: new Date() })
          .where(eq(schema.messages.id, message.id));
        skipped.push({ email, reason });
        messages.push({ email, messageId: message.id, status: 'failed', reason, subject: '' });
        continue;
      }

      const subject = `[Test] ${rendered.subject}`;
      const html = opts.template.utm ? tagLinks(rendered.html, opts.template.utm, [noop]) : rendered.html;
      const text = opts.template.utm ? tagTextLinks(rendered.text, opts.template.utm, [noop]) : rendered.text;
      try {
        const { providerMessageId } = await transport.send({
          messageId: message.id,
          from: { email: provider.fromEmail, name: provider.fromName || undefined },
          replyTo: provider.replyTo ?? undefined,
          to: email,
          subject,
          html,
          text,
          headers: { [MESSAGE_ID_HEADER]: message.id },
          stream: opts.stream,
        });
        await ctx.tx
          .update(schema.messages)
          .set({ status: 'sent', reason: null, providerMessageId, updatedAt: new Date() })
          .where(eq(schema.messages.id, message.id));
        messages.push({ email, messageId: message.id, status: 'sent', reason: null, subject });
      } catch (e) {
        const reason = `provider_error: ${(e as Error).message.split('\n')[0]}`;
        logger.warn({ messageId: message.id, provider: provider.adapter, err: (e as Error).message }, 'test e-mail send failed');
        await ctx.tx
          .update(schema.messages)
          .set({ status: 'failed', reason, updatedAt: new Date() })
          .where(eq(schema.messages.id, message.id));
        skipped.push({ email, reason });
        messages.push({ email, messageId: message.id, status: 'failed', reason, subject: '' });
      }
    }
  } finally {
    await transport.close?.();
  }

  const sent = messages.filter((m) => m.status === 'sent');
  if (!sent.length && skipped.length) throw new AppError('conflict', `${provider.name} refused the test e-mail: ${skipped[0].reason}`);
  return {
    to: recipients.join(', '),
    subject: sent[0]?.subject ?? messages[0]?.subject ?? '',
    provider: provider.name,
    recipients,
    messages,
    skipped,
  };
}

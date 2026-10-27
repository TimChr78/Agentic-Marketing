import { contentValidators, DEFAULT_PURPOSES, publishedSingleton, publishValidators, type SmsTemplate } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { isMarketing } from '../policy';
import { topicProblems } from '../topicValidation';
import { requestSms } from './gateway';
import { billingOf } from './providers';
import { renderSms, validateSmsTemplate } from './render';

contentValidators.set('sms_template', (c) => validateSmsTemplate(c as SmsTemplate));
publishValidators.set('sms_template', async (c, tx) => topicProblems(tx, (c as SmsTemplate).purpose, (c as SmsTemplate).topic));

const Status = z.enum(['queued', 'sending', 'sent', 'suppressed', 'failed', 'delivered', 'bounced', 'complained']);

export const sendSms = defineCommand({
  name: 'messages.sendSms',
  title: 'Send a text message to a person',
  description:
    "Ask the send gateway to text one person with a published SMS template. Same checks as e-mail (lawful basis, consent, suppression, delivery policy) plus the provider's monthly budget; the answer says whether it was queued or why not. Repeat-safe with `idempotencyKey`.",
  input: z.object({
    profileId: z.string().regex(/^prf_[0-9a-f]{32}$/),
    templateId: z.string().regex(/^sms_[0-9a-f]{32}$/),
    idempotencyKey: z.string().min(1).max(200).optional(),
    data: z.record(z.string(), z.unknown()).optional().describe('Extra template variables'),
  }),
  output: z.object({ messageId: z.string(), status: Status, reason: z.string().nullable(), duplicate: z.boolean() }),
  permission: 'messages:send',
  effect: 'write',
  target: (i) => i.profileId,
  handler: async (input, ctx) => requestSms(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, ctx.services.events, input),
});

export const previewSms = defineCommand({
  name: 'smsTemplates.preview',
  title: 'Preview an SMS template',
  description:
    'Render an SMS template version (default: the latest) with its sample data or data you pass: the text as sent (with the opt-out footer for marketing), its encoding, segments, and the estimated cost with the provider that would send it.',
  input: z.object({
    artifactId: z.string().regex(/^sms_[0-9a-f]{32}$/),
    version: z.number().int().min(1).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
  output: z.object({
    version: z.number().int(),
    body: z.string(),
    encoding: z.enum(['GSM-7', 'UCS-2']),
    length: z.number(),
    segments: z.number(),
    estimatedCost: z.object({ amount: z.number(), currency: z.string() }).nullable(),
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
    if (!v) throw new AppError('not_found', `No SMS template ${input.artifactId}.`);
    const t = v.content as SmsTemplate;
    const purposes = (await publishedSingleton(ctx.tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
    const basis = purposes.find((p) => p.key === t.purpose)?.basis ?? 'consent';
    let text: Awaited<ReturnType<typeof renderSms>>;
    try {
      text = await renderSms(t, { ...(t.sampleData ?? {}), ...(input.data ?? {}) }, isMarketing(basis));
    } catch (e) {
      throw new AppError('invalid_input', `The template could not be rendered with this data: ${(e as Error).message.split('\n')[0]}`);
    }
    const stream = isMarketing(basis) ? 'marketing' : 'transactional';
    const provider = (await ctx.tx.select().from(schema.smsProviders).where(eq(schema.smsProviders.enabled, true))).find((p) =>
      p.useFor.includes(stream),
    );
    const billing = provider ? billingOf(provider) : null;
    const warnings: string[] = [];
    if (text.segments > 1) warnings.push(`${text.segments} segments: each is charged`);
    if (text.encoding === 'UCS-2') warnings.push('Characters outside GSM-7 (e.g. emoji) cut a segment to 70 characters');
    if (!purposes.find((p) => p.key === t.purpose)?.channels.includes('sms'))
      warnings.push(`Purpose "${t.purpose}" is not marked for the sms channel`);
    return {
      version: v.number,
      body: text.body,
      encoding: text.encoding,
      length: text.length,
      segments: text.segments,
      estimatedCost: billing
        ? { amount: Math.round(text.segments * billing.pricePerSegment * 10_000) / 10_000, currency: billing.currency }
        : null,
      warnings,
    };
  },
});

export const smsCommands = [sendSms, previewSms] as const;

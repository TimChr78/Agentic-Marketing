import { Resolver } from 'node:dns/promises';
import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { deliveryPolicy, streamRates } from './policy';

// Deliverability (Phase 7): are the sending domain's DNS records in place, and are bounce and
// complaint rates within what mailbox providers accept (Gmail and Yahoo: complaints under 0.3%)?

/** What each provider's SPF include looks like, to say whether it is there. */
const SPF_INCLUDE: Partial<Record<string, string>> = {
  ses: 'amazonses.com',
  postmark: 'spf.mtasv.net',
  brevo: 'spf.brevo.com',
  cloudflare: '_spf.mx.cloudflare.net',
};

export interface TxtResolver {
  resolveTxt(name: string): Promise<string[][]>;
}

const txt = async (r: TxtResolver, name: string) => {
  try {
    return (await r.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch {
    return [];
  }
};

const Check = z.object({ ok: z.boolean(), record: z.string().nullable(), advice: z.string().nullable() });
const DomainReport = z.object({
  domain: z.string(),
  ok: z.boolean(),
  spf: Check,
  dkim: z.array(z.object({ selector: z.string(), ok: z.boolean(), record: z.string().nullable() })),
  dmarc: Check.extend({ policy: z.string().nullable() }),
});
export type DomainReport = z.infer<typeof DomainReport>;

/** SPF, DKIM (for the given selectors) and DMARC of a sending domain. */
export async function checkDomainRecords(domain: string, adapter: string, selectors: string[], r: TxtResolver): Promise<DomainReport> {
  const include = SPF_INCLUDE[adapter];
  const spfRecord = (await txt(r, domain)).find((t) => t.toLowerCase().startsWith('v=spf1')) ?? null;
  const spfOk = !!spfRecord && (!include || spfRecord.includes(include));
  const spf = {
    ok: spfOk,
    record: spfRecord,
    advice: spfOk
      ? null
      : spfRecord
        ? `Add include:${include} to the SPF record (or use the provider's custom MAIL FROM domain).`
        : `Add a TXT record at ${domain}: "v=spf1${include ? ` include:${include}` : ''} ~all".`,
  };
  const dkim = await Promise.all(
    selectors.map(async (selector) => {
      const record = (await txt(r, `${selector}._domainkey.${domain}`)).find((t) => /(^|;)\s*(v=DKIM1|p=)/i.test(t)) ?? null;
      return { selector, ok: !!record, record };
    }),
  );
  const dmarcRecord = (await txt(r, `_dmarc.${domain}`)).find((t) => t.toLowerCase().startsWith('v=dmarc1')) ?? null;
  const policy = dmarcRecord?.match(/;\s*p=(\w+)/i)?.[1]?.toLowerCase() ?? null;
  const dmarc = {
    ok: !!dmarcRecord,
    record: dmarcRecord,
    policy,
    advice: dmarcRecord
      ? policy === 'none'
        ? 'DMARC is monitoring only (p=none); move to p=quarantine once reports look clean.'
        : null
      : `Add a TXT record at _dmarc.${domain}: "v=DMARC1; p=none; rua=mailto:dmarc@${domain}" (bulk senders must have one).`,
  };
  return { domain, ok: spf.ok && dmarc.ok && dkim.every((d) => d.ok), spf, dkim, dmarc };
}

export const checkDomain = defineCommand({
  name: 'emailProviders.checkDomain',
  title: "Check a provider's sending domain",
  description:
    "Looks up SPF, DKIM and DMARC for the provider's from-domain and says what to add. DKIM needs the selectors from the provider's DNS settings (e.g. the three SES tokens).",
  input: z.object({
    id: z.string().regex(/^epr_[0-9a-f]{32}$/),
    dkimSelectors: z
      .array(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/))
      .max(5)
      .default([]),
  }),
  output: DomainReport,
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.id,
  handler: async (input, ctx) => {
    const [p] = await ctx.tx.select().from(schema.emailProviders).where(eq(schema.emailProviders.id, input.id));
    if (!p) throw new AppError('not_found', `No e-mail provider ${input.id}. List them with emailProviders.list.`);
    return checkDomainRecords(p.fromEmail.split('@')[1].toLowerCase(), p.adapter, input.dkimSelectors, new Resolver({ timeout: 3000 }));
  },
});

const Rates = z.object({
  sent: z.number(),
  bounced: z.number(),
  complained: z.number(),
  bounceRate: z.number(),
  complaintRate: z.number(),
  status: z.enum(['ok', 'warn', 'paused']),
  reason: z.string().nullable(),
});

export const deliverabilityHealth = defineCommand({
  name: 'deliverability.health',
  title: 'Bounce and complaint rates',
  description:
    'Bounce and complaint rates per channel and stream over the delivery policy window, with the thresholds. "paused": marketing messages are being held until the rate falls or the policy changes.',
  input: z.object({}),
  output: z.object({
    windowDays: z.number(),
    thresholds: z.object({ complaintWarn: z.number(), complaintStop: z.number(), bounceStop: z.number(), minVolume: z.number() }),
    autoPause: z.boolean(),
    email: z.object({ marketing: Rates, transactional: Rates }),
    sms: z.object({ marketing: Rates, transactional: Rates }),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_input, ctx) => {
    const policy = await deliveryPolicy(ctx.tx);
    const purposes = (await publishedSingleton(ctx.tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
    const rates = (channel: 'email' | 'sms', marketing: boolean) => streamRates(ctx.tx, policy, purposes, channel, marketing);
    const { autoPause, windowDays, ...thresholds } = policy.health;
    return {
      windowDays,
      thresholds,
      autoPause,
      email: { marketing: await rates('email', true), transactional: await rates('email', false) },
      sms: { marketing: await rates('sms', true), transactional: await rates('sms', false) },
    };
  },
});

export const deliverabilityCommands = [checkDomain, deliverabilityHealth] as const;

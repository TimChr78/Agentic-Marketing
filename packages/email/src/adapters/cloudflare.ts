import { z } from 'zod';
import { type DeliveryEvent, defineAdapter } from './types';

// Cloudflare Email Service (public beta): POST /accounts/{account}/email/sending/send with an API
// token (Email Sending: Edit). It documents no delivery webhooks yet, but the send response says
// which recipients bounced permanently or are on Cloudflare's suppression list; those become
// delivery events right away. Meant for the transactional stream (docs/architecture/email-and-sms-delivery.md).

interface SendResult {
  message_id?: string;
  delivered?: string[];
  queued?: string[];
  permanent_bounces?: string[];
  suppressed_recipients?: string[];
}

export const cloudflareAdapter = defineAdapter({
  id: 'cloudflare',
  label: 'Cloudflare Email Service',
  tracking: 'none',
  trackingNote: 'Cloudflare Email Service does not add tracking (per its documentation; verify for your account).',
  config: z.object({
    accountId: z.string().regex(/^[0-9a-f]{32}$/, 'The 32-character Cloudflare account id'),
    apiBase: z.url().default('https://api.cloudflare.com/client/v4'),
  }),
  secrets: z.object({ apiToken: z.string().min(20) }),
  create: (config, secrets, { fetch }) => ({
    async send(m) {
      const res = await fetch(`${config.apiBase}/accounts/${config.accountId}/email/sending/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secrets.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: { address: m.from.email, name: m.from.name },
          to: m.to,
          reply_to: m.replyTo,
          subject: m.subject,
          html: m.html,
          text: m.text,
          headers: m.headers,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: { message?: string }[]; result?: SendResult };
      if (!res.ok || body.success === false)
        throw new Error(`Cloudflare refused the message: ${body.errors?.map((e) => e.message).join('; ') || res.status}`);
      const r = body.result ?? {};
      const to = m.to.toLowerCase();
      const has = (list?: string[]) => !!list?.some((a) => a.toLowerCase() === to);
      const at = new Date().toISOString();
      const events: DeliveryEvent[] = [];
      if (has(r.permanent_bounces))
        events.push({
          eventId: `${m.messageId}:bounce`,
          messageId: m.messageId,
          type: 'bounced',
          bounce: 'hard',
          reason: 'permanent bounce',
          at,
        });
      else if (has(r.suppressed_recipients))
        events.push({
          eventId: `${m.messageId}:suppressed`,
          messageId: m.messageId,
          type: 'bounced',
          bounce: 'hard',
          reason: "on Cloudflare's suppression list",
          at,
        });
      else if (has(r.delivered)) events.push({ eventId: `${m.messageId}:delivered`, messageId: m.messageId, type: 'delivered', at });
      return { providerMessageId: r.message_id ?? null, events };
    },
  }),
});

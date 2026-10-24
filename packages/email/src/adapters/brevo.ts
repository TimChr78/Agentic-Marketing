import { z } from 'zod';
import { type DeliveryEvent, type DeliveryEventType, defineAdapter, type WebhookRequest } from './types';

// Brevo (Sendinblue): https://developers.brevo.com/reference/sendtransacemail and transactional
// webhooks. Our message id travels in X-Mailin-custom, which Brevo echoes in every webhook.

const CUSTOM = 'X-Mailin-custom';
const types: Record<string, { type: DeliveryEventType; bounce?: 'hard' | 'soft' }> = {
  delivered: { type: 'delivered' },
  hard_bounce: { type: 'bounced', bounce: 'hard' },
  soft_bounce: { type: 'bounced', bounce: 'soft' },
  blocked: { type: 'bounced', bounce: 'hard' },
  invalid_email: { type: 'bounced', bounce: 'hard' },
  deferred: { type: 'deferred' },
  spam: { type: 'complained' },
  unique_opened: { type: 'opened' },
  opened: { type: 'opened' },
  click: { type: 'clicked' },
  unsubscribed: { type: 'unsubscribed' },
};

export const brevoAdapter = defineAdapter({
  id: 'brevo',
  label: 'Brevo',
  docsUrl: 'https://developers.brevo.com/docs/send-a-transactional-email',
  tracking: 'forced',
  trackingNote:
    "Brevo adds open and click tracking to every message, including the unsubscribe link; it cannot be turned off from here (only Brevo support can disable it for some accounts), and 'anonymised tracking' still rewrites links.",
  config: z.object({}),
  secrets: z.object({ apiKey: z.string().min(10).describe('API key (v3) from Brevo → SMTP & API') }),
  create: (_config, secrets, { fetch }) => ({
    async send(m) {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': secrets.apiKey },
        body: JSON.stringify({
          sender: { email: m.from.email, ...(m.from.name ? { name: m.from.name } : {}) },
          to: [{ email: m.to }],
          ...(m.replyTo ? { replyTo: { email: m.replyTo } } : {}),
          subject: m.subject,
          htmlContent: m.html,
          textContent: m.text,
          headers: { ...m.headers, [CUSTOM]: `am:${m.messageId}` },
          tags: [m.stream],
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { messageId?: string; message?: string };
      if (!res.ok) throw new Error(`Brevo refused the message: ${body.message ?? res.status}`);
      return { providerMessageId: body.messageId ?? null };
    },
    parseWebhook: parseBrevoWebhook,
  }),
});

export async function parseBrevoWebhook({ body }: WebhookRequest): Promise<DeliveryEvent[]> {
  // biome-ignore lint/suspicious/noExplicitAny: provider payloads are untyped JSON
  const e = JSON.parse(body) as Record<string, any>;
  const t = types[e.event];
  if (!t) return [] as DeliveryEvent[];
  const custom = String(e[CUSTOM] ?? e['X-Mailin-Custom'] ?? '');
  const at = e.ts_event ? new Date(Number(e.ts_event) * 1000).toISOString() : new Date(e.date ?? Date.now()).toISOString();
  return [
    {
      eventId: `${e['message-id']}:${e.event}:${e.ts_event ?? e.id ?? ''}:${e.link ?? ''}`,
      type: t.type,
      bounce: t.bounce,
      messageId: custom.startsWith('am:') ? custom.slice(3) : undefined,
      providerMessageId: e['message-id'],
      reason: e.reason,
      url: e.link,
      at,
    },
  ];
}

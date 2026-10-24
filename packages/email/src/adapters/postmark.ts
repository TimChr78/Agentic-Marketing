import { z } from 'zod';
import { type DeliveryEvent, defineAdapter, type WebhookRequest } from './types';

// Postmark: https://postmarkapp.com/developer/api/email-api and webhooks. Transactional and
// broadcast mail go to separate message streams, as Postmark requires.

export const postmarkAdapter = defineAdapter({
  id: 'postmark',
  label: 'Postmark',
  docsUrl: 'https://postmarkapp.com/developer/api/email-api',
  tracking: 'configurable',
  trackingNote:
    'Postmark tracks opens and clicks only when a message enables them; the platform sends link tracking off on every message and open tracking off unless the provider setting trackOpens is on.',
  config: z.object({
    transactionalStream: z.string().default('outbound').describe('Message stream for transactional e-mail'),
    marketingStream: z.string().default('broadcast').describe('Broadcast message stream for marketing e-mail'),
    trackOpens: z.boolean().default(false).describe('Let Postmark count opens with a tracking pixel'),
  }),
  secrets: z.object({ serverToken: z.string().min(10).describe('Server API token from the Postmark server settings') }),
  create: (config, secrets, { fetch }) => ({
    async send(m) {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-postmark-server-token': secrets.serverToken },
        body: JSON.stringify({
          From: m.from.name ? `"${m.from.name.replace(/"/g, '')}" <${m.from.email}>` : m.from.email,
          To: m.to,
          ReplyTo: m.replyTo,
          Subject: m.subject,
          HtmlBody: m.html,
          TextBody: m.text,
          Headers: Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })),
          Metadata: { am_message_id: m.messageId },
          MessageStream: m.stream === 'marketing' ? config.marketingStream : config.transactionalStream,
          TrackOpens: config.trackOpens,
          TrackLinks: 'None',
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ErrorCode?: number; Message?: string; MessageID?: string };
      if (!res.ok || body.ErrorCode) throw new Error(`Postmark refused the message: ${body.Message ?? res.status}`);
      return { providerMessageId: body.MessageID ?? null };
    },
    parseWebhook: parsePostmarkWebhook,
  }),
});

export async function parsePostmarkWebhook({ body }: WebhookRequest): Promise<DeliveryEvent[]> {
  // biome-ignore lint/suspicious/noExplicitAny: provider payloads are untyped JSON
  const e = JSON.parse(body) as Record<string, any>;
  const ours = e.Metadata?.am_message_id ?? undefined;
  const base = { messageId: ours, providerMessageId: e.MessageID };
  const id = (suffix: string) => `${e.MessageID}:${e.RecordType}:${suffix}`;
  switch (e.RecordType) {
    case 'Delivery':
      return [{ ...base, eventId: id(e.DeliveredAt), type: 'delivered', at: e.DeliveredAt }];
    case 'Bounce': {
      // Postmark's hard bounce types; everything else is temporary.
      const hard = ['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated', 'Blocked', 'SpamNotification'].includes(e.Type);
      return [
        {
          ...base,
          eventId: id(String(e.ID)),
          type: 'bounced',
          bounce: hard ? 'hard' : 'soft',
          reason: `${e.Type}: ${e.Description ?? ''}`.trim(),
          at: e.BouncedAt,
        },
      ];
    }
    case 'SpamComplaint':
      return [{ ...base, eventId: id(String(e.ID)), type: 'complained', at: e.BouncedAt }];
    case 'Open':
      return [{ ...base, eventId: id(e.ReceivedAt), type: 'opened', at: e.ReceivedAt }];
    case 'Click':
      return [{ ...base, eventId: id(`${e.ReceivedAt}:${e.OriginalLink}`), type: 'clicked', url: e.OriginalLink, at: e.ReceivedAt }];
    case 'SubscriptionChange':
      return e.SuppressSending
        ? [{ ...base, eventId: id(e.ChangedAt), type: 'unsubscribed', reason: e.SuppressionReason, at: e.ChangedAt }]
        : [];
    default:
      return [] as DeliveryEvent[];
  }
}

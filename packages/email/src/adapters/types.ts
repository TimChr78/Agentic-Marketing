import type { z } from 'zod';

// Channel adapters for e-mail (ADR-0011): a transport (`send`) and an event source
// (`parseWebhook`). Adapters are pure translation: no database, no policy. The send gateway
// decides whether to send; webhooks are authenticated by the URL token before parsing.

export interface OutgoingEmail {
  /** Our message id; adapters pass it to the provider so delivery events can be matched back. */
  messageId: string;
  from: { email: string; name?: string };
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  /** Providers that separate transactional from bulk mail (Postmark streams, SES config sets) use this. */
  stream: 'transactional' | 'marketing';
}

export type DeliveryEventType = 'delivered' | 'bounced' | 'deferred' | 'complained' | 'opened' | 'clicked' | 'unsubscribed';

export interface DeliveryEvent {
  /** The provider's id for this event, for deduplication of re-sent webhooks. */
  eventId: string;
  type: DeliveryEventType;
  /** Our message id when the provider echoed it, otherwise the provider's message id. */
  messageId?: string;
  providerMessageId?: string;
  at: string;
  bounce?: 'hard' | 'soft';
  reason?: string;
  url?: string;
}

export interface WebhookRequest {
  headers: Record<string, string>;
  body: string;
}

export interface AdapterDeps {
  fetch: typeof fetch;
}

export interface EmailTransport {
  /** `events`: what the provider already knows from the send itself (e.g. a suppressed address). */
  send(msg: OutgoingEmail): Promise<{ providerMessageId: string | null; events?: DeliveryEvent[] }>;
  /** Called after the URL token matched; for providers that also sign their webhooks (SNS). */
  verifyWebhook?(req: WebhookRequest): Promise<boolean>;
  parseWebhook?(req: WebhookRequest): Promise<DeliveryEvent[]>;
  close?(): Promise<void>;
}

export interface EmailAdapter<C extends z.ZodType = z.ZodType, S extends z.ZodType = z.ZodType> {
  id: 'smtp' | 'ses' | 'postmark' | 'brevo' | 'cloudflare' | 'log';
  label: string;
  /** Settings that are not secret; returned by the API. */
  config: C;
  /** Credentials; write-only, stored sealed. */
  secrets: S;
  create(config: z.output<C>, secrets: z.output<S>, deps: AdapterDeps): EmailTransport;
}

export const defineAdapter = <C extends z.ZodType, S extends z.ZodType>(a: EmailAdapter<C, S>) => a;

/** Our message id header, set on every message. */
export const MESSAGE_ID_HEADER = 'X-AM-Message-Id';

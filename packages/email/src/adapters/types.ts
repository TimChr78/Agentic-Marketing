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
  /** HTTP/2 requests (Apple's push service only speaks HTTP/2), under the same egress guard. */
  http2?: (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number },
  ) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

/**
 * Who adds open/click tracking to the message, independently of the workspace's own
 * click tracking (`EMAIL_TRACK_CLICKS`): `forced` means every message is tracked by the
 * provider and the platform cannot turn it off; `configurable` means tracking is opt-in per
 * message or configuration set; `none` means the adapter adds no tracking of its own.
 */
export type TrackingCapability = 'forced' | 'configurable' | 'none';

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
  /** The provider's own documentation for the settings and credentials asked for here. */
  docsUrl?: string;
  /** Settings that are not secret; returned by the API. */
  config: C;
  /** Credentials; write-only, stored sealed. */
  secrets: S;
  /** Whether the provider tracks opens/clicks itself, and whether the platform can stop it. */
  tracking: TrackingCapability;
  /** A short operator-facing explanation of `tracking`. */
  trackingNote: string;
  create(config: z.output<C>, secrets: z.output<S>, deps: AdapterDeps): EmailTransport;
}

export const defineAdapter = <C extends z.ZodType, S extends z.ZodType>(a: EmailAdapter<C, S>) => a;

/** Our message id header, set on every message. */
export const MESSAGE_ID_HEADER = 'X-AM-Message-Id';

# ADR-0011: Email delivery through provider adapters, not SMTP alone

- Status: Accepted (owner decision 2026-10-22)
- Date: 2026-10-22

## Context
The owner's install sends through an SMTP relay, and the roadmap put an SMTP adapter first. SMTP alone is limiting for a marketing platform:

- **No delivery events.** SMTP says only "accepted by the relay". Bounces arrive later by e-mail (DSNs), complaints (spam reports) not at all, deliveries and engagement never. Without them, suppression and deliverability reporting are guesswork, and repeated sends to bad addresses damage the sending domain.
- **Weak idempotency.** A timeout after DATA leaves it unknown whether the message went out.
- **No provider features.** Separate streams for transactional vs. broadcast, suppression lists synced with the provider, sending statistics, per-message metadata.

Most relays people use (Amazon SES, Postmark, Brevo, Mailgun, SendGrid) also have an HTTP API and send delivery events to a webhook, and even when they are used over SMTP, their webhooks still report what happened to each message.

## Decision
1. **Adapters are a transport plus an event source.** The send gateway talks to a `ChannelAdapter` (channels-and-personalization.md §2) whose `send` returns the provider's message id, and whose `parseWebhook` turns provider callbacks into normalised delivery events (`delivered`, `bounced` hard/soft, `complained`, `deferred`, `opened`, `clicked`, `unsubscribed`). The SMTP adapter can be paired with a provider's webhook parser, so "SMTP to SES" or "SMTP to Brevo" still gets bounces and complaints.
2. **First adapters, Phase 2:**
   | Adapter | Transport | Events | Why |
   |---|---|---|---|
   | `smtp` | SMTP (Nodemailer) | sync rejections; optional provider webhooks; bounce mailbox later | Any relay, Postfix, Mailpit for development; the owner's setup |
   | `ses` | Amazon SES v2 HTTP API (SigV4) | SNS → webhook (signature verified) | Cheapest at volume, EU regions |
   | `postmark` | HTTP API | webhooks | Best deliverability for small senders, simple model, separate broadcast stream |
   | `brevo` | HTTP API | webhooks | EU-based (France), generous free tier, common SMTP relay in Europe |
   Mailgun, SendGrid and Resend follow through the same interface when someone needs them.
3. **One provider per sending domain, chosen per workspace**, configured with a command (credentials go to the secret store, write-only). A workspace can have a transactional and a marketing provider; the message's purpose picks which.
4. **Correlation** uses our message id, sent as a header (`X-AM-Message-Id`) and provider metadata/tags where the API has them, so webhook events map back to the message without trusting the provider's id alone.
5. **Webhooks are authenticated** per provider (SNS signature, basic auth or shared secret in the URL), deduplicated by provider event id, and land in ClickHouse `message_events`; hard bounces and complaints also add a suppression.

## Alternatives
- **SMTP only, bounce mailbox for events** (the original plan): works with every relay, but complaints and deliveries stay invisible and DSN parsing is fragile. Kept as a later option for pure-SMTP setups.
- **Run our own MTA (Postfix/Haraka) with IP warm-up**: maximum control, but deliverability from a homelab IP is poor and running it is a job in itself.
- **One provider only**: simpler, but it would tie a self-hosted, open-source product to one vendor.

## Consequences
- The adapter interface is designed for events from the start; the SMTP adapter is one implementation, not the model.
- Each HTTP adapter is small (send + webhook parser + config schema), tested against recorded provider payloads, since CI cannot reach the providers.
- The owner can keep their SMTP relay and add that relay's webhooks, or switch to an API adapter without touching templates or journeys.

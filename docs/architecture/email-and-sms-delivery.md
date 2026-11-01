# Better e-mail delivery than SMTP, and SMS

Status: built in wave 2, Phase 7 ([roadmap-wave-2.md](roadmap-wave-2.md)), except where marked *later*.

## Why not plain SMTP

A plain SMTP relay accepts a message and says nothing more:
- no bounces, complaints or deliveries;
- no idempotency after a timeout;
- no separation of transactional and bulk streams ([ADR-0011](adr/0011-email-delivery-providers.md)).

Gmail and Yahoo's bulk-sender rules expect:
- one-click unsubscribe (done);
- SPF, DKIM and DMARC alignment;
- spam complaints under 0.3%.

That last one needs complaint events to be measured at all.

## What exists today

The provider adapters have shipped since Phase 2. They are HTTP APIs with signed delivery-event webhooks:

| Adapter | Events | Fit | Provider-side tracking |
|---|---|---|---|
| **Amazon SES** (v2 API, SigV4) | SNS → webhook (signature verified): delivery, bounce, complaint | **Recommended for the newsletter**: cheapest at volume, EU regions (eu-north-1, eu-central-1), mature reputation tooling | Configurable: only if the configuration set enables it |
| **Postmark** | Webhooks; a separate broadcast stream | Best deliverability for small senders; costs more per message | Configurable: per message; the adapter turns links off |
| **Brevo** | Webhooks | EU-based (France), free tier | **Forced: open and click tracking on every message** |
| **Cloudflare Email Service** | From the send response only; no webhooks yet (see below) | Transactional; see below | None (per its documentation; verify for your account) |
| SMTP | Only with a provider's webhooks | Last resort | Depends entirely on the relay |
| Development outbox | None | Development and tests | None (sends nothing) |

### Provider-side tracking

The workspace setting `EMAIL_TRACK_CLICKS` only controls the platform's own link rewriting. A provider can still rewrite links or add an open pixel, and then the admin UI would understate what the recipient sees:

- **Brevo: forced.** Brevo adds open and click tracking to every message. Every HTML link — including the platform's unsubscribe link — is rewritten through Brevo's tracker, and a hidden pixel is added. It cannot be turned off per message or in the Brevo UI; only Brevo support can disable it for some accounts, and Brevo's "anonymised tracking" still rewrites links. If the site promises no tracking, use Cloudflare Email Service, Postmark or SES for marketing, or ask Brevo support before sending.
- **Postmark: configurable.** The adapter sends `TrackLinks: 'None'` on every message and `TrackOpens: false` unless the provider's `trackOpens` setting is on, so provider tracking is off by default.
- **Amazon SES: configurable.** Tracking happens only when the AWS configuration set named on the message has open or click tracking enabled. The adapter adds no tracking options of its own.
- **Cloudflare Email Service: none.** It documents no open or click tracking; verify this for the account before promising it.
- **SMTP: depends on the relay.** The adapter adds nothing, but an SMTP relay (for example Brevo's SMTP endpoint) can still rewrite links and add pixels.
- **Development outbox: none.** It keeps messages in memory and sends nothing.

`emailProviders.list` returns `tracking` (`forced`, `configurable` or `none`) and `trackingNote` for each provider, and a `warnings` list when the workspace has click tracking off but an enabled marketing provider tracks every message anyway. The same warning appears in the admin UI above the provider list.

The workspace already routes **transactional** and **marketing** messages to different providers, by purpose. **The MarTechSignal pilot can use SES or Postmark from day one instead of the SMTP relay**; nothing new is needed for that.

## Cloudflare Email Service

Cloudflare's sending service is in **public beta** (since April 2026). It offers:
- a Workers binding, a REST API and SMTP submission (also in beta);
- a Workers Paid plan requirement;
- per-account daily quotas that grow with reputation.

The docs frame it around **transactional** mail (signups, password resets, confirmations). Published pricing (third-party comparison, verify before relying on it) is about $0.35 per 1,000 after 3,000 a month. No documented bounce or complaint webhooks or dedicated IPs were found.

The REST API, as typed in Cloudflare's official SDK (`cloudflare` 7.3 on npm):
- `POST /client/v4/accounts/{account_id}/email/sending/send` with a Bearer API token;
- body `{from: {address, name}, to, subject, html, text, headers, reply_to}`;
- result `{message_id, delivered[], queued[], permanent_bounces[], suppressed_recipients[]}`.

The adapter turns permanent bounces and suppressed recipients into hard-bounce events (so they land on our suppression list) and `delivered` into delivery events. There are still no asynchronous event webhooks.

Plan:
- **Add a `cloudflare` adapter** (REST API) for the **transactional stream**: double opt-in confirmations, welcome mail. It fits an install that already lives on Cloudflare: same DNS, no extra vendor.
- **Keep the newsletter (marketing stream) on SES or Postmark** until Cloudflare documents bulk use, bounce and complaint events, and suppression handling. The adapter interface lets a workspace switch later without touching templates or journeys.
- **Reassess at Cloudflare's GA**, by deciding whether its event coverage reaches what the gateway needs (bounces → suppressions, complaints → suppressions and alerts).

Sources:
- [Cloudflare Email Service docs](https://developers.cloudflare.com/email-service/) and [changelog](https://developers.cloudflare.com/changelog/product/email-service/);
- [SMTP submission beta](https://releases.sh/release/rel_slwQctpAzyp2qt6vRmQ3O-email-service-authenticated-smtp-submission-now-available-in-beta);
- [InfoQ: Cloudflare Email Service](https://www.infoq.com/news/2025/10/cloudflare-email-service);
- [pricing comparison (third party)](https://www.sequenzy.com/versus/cloudflare-email-vs-postmark).

## Deliverability work in the same phase

- **Domain check command** (`emailProviders.checkDomain`): looks up SPF, DKIM and DMARC for the from-domain and says what to add. With Cloudflare DNS it can link the exact records.
- **Complaint and bounce rate monitor:** rolling rates per provider and stream from `message_events`. Above thresholds (complaints 0.1% warn, 0.3% stop marketing sends), the gateway pauses marketing mail and alerts.
- **Warm-up and throttling:** per-provider sending rate and daily cap, and broadcasts spread over the allowed rate. New domains ramp up over days.
- **Frequency caps and quiet hours** in the gateway (a Phase 2 limit): per person, channel and purpose, e.g. at most 2 marketing e-mails in 7 days, no SMS from 21:00 to 08:00 local time.
- **Bounce mailbox (VERP)** for pure-SMTP installs: kept as an option, low priority now that HTTP adapters exist (*later*).

As built:
- one `delivery_policy` artifact per workspace (defaults until published); caps, quiet hours and pauses apply to marketing purposes only, never to contract or legal-obligation messages;
- a held message stays `queued` with `not_before` and a reason (`quiet_hours: …`, `paused: …`);
- a capped message becomes `suppressed` with `frequency_cap: …`;
- rates are counted from the message log over `health.windowDays`;
- per-provider throttling and warm-up are *later*.

## SMS channel

SMS is a second **channel**, not a replacement for e-mail. It shares the gateway (lawful basis, consent, suppression, frequency caps, quiet hours) and the journey and broadcast machinery.

- **Adapters** (transport plus events, like e-mail):
  - **Twilio** (global): built;
  - **GatewayAPI** (EU, Danish; good Nordic coverage and pricing): *later*;
  - optionally **46elks** (Sweden) and Vonage: *later*.

  Delivery reports come by webhook. The webhook path carries a signed token (workspace and provider), so each message gets its status callback URL, and Twilio's own `X-Twilio-Signature` is verified as well. Set `<links URL>/hooks/sms/<token>/inbound` as the number's incoming-message webhook.
- **Consent:**
  - purposes `marketing_sms` (consent) and `service_sms` (contract);
  - the phone number is a sealed identifier;
  - double opt-in by SMS code from forms (*later*).
- **Inbound:**
  - STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, STOPP, AFMELD or AVSLUTA withdraw consent for marketing SMS purposes and suppress the number, since carriers block all texts after STOP;
  - START lifts that block, but marketing still needs a new consent;
  - HELP gets the provider's help text.
  - The keywords are fixed for now.
- **Content:**
  - an `sms_template` artifact (Liquid, GSM-7 versus UCS-2 segment counter); marketing texts get " Reply STOP to opt out." unless they mention STOP. Link shortening is *later*;
  - an alphanumeric sender id where allowed, a long number otherwise.
- **Journey node** `sms` and broadcast support (`channel: sms`).
- **Costs:** price per segment and an optional monthly budget per provider. `smsTemplates.preview` estimates the cost; a text that would exceed the budget is not sent (`budget: …`).

## Push (built in wave 2, Phase 11)

Push is a channel like e-mail and SMS: push templates (`psh_…`) with a purpose, the same send gateway, and push nodes in journeys and broadcasts. Three providers ship: web push (VAPID, with the SDK's service worker), Firebase Cloud Messaging (`fcm`) and Apple Push Notification service (`apns`). Setup, device registration and what is not built yet are in [docs/push.md](../push.md).

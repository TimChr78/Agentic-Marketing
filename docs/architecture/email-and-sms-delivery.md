# Better e-mail delivery than SMTP, and SMS

Status: design for wave 2, Phase 7 ([roadmap-wave-2.md](roadmap-wave-2.md)).

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

| Adapter | Events | Fit |
|---|---|---|
| **Amazon SES** (v2 API, SigV4) | SNS → webhook (signature verified): delivery, bounce, complaint | **Recommended for the newsletter**: cheapest at volume, EU regions (eu-north-1, eu-central-1), mature reputation tooling |
| **Postmark** | Webhooks; a separate broadcast stream | Best deliverability for small senders; costs more per message |
| **Brevo** | Webhooks | EU-based (France), free tier |
| SMTP | Only with a provider's webhooks | Last resort |

The workspace already routes **transactional** and **marketing** messages to different providers, by purpose. **The MarTechSignal pilot can use SES or Postmark from day one instead of the SMTP relay**; nothing new is needed for that.

## Cloudflare Email Service

Cloudflare's sending service is in **public beta** (since April 2026). It offers:
- a Workers binding, a REST API and SMTP submission (also in beta);
- a Workers Paid plan requirement;
- per-account daily quotas that grow with reputation.

The docs frame it around **transactional** mail (signups, password resets, confirmations). Published pricing (third-party comparison, verify before relying on it) is about $0.35 per 1,000 after 3,000 a month. No documented bounce or complaint webhooks or dedicated IPs were found.

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
- **Bounce mailbox (VERP)** for pure-SMTP installs: kept as an option, low priority now that HTTP adapters exist.

## SMS channel

SMS is a second **channel**, not a replacement for e-mail. It shares the gateway (lawful basis, consent, suppression, frequency caps, quiet hours) and the journey and broadcast machinery.

- **Adapters** (transport plus events, like e-mail):
  - **GatewayAPI** (EU, Danish; good Nordic coverage and pricing);
  - **Twilio** (global);
  - optionally **46elks** (Sweden) and Vonage.

  Delivery reports come by webhook.
- **Consent:**
  - purposes `marketing_sms` (consent) and `service_sms` (contract);
  - the phone number is a sealed identifier;
  - double opt-in by SMS code from forms.
- **Inbound:** STOP, UNSUBSCRIBE and STOPP keywords on the inbound webhook record an objection and a suppression; HELP gets an auto-reply. The keywords are configurable per country.
- **Content:**
  - an `sms_template` artifact (Liquid, GSM-7 versus UCS-2 segment counter, link shortening through our click tracking);
  - an alphanumeric sender id where allowed, a long number otherwise.
- **Journey node** `sms` and broadcast support (`channel: sms`).
- **Costs:** a per-message price estimate in previews, plus a workspace monthly budget (like the AI budgets).

## Push (later, wave 2 Phase 11)

Web push (VAPID, service worker in the SDK) first; mobile push (FCM and APNs) when a customer needs it.

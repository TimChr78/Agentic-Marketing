# Pilot: MartechSignal.com

A light pilot before Phase 6: run the platform for a real site, the owner's [martechsignal.com](https://martechsignal.com) ([source](https://github.com/TimChr78/martechsignal)), and learn what is missing in practice. This page is the fit assessment and the plan. The implementation is done in a separate session with the [implementation skill](../../.claude/skills/agentic-marketing-implement/SKILL.md).

## The site today (2026-10-22)

| Aspect | What it is |
|---|---|
| Hosting | Cloudflare Pages, **advanced mode**: `_worker.js` handles every request (Markdown negotiation, slash normalisation, a 300 s edge cache for HTML). `functions/_middleware.js` therefore does not run, as the repo's own note says. |
| Build | A Python generator builds static HTML (no bundler). `deploy.sh` uploads `deploy-out/` with wrangler; an agent (Hermes) runs builds and deploys on cron. |
| Content | Tool directory (`catalog-tools.json`, about 170 tools), reviews, comparisons, "best of", glossary, blog, checklist, `llms.txt`. No accounts, no ads. |
| Newsletter | Weekly ("one email, every Friday") on **Kit**. A plain HTML form posts to `app.kit.com` in a new tab, once per page, on about 200 pages. |
| Measurement | Self-hosted **Umami** (`analytics.martechsignal.com`, cookieless; `data-umami-event` on the subscribe button) and Cloudflare Web Analytics. |
| Privacy promise | "No tracking cookies, no analytics that build profiles … vendor links have no redirect trackers." The newsletter address is used "for exactly one purpose". |
| CSP | Strict: `script-src 'self' analytics.martechsignal.com static.cloudflareinsights.com`, `connect-src 'self' …`, `form-action 'self' https://app.kit.com`, no `unsafe-inline` scripts. |

## What the pilot should do

1. **Own the newsletter.** Signups through the platform with double opt-in, existing Kit subscribers imported with their consent, and the Friday issue sent as a broadcast to a consent-based segment through the owner's SMTP relay (or SES or Postmark).
2. **Welcome journey.** A welcome e-mail after confirmation, plus a nudge after a week if they have not clicked anything.
3. **Agent-run operations.** The Hermes agent drafts each issue and broadcast through MCP with an API token; Tim approves in the UI (workspace policy "agent changes need a person").
4. **Keep the privacy promise.** Do not track anonymous visitors in phase A. People who subscribe are known by their e-mail; what they click in e-mails is first-party.
5. **Later (phase B, optional).** Consent-gated on-site tracking and personalization, e.g. a newsletter CTA tailored to the category being read, and segments by interest.

## Fit: what was there, what was missing, what was built

| Need | Before the pilot | Now |
|---|---|---|
| Signup form that works without JavaScript and under the CSP | Missing: ingest takes JSON with a write key | **Built**: `form` artifact; `POST /f/<form>` takes urlencoded or JSON, answers 303 to the site's own pages, checks allowed origins, has a honeypot and a per-IP rate limit |
| Double opt-in (EU practice, and the purposes already had the flag) | Flag only | **Built**: confirmation e-mail (template with `{{ confirm_url }}`, contract purpose); the link opens a page with a button, so mail scanners cannot confirm; consent is recorded with proof (form, version, consent-text hash, submitted and confirmed at) |
| Bot protection | – | **Built**: honeypot and rate limit by default; **Cloudflare Turnstile** per form (`turnstile: true`, secret `turnstile.secret_key`) |
| Move subscribers from Kit with consent | Missing (Phase 1 limit: no bulk import) | **Built**: `profiles.import`, up to 5,000 rows per call, keeping consent history and proof; idempotent; people only |
| Weekly newsletter | Missing: journeys are triggered; `journeys.enroll` caps at 1,000 and is not a campaign | **Built**: `broadcast` artifact (template + segment + optional `sendAt`); it runs once, in batches, through the send gateway; `broadcasts.preview`, `broadcasts.status`, `broadcasts.cancel` |
| E-mail links on the site's own domain (unsubscribe, clicks, confirm) | Links used `PUBLIC_URL`, which is also the admin and OAuth URL | **Built**: `PUBLIC_LINKS_URL` (e.g. `https://martechsignal.com/am`) |
| Visitor IP behind Cloudflare | Hard-wired `x-forwarded-for` | **Built**: `CLIENT_IP_HEADER` (the proxy sets `x-am-client-ip`) |
| SDK on a site without a bundler, under `script-src 'self'` | Source only | **Built**: `pnpm --filter @agentic-marketing/sdk-js build` makes `dist/am.min.js` (7 KB IIFE, global `AgenticMarketing`) to host on the site |
| Welcome journey, unsubscribe (RFC 8058), suppressions, bounces | Existing | Existing |
| Agent drafting, approval, audit | Existing (MCP, API tokens, approval policy) | Existing |
| Templates in the house style | Existing (MJML + Liquid, visual editor) | Existing |
| Consent banner (only phase B needs one) | Missing | **Not built**: phase A needs none; for phase B, use a small banner on the SDK's `consent()` or an existing open-source CMP |
| RSS-to-email | Missing | **Not needed**: the agent drafts the issue from `rss.xml` through MCP |

## Cloudflare specifics

- **First-party proxy in `_worker.js`** ([reference](../../.claude/skills/agentic-marketing-implement/references/cloudflare-worker-proxy.js)). `/am/*` on the site forwards only the public paths (forms, confirmation, unsubscribe, clicks, and later `v1/batch` and `v1/decide`) to the platform.
  - The CSP keeps `form-action 'self'` and `connect-src 'self'`; no third-party domain is added.
  - Ad blockers do not block it.
  - The admin UI, REST commands and MCP are not reachable through the site.
  - The proxy must run before the worker's HTML edge cache. Its responses are `no-store`.
- **Reaching the homelab: Cloudflare Tunnel** (`cloudflared`).
  - One tunnel hostname (e.g. `am-edge.<domain>`) maps to the app's port. Protect it with **Cloudflare Access** using a service-token policy; the worker sends the token, so only the site can call the platform.
  - The admin UI and MCP stay on the LAN or a VPN (Tailscale). Hermes runs on the same server, so it uses the LAN URL with an API token.
- **Turnstile** (free) is better than a CAPTCHA if bots find the form; it needs `challenges.cloudflare.com` in `script-src` and `frame-src`.
- **E-mail sending:** Cloudflare does not send bulk mail. Keep the SMTP relay (with the relay's bounce webhooks if it has them, ADR-0011), or use SES or Postmark. Add SPF, DKIM and DMARC for the sending domain in Cloudflare DNS.
- **Edge cache:** the worker caches HTML for 5 minutes, so personalization must stay client-side (the SDK), which it already is.

## Privacy and legal changes on the site

- **Privacy policy.**
  - Name the platform as the newsletter processor (self-hosted; data stays on the owner's infrastructure).
  - List what is stored: e-mail, first name, consent proof, the newsletter's delivery events, and clicks on links in the newsletter. If clicks should not be counted, set `EMAIL_TRACK_CLICKS=false`; the site's "no redirect trackers" promise is about vendor links on the site, but say so explicitly.
  - Fix the stale "fonts from Google Fonts" paragraph: fonts are self-hosted now (`font-src 'self'`).
- **Form text:** the `consentText` of the form must match the text shown next to the form. Its hash is stored as proof.
- **Kit migration:** import only active subscribers, with Kit's subscription date and source as proof. Then stop sending from Kit and delete the list there.

## Plan for the implementation session

1. **Platform up.**
   - Docker Compose on the homelab with `PUBLIC_URL` (LAN), `PUBLIC_LINKS_URL=https://martechsignal.com/am` and `CLIENT_IP_HEADER=x-am-client-ip`.
   - Bootstrap the owner (`cli bootstrap`); set the approval policy to `agent_changes`.
   - Add the e-mail provider (SMTP relay) with `useFor: [transactional, marketing]`.
   - Purposes: the defaults fit (`marketing_email` is consent-based; `onboarding` covers the confirmation e-mail). Double opt-in is set on the form (`doubleOptIn: true`); the purposes' `requiresDoubleOptIn` flag is informational only.
2. **Edge.** Create the tunnel and the Access service token; add `am-proxy.js` and the `/am/` branch to `_worker.js`; set `AM_ORIGIN`, `AM_ACCESS_ID` and `AM_ACCESS_SECRET` on the Pages project.
3. **Signup.**
   - Create the confirmation template (purpose `onboarding`), the form (DOI, `successUrl` and `confirmedUrl` pages on the site, `allowedOrigins: ["https://martechsignal.com"]`) and the two small pages (`/subscribe/check-your-inbox/`, `/subscribe/welcome/`).
   - Change the generator's subscribe partial to post to `/am/f/<form id>` with the honeypot field.
   - Update the CSP: drop `app.kit.com` from `form-action` and `connect-src` once Kit is gone.
4. **Import.** Export active Kit subscribers as CSV and import them in batches of up to 5,000 with `profiles.import` (people only; use the UI's REST client or a script with the owner's session).
5. **Newsletter.**
   - Segment `{"consent": "marketing_email"}` ("Newsletter subscribers").
   - Each week: Hermes drafts the issue template and a `broadcast` with `sendAt` Friday 07:00 UTC over MCP, runs `broadcasts.preview` and requests publishing; Tim approves; check with `broadcasts.status`.
6. **Welcome journey.** Trigger on the `Subscription Confirmed` event: welcome e-mail → wait 3 days → a "start here" e-mail with the three most-read reviews. (A branch on e-mail clicks is not possible yet; see known limits.)
7. **Measure.** Umami keeps on-site analytics. The platform reports the newsletter (`broadcasts.status`, `messages.stats`), signups (`Form Submitted` / `Subscription Confirmed` counts) and the journey (`journeys.stats`).

**Done when:** a real signup gets the confirmation and the welcome e-mail; imported subscribers and new ones receive one Friday issue sent by a broadcast that Hermes drafted and Tim approved; and unsubscribe and bounces work end to end.

## Known limits found while assessing

- People who never confirm keep a profile without consent. There is no automatic cleanup yet; delete them with `profiles.erase`, or wait for a retention job (to do).
- Broadcasts have no A/B subject test or send-time optimisation; a broadcast goes to the segment as it is at send time.
- No dedicated UI for forms and broadcasts yet. They are artifacts, so the generic artifact editor, MCP and REST work.
- No consent banner component; phase B needs one.
- E-mail clicks are message events, not events on the person's profile, so segments and journey branches cannot use "clicked the newsletter" yet. A small follow-up: publish an `Email Link Clicked` event to the bus from the click route.

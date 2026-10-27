# Pilot: MartechSignal.com

A light pilot before Phase 6: run the platform for a real site, the owner's [martechsignal.com](https://martechsignal.com) ([source](https://github.com/TimChr78/martechsignal)), and learn what is missing in practice. This page is the fit assessment and the plan. The implementation is done in a separate session with the [implementation skill](../../.claude/skills/agentic-marketing-implement/SKILL.md).

## The site today (2026-10-22)

| Aspect | What it is |
|---|---|
| Hosting | Cloudflare Pages, **advanced mode**: `_worker.js` handles every request (Markdown negotiation, slash normalisation, a 300 s edge cache for HTML). `functions/_middleware.js` therefore does not run, as the repo's own note says. |
| Build | A Python generator builds static HTML (no bundler). `deploy.sh` uploads `deploy-out/` with wrangler; an agent (Hermes) runs builds and deploys on cron. |
| Content | Tool directory (`catalog-tools.json`, about 170 tools), reviews, comparisons, "best of", glossary, blog, checklist, `llms.txt`. No accounts, no ads. |
| Newsletter | Weekly ("one email, every Friday") on **Kit**. A plain HTML form posts to `app.kit.com` in a new tab, once per page, on about 200 pages. |
| Measurement | Self-hosted **Umami** in the homelab behind a Cloudflare Tunnel (`analytics.martechsignal.com`, cookieless; `data-umami-event` on the subscribe button) and Cloudflare Web Analytics. |
| Privacy promise | "No tracking cookies, no analytics that build profiles … vendor links have no redirect trackers." The newsletter address is used "for exactly one purpose". |
| CSP | Strict: `script-src 'self' analytics.martechsignal.com static.cloudflareinsights.com`, `connect-src 'self' …`, `form-action 'self' https://app.kit.com`, no `unsafe-inline` scripts. |

## What the pilot should do

1. **Own the newsletter.** Signups through the platform with double opt-in, and the Friday issue sent as a broadcast to a consent-based segment. The pilot runs the **Brevo** adapter as an interim provider and switches to **Postmark** (Broadcast stream, tracking off) before real subscribers arrive; there is no Kit import for this site (see "E-mail provider" and "Replacing Kit").
2. **Welcome journey.** A welcome e-mail after confirmation, then a "start here" e-mail a few days later.
3. **Agent-run operations.** The Hermes agent drafts each issue and broadcast through MCP with an API token; Tim approves in the UI (workspace policy "agent changes need a person").
4. **Keep the privacy promise.** Do not track anonymous visitors in phase A. People who subscribe are known by their e-mail; clicks in e-mails are counted by the platform (first-party), not by an ad network. While Brevo is the interim provider it also tracks opens and clicks (see "E-mail provider"); the privacy page discloses this, and the switch to Postmark turns it off.
5. **Later (phase B, optional).** Consent-gated on-site tracking and personalization, e.g. a newsletter CTA tailored to the category being read, and segments by interest.

## Fit: what was there, what was missing, what was built

| Need | Before the pilot | Now |
|---|---|---|
| Signup form that works without JavaScript and under the CSP | Missing: ingest takes JSON with a write key | **Built**: `form` artifact; `POST /f/<form>` takes urlencoded or JSON, answers 303 to the site's own pages, checks allowed origins, has a honeypot and a per-IP rate limit |
| Double opt-in (EU practice, and the purposes already had the flag) | Flag only | **Built**: confirmation e-mail (template with `{{ confirm_url }}`, contract purpose); the link opens a page with a button, so mail scanners cannot confirm; consent is recorded with proof (form, version, consent-text hash, submitted and confirmed at) |
| Bot protection | – | **Built**: honeypot and rate limit by default; **Cloudflare Turnstile** per form (`turnstile: true`, secret `turnstile.secret_key`) |
| Move subscribers from Kit with consent | Missing (Phase 1 limit: no bulk import) | **Built**: `profiles.import`, up to 5,000 rows per call, keeping consent history and proof; idempotent; people only. In the UI: a CSV import that recognises Kit's columns. **Not needed here**: the list is one address, the owner's |
| Weekly newsletter | Missing: journeys are triggered; `journeys.enroll` caps at 1,000 and is not a campaign | **Built**: `broadcast` artifact (template + segment + optional `sendAt`); it runs once, in batches, through the send gateway; `broadcasts.preview`, `broadcasts.status`, `broadcasts.cancel` |
| E-mail links on the site's domain (unsubscribe, clicks, confirm) | Links used `PUBLIC_URL`, which is also the admin and OAuth URL | **Built**: `PUBLIC_LINKS_URL` (option A: e.g. `https://am.martechsignal.com`; option B: `https://martechsignal.com/am`) |
| Visitor IP behind Cloudflare | Hard-wired `x-forwarded-for` | **Built**: `CLIENT_IP_HEADER` as an ordered list (`cf-connecting-ip,x-forwarded-for`) and `TRUSTED_PROXY_CIDRS`, so the tunnel and the admin path both resolve the right address (0.1.1, #31) |
| SDK on a site without a bundler, under `script-src 'self'` | Source only | **Built**: `pnpm --filter @agentic-marketing/sdk-js build` makes `dist/am.min.js` (7 KB IIFE, global `AgenticMarketing`) to host on the site |
| Welcome journey, unsubscribe (RFC 8058), suppressions, bounces | Existing | Existing |
| Agent drafting, approval, audit | Existing (MCP, API tokens, approval policy) | Existing |
| Templates in the house style | Existing (MJML + Liquid, visual editor) | Existing |
| Consent banner (only phase B needs one) | Missing | **Not built**: phase A needs none; for phase B, use a small banner on the SDK's `consent()` or an existing open-source CMP |
| RSS-to-email | Missing | **Not needed**: the agent drafts the issue from `rss.xml` through MCP |

## Cloudflare specifics

Umami already runs in the homelab behind a **Cloudflare Tunnel** (`analytics.martechsignal.com`), so the platform reuses that tunnel and **option A is the default here**.

- **Option A, default here (recommended): a hostname on the existing tunnel**, pointed at the public-only listener.
  - Set `PUBLIC_PORT=3001` on the platform. It keeps serving the admin UI, REST and MCP on `3000` (LAN/VPN only) and additionally serves **only** `/f`, `/u`, `/c`, `/a` and `/hooks` (plus `/healthz` and `/readyz`) on `3001`; everything else is 404 there.
  - In the tunnel config, point the new hostname at that port with **no path rule**:
    ```yaml
    ingress:
      - hostname: analytics.martechsignal.com     # existing Umami rule
        service: http://umami:3000
      - hostname: am.martechsignal.com
        service: http://app:3001                  # public listener: only f/u/c/a/hooks exist here
      - service: http_status:404
    ```
    For a tunnel managed in the dashboard, add one public hostname: `am.martechsignal.com` → `http://app:3001`. No second entry and no path regex are needed.
  - If a path rule is unavoidable, use the strict form `^/(f|u|c|a|hooks)(/[^/.%][^/%]*)+/?$` with a catch-all to `http_status:404`. A loose rule is unsafe because cloudflared matches the **raw** path and forwards it raw: `/f/../v1/workspace.get` passes any rule that only checks the prefix, then the app resolves it to the admin API. The server now also rejects dot-segments, encoded dots/slashes and backslashes with 400 on both listeners, but the separate listener is the structural fix.
  - Platform settings: `PUBLIC_LINKS_URL=https://am.martechsignal.com`, `CLIENT_IP_HEADER=cf-connecting-ip,x-forwarded-for` and `TRUSTED_PROXY_CIDRS=<tunnel connector>,<Tailscale admin proxy>` (see "Client IP behind two ingress paths").
  - Site: the form posts to `https://am.martechsignal.com/f/<form id>`. The CSP's `form-action` swaps `https://app.kit.com` for `https://am.martechsignal.com`. Nothing else changes; the site worker stays as it is.
  - Bounce and complaint webhooks (`/hooks/...`) are served by the same public listener; with a path rule, the strict regex above already includes them.
- **Option B: first-party proxy in `_worker.js`** ([reference](../../.claude/skills/agentic-marketing-implement/references/cloudflare-worker-proxy.js)). `/am/*` on martechsignal.com is forwarded to a tunnel hostname locked with a Cloudflare Access service token. The form then posts to `/am/f/<form id>`.
  - Pick it if the links should live on the main domain, or for phase B tracking, where a same-origin `/am/v1/batch` is safest against ad blockers.
  - It needs worker code and must run before the worker's HTML edge cache.
- **Admin and MCP.** The admin UI and REST work over a plain-HTTP LAN URL (`http://am.lan:3000`). `PUBLIC_URL` must be an HTTPS URL (e.g. Tailscale Serve on the homelab) or MCP/OAuth is disabled, even when clients connect over the LAN. MCP can be reached two ways: over the HTTPS URL, e.g. `https://<host>.<tailnet>.ts.net/mcp`, with an API token (or OAuth); or over `http://<LAN-IP>:3210/mcp` with a bearer `amk_…` API token. The pilot's Hermes container cannot reach the Tailscale HTTPS URL, so it uses the LAN route, and API tokens bypass OAuth, so that works. The LAN route is unencrypted: the token travels in clear text on that network segment. Keep it to a trusted LAN, give the token minimal scopes, and rotate it if the LAN is shared; prefer the HTTPS URL whenever it is reachable.
- **Turnstile** (free) is better than a CAPTCHA if bots find the form; it needs `challenges.cloudflare.com` in `script-src` and `frame-src`.
- **E-mail sending:** Cloudflare Email Service is for transactional e-mail only — its FAQ says it may not be used for marketing. Marketing e-mail runs on the platform's provider (see "E-mail provider"). Add SPF, DKIM and DMARC for the sending domain in Cloudflare DNS, and remove Kit's sending-domain records after the switch.
- **Edge cache:** the worker caches HTML for 5 minutes, so personalization must stay client-side (the SDK), which it already is.

## E-mail provider

The pilot currently runs the **Brevo** adapter as an interim provider, with `useFor: [transactional, marketing]`. Brevo adds open and click tracking to every message, including the unsubscribe link, and the platform cannot turn it off; the adapter reports `tracking: forced` (#43). The site's privacy page discloses this while Brevo is the provider, and it is why the owner is the only subscriber.

- **Planned (decision of 2026-10-24):** **Postmark** for marketing e-mail, using the Broadcast message stream (`marketingStream: "broadcast"`) with open and click tracking off; transactional e-mail stays on Cloudflare Email Service. Its adapter reports `tracking: configurable`: the platform turns link tracking off on every message and open tracking off unless `trackOpens` is enabled.
- **Cloudflare Email Service is for transactional e-mail only.** Its FAQ says it may not be used for marketing e-mail.
- **Rule: no real subscribers on a provider with forced tracking.** While Brevo is in use the owner is the only subscriber, so the switch to Postmark comes **before** "Switch the forms first" and the cutover, not after.
- **Check:** Settings → Providers shows the Brevo adapter now, and Postmark after the switch, each with its `tracking` capability and note. With `EMAIL_TRACK_CLICKS=false`, a `forced` marketing provider also raises a warning there and in `emailProviders.list`.

## Client IP behind two ingress paths

There are two ways in: visitors arrive through the Cloudflare Tunnel (which sets `cf-connecting-ip`), while the admin UI and Hermes/MCP arrive over the LAN or Tailscale. Set both variables:

```bash
CLIENT_IP_HEADER=cf-connecting-ip,x-forwarded-for
TRUSTED_PROXY_CIDRS=<tunnel connector>,<Tailscale admin proxy>
```

- `CLIENT_IP_HEADER` is an ordered, comma-separated list: the first valid address of the first header present is used. The tunnel supplies `cf-connecting-ip`; `x-forwarded-for` covers a proxy that adds it.
- `TRUSTED_PROXY_CIDRS` is a comma-separated list of IP addresses or CIDR ranges (IPv4 or IPv6, e.g. `10.0.0.0/8`). When set, forwarding headers are ignored unless the socket peer is in one of those ranges, so a client cannot choose its rate-limit bucket. Admin LAN traffic without such a header falls back to the socket address. Empty trusts headers from any source; set it to the addresses the app sees as its peer for the tunnel connector and the Tailscale admin proxy, plus loopback if it is reached directly.
- This is the 0.1.1 fix for #31: before it, `x-forwarded-for` was hard-wired and one of the two paths resolved the wrong address.

## Assets

Images and PDFs for e-mails and hosted pages live in the asset library (`assets.upload`, `assets.list`, `assets.get`, `assets.update`, `assets.delete` over MCP or REST). Uploads are checked against their declared type (PNG, JPEG, GIF, WebP, SVG or PDF), images record their pixel size, and each asset gets a stable public URL `${PUBLIC_LINKS_URL}/a/<id>/<file name>`. SVG logos are welcome: the upload is sanitised against an allow-list (no scripts, event handlers, external links or external CSS) and the response lists what was removed in `sanitized`; an SVG with nothing drawable left, or a DOCTYPE (entity expansion), is refused. Every SVG also gets a PNG rendition at 2× its size, served from the same id with a `.png` name and used automatically in e-mail, because most e-mail clients do not render SVG; hosted pages keep the SVG. Anyone with an asset URL can fetch the file, so treat asset ids as unlisted rather than secret and never upload confidential documents; this is also why `/a` is served by the public-only listener. The size limit defaults to 5 MB and is set with `ASSET_MAX_BYTES` (bytes). Deleting an asset that a latest or published artifact still references is refused unless the caller forces it, and agents may never force; a deleted asset's URL answers 410 Gone.

## Replacing Kit: cutover without losing signups

The site's Kit list has one subscriber, the owner, so **there is no Kit import for this site**. For a site with a real list, see the import step in the [implementation skill](../../.claude/skills/agentic-marketing-implement/SKILL.md).

1. Build and test everything with your own address on Brevo: the form, the confirmation, the welcome e-mail, a test broadcast to a one-person segment. The owner is the only subscriber, which is allowed precisely because Brevo tracks.
2. **Switch the provider to Postmark first** (Broadcast message stream, open and click tracking off) and check `tracking` in Settings → Providers. Do this before any real signup arrives, so nobody is ever on a provider with forced tracking. `tracking: configurable` on the Postmark provider is the expected result.
3. **Switch the forms.** Change the generator's subscribe partial (about 200 pages) to post to the platform, and deploy. From now on, new signups land in the platform.
4. **No Kit import.** The list has one subscriber, the owner; import nothing. A site with a real list would switch the forms first, export active subscribers (Subscribers → export) and import them in the UI (Audience → Imports); the [implementation skill's import step](../../.claude/skills/agentic-marketing-implement/SKILL.md) covers `profiles.import` and the CSV mapping.
5. **Rebuild Kit's automations** (a welcome sequence, if any) as a journey triggered by `Subscription Confirmed`. People imported from Kit do not trigger it; they already had their welcome.
6. **The first Friday issue from the platform.** Mention the change in one line ("same newsletter, new sending address") to limit spam complaints, and watch bounces and complaints in `broadcasts.status`.
7. **Close Kit** after one quiet issue: cancel scheduled broadcasts there, export a final archive, delete the subscriber data (GDPR: no copies without a purpose), cancel the plan, and remove Kit's DNS records.

## Umami alongside the platform

- Umami stays the on-site analytics, cookieless and without profiles. The platform does not replace it in phase A.
- **Newsletter traffic in Umami:** add UTM parameters to links in each issue, e.g. `?utm_source=newsletter&utm_medium=email&utm_campaign=signal-43`. Umami then shows which issues bring readers to which pages. The platform's click counting (if on) and UTM tags work together.
- **Signup conversions in Umami:** keep `data-umami-event="Newsletter subscribe"` on the button. The platform counts confirmations (`Subscription Confirmed`); Umami counts form submissions per page.

## Privacy and legal changes on the site

- **Privacy policy.**
  - Name the platform as the newsletter processor (self-hosted; data stays on the owner's infrastructure).
  - List what is stored: e-mail, first name, consent proof, the newsletter's delivery events, and clicks on links in the newsletter. If clicks should not be counted, set `EMAIL_TRACK_CLICKS=false`; the site's "no redirect trackers" promise is about vendor links on the site, but say so explicitly. This is not enough when the provider tracks anyway: check the adapter's `tracking` capability in Settings → Providers (`forced` means the provider tracks opens and clicks regardless of our setting; Brevo is `forced`, Postmark on the Broadcast stream with `trackOpens` off is `configurable` and leaves tracking off). While Brevo is the provider, the policy must disclose its tracking.
  - Fix the stale "fonts from Google Fonts" paragraph: fonts are self-hosted now (`font-src 'self'`).
- **Form text:** the `consentText` of the form must match the text shown next to the form. Its hash is stored as proof.
- **Kit migration:** no import for this site (one subscriber, the owner). Stop sending from Kit and delete the list there once the platform sends. A site with a real list imports only active subscribers, with Kit's subscription date and source as proof.

## Plan for the implementation session

1. **Platform up.**
   - Docker Compose on the homelab with `PUBLIC_URL` set to the HTTPS Tailscale URL (MCP is only mounted for an HTTPS resource URL; the admin UI and REST still work over the LAN), `PUBLIC_PORT=3001` (public-only listener), `PUBLIC_LINKS_URL=https://am.martechsignal.com`, `CLIENT_IP_HEADER=cf-connecting-ip,x-forwarded-for` and `TRUSTED_PROXY_CIDRS=<tunnel connector>,<Tailscale admin proxy>` (option A).
   - Bootstrap the owner (`cli bootstrap`); set the approval policy to `agent_changes`.
   - Add the **Brevo** adapter as the interim provider with `useFor: [transactional, marketing]`; the owner is the only subscriber until the Postmark switch (see "E-mail provider").
   - Purposes: the defaults fit (`marketing_email` is consent-based; `onboarding` covers the confirmation e-mail). Double opt-in is set on the form (`doubleOptIn: true`); the purposes' `requiresDoubleOptIn` flag is informational only.
2. **Edge.** Set `PUBLIC_PORT=3001` and add the `am.martechsignal.com` hostname to the existing Umami tunnel pointing at `http://app:3001` (option A, no path rule). Check that `/f/…` reaches the app, `/` and `/v1/workspace.get` answer 404, and a raw traversal is refused:
   ```sh
   curl --path-as-is -s -o /dev/null -w '%{http_code}\n' -X POST https://am.martechsignal.com/f/../v1/workspace.get   # 400 or 404
   curl --path-as-is -s -o /dev/null -w '%{http_code}\n' -X POST https://am.martechsignal.com/f/%2e%2e/v1/workspace.get # 400 or 404
   ```
   Neither may answer 401 from the admin API. If the tunnel still uses a path rule, use `^/(f|u|c|a|hooks)(/[^/.%][^/%]*)+/?$`.
3. **Provider switch.** Add Postmark for marketing (Broadcast message stream, open and click tracking off) and Cloudflare Email Service for transactional e-mail if needed; check that Settings → Providers shows `tracking: configurable` (or `none`) for the marketing provider, and disable Brevo for marketing. Do this before switching the forms, so no real subscriber lands on a forced-tracking provider.
4. **Signup.**
   - Create the confirmation template (purpose `onboarding`), the form (DOI, `successUrl` and `confirmedUrl` pages on the site, `allowedOrigins: ["https://martechsignal.com"]`) and the two small pages (`/subscribe/check-your-inbox/`, `/subscribe/welcome/`). Since 0.2.2 the confirm page on `am.martechsignal.com` allows the `confirmedUrl` origin in its own `form-action`, so "Yes, subscribe me" lands on `/subscribe/welcome/` (#115; on 0.2.0 and 0.2.1 the browser stayed on the confirm page). Without `confirmedUrl` the branded confirmed page is shown instead. Test the click in a real browser before go-live.
   - Change the generator's subscribe partial to post to `https://am.martechsignal.com/f/<form id>` with the honeypot field (see "Replacing Kit" for the order).
   - Update the CSP: `form-action 'self' https://am.martechsignal.com`, and drop `app.kit.com` from `form-action` and `connect-src`.
5. **No import.** The Kit list has one subscriber, the owner; nothing to import. For another site, switch the forms first, then export active subscribers and use Audience → Imports (the [implementation skill](../../.claude/skills/agentic-marketing-implement/SKILL.md) documents `profiles.import`).
6. **Newsletter.**
   - Segment `{"consent": "marketing_email"}` ("Newsletter subscribers").
   - Each week: Hermes drafts the issue template and a `broadcast` with `sendAt` Friday 09:00 Copenhagen time (e.g. `2026-10-30T09:00:00+01:00`; offsets are accepted since 0.2) over MCP, runs `broadcasts.preview` (with the template's `templateVersion`) and submits both together with `artifacts.requestPublishBundle` (0.2.6 and later; before that, two `requestPublish` rounds). The result's `reviewUrl` is one review for both; Hermes sends Tim that link. Tim opens it (on a phone if need be), sees the rendered e-mail, the segment and the number of recipients, sends himself a test if wanted, and approves. Check sending under Build → Broadcasts → Sending, or with `broadcasts.status`.
7. **Welcome journey.** Trigger on the `Subscription Confirmed` event: welcome e-mail → wait 3 days → a "start here" e-mail with the three most-read reviews. (A branch on e-mail clicks is not possible yet; see known limits.)
8. **Measure.** Umami keeps on-site analytics. The platform reports the newsletter (`broadcasts.status`, `messages.stats`), signups (`Form Submitted` / `Subscription Confirmed` counts) and the journey (`journeys.stats`).

**Done when:** a real signup gets the confirmation and the welcome e-mail; new subscribers (and the owner) receive one Friday issue sent by a broadcast that Hermes drafted and Tim approved; and unsubscribe and bounces work end to end.

## Upgrading the pilot to 0.2

1. Pull 0.2.0 (`AM_VERSION=0.2.0`); migrations 0023–0025 run on start and only add tables and a column.
2. The public listener (`PUBLIC_PORT=3001`) already serves `/a/` for assets. With a path rule instead, add `a` (rule above).
3. Settings → Workspace: time zone `Europe/Copenhagen`.
4. Design → Assets: upload the logo; Design → Brand: site name "MartechSignal", `https://martechsignal.com`, the logo and the site's accent colour; check Design → Hosted pages, then publish the brand.
5. Keep `STRICT_INPUTS=false` for the first week. Search the logs for `command input has unknown keys`; if Hermes sends any, fix its prompts or tool use, then set `STRICT_INPUTS=true`.
6. If Hermes's token needs different scopes, edit it under Settings → Integrations and API tokens (no new token needed).

## Known limits found while assessing

- People who never confirm keep a profile without consent until retention removes it. The scheduler runs hourly: form-only profiles with no consent record, no other identity and no merge are removed after `RETENTION_UNCONFIRMED_DAYS` (default 30), without suppression so they can sign up again. Finished deliveries and AI calls are removed after `RETENTION_LOG_DAYS` (default 180). `profiles.erase` remains available for an immediate erasure request; it is not needed for routine cleanup.
- Broadcasts have no A/B subject test or send-time optimisation; a broadcast goes to the segment as it is at send time.
- No consent banner component; phase B needs one.
- E-mail clicks are message events, not events on the person's profile, so segments and journey branches cannot use "clicked the newsletter" yet. A small follow-up: publish an `Email Link Clicked` event to the bus from the click route.

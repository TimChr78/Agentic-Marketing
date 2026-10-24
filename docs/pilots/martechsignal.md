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

1. **Own the newsletter.** Signups through the platform with double opt-in, existing Kit subscribers imported with their consent, and the Friday issue sent as a broadcast to a consent-based segment through the owner's SMTP relay (or SES or Postmark).
2. **Welcome journey.** A welcome e-mail after confirmation, then a "start here" e-mail a few days later.
3. **Agent-run operations.** The Hermes agent drafts each issue and broadcast through MCP with an API token; Tim approves in the UI (workspace policy "agent changes need a person").
4. **Keep the privacy promise.** Do not track anonymous visitors in phase A. People who subscribe are known by their e-mail; what they click in e-mails is first-party.
5. **Later (phase B, optional).** Consent-gated on-site tracking and personalization, e.g. a newsletter CTA tailored to the category being read, and segments by interest.

## Fit: what was there, what was missing, what was built

| Need | Before the pilot | Now |
|---|---|---|
| Signup form that works without JavaScript and under the CSP | Missing: ingest takes JSON with a write key | **Built**: `form` artifact; `POST /f/<form>` takes urlencoded or JSON, answers 303 to the site's own pages, checks allowed origins, has a honeypot and a per-IP rate limit |
| Double opt-in (EU practice, and the purposes already had the flag) | Flag only | **Built**: confirmation e-mail (template with `{{ confirm_url }}`, contract purpose); the link opens a page with a button, so mail scanners cannot confirm; consent is recorded with proof (form, version, consent-text hash, submitted and confirmed at) |
| Bot protection | – | **Built**: honeypot and rate limit by default; **Cloudflare Turnstile** per form (`turnstile: true`, secret `turnstile.secret_key`) |
| Move subscribers from Kit with consent | Missing (Phase 1 limit: no bulk import) | **Built**: `profiles.import`, up to 5,000 rows per call, keeping consent history and proof; idempotent; people only. In the UI: a CSV import that recognises Kit's columns |
| Weekly newsletter | Missing: journeys are triggered; `journeys.enroll` caps at 1,000 and is not a campaign | **Built**: `broadcast` artifact (template + segment + optional `sendAt`); it runs once, in batches, through the send gateway; `broadcasts.preview`, `broadcasts.status`, `broadcasts.cancel` |
| E-mail links on the site's domain (unsubscribe, clicks, confirm) | Links used `PUBLIC_URL`, which is also the admin and OAuth URL | **Built**: `PUBLIC_LINKS_URL` (option A: e.g. `https://am.martechsignal.com`; option B: `https://martechsignal.com/am`) |
| Visitor IP behind Cloudflare | Hard-wired `x-forwarded-for` | **Built**: `CLIENT_IP_HEADER` (`cf-connecting-ip` through the tunnel) |
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
  - Platform settings: `PUBLIC_LINKS_URL=https://am.martechsignal.com`, `CLIENT_IP_HEADER=cf-connecting-ip` (the tunnel passes the visitor's IP).
  - Site: the form posts to `https://am.martechsignal.com/f/<form id>`. The CSP's `form-action` swaps `https://app.kit.com` for `https://am.martechsignal.com`. Nothing else changes; the site worker stays as it is.
  - Bounce and complaint webhooks (`/hooks/...`) are served by the same public listener; with a path rule, the strict regex above already includes them.
- **Option B: first-party proxy in `_worker.js`** ([reference](../../.claude/skills/agentic-marketing-implement/references/cloudflare-worker-proxy.js)). `/am/*` on martechsignal.com is forwarded to a tunnel hostname locked with a Cloudflare Access service token. The form then posts to `/am/f/<form id>`.
  - Pick it if the links should live on the main domain, or for phase B tracking, where a same-origin `/am/v1/batch` is safest against ad blockers.
  - It needs worker code and must run before the worker's HTML edge cache.
- **Admin and MCP.** The admin UI and REST work over a plain-HTTP LAN URL (`http://am.lan:3000`); with a plain-HTTP non-loopback `PUBLIC_URL` the server starts normally, but MCP/OAuth is disabled. For MCP, expose the same server over HTTPS — Tailscale Serve/Funnel on the homelab, the Cloudflare Tunnel, or a TLS reverse proxy. Hermes runs on the same server, so it can use REST on the LAN, or MCP over the HTTPS URL with an API token.
- **Turnstile** (free) is better than a CAPTCHA if bots find the form; it needs `challenges.cloudflare.com` in `script-src` and `frame-src`.
- **E-mail sending:** Cloudflare does not send bulk mail. Keep the SMTP relay (with the relay's bounce webhooks if it has them, ADR-0011), or use SES or Postmark. Add SPF, DKIM and DMARC for the sending domain in Cloudflare DNS, and remove Kit's sending-domain records after the switch.
- **Edge cache:** the worker caches HTML for 5 minutes, so personalization must stay client-side (the SDK), which it already is.

## Assets

Images and PDFs for e-mails and hosted pages live in the asset library (`assets.upload`, `assets.list`, `assets.get`, `assets.update`, `assets.delete` over MCP or REST). Uploads are checked against their declared type (PNG, JPEG, GIF, WebP or PDF; SVG is refused), images record their pixel size, and each asset gets a stable public URL `${PUBLIC_LINKS_URL}/a/<id>/<file name>`. Anyone with that URL can fetch the file, so treat asset ids as unlisted rather than secret and never upload confidential documents; this is also why `/a` is served by the public-only listener. The size limit defaults to 5 MB and is set with `ASSET_MAX_BYTES` (bytes). Deleting an asset that a latest or published artifact still references is refused unless the caller forces it, and agents may never force; a deleted asset's URL answers 410 Gone.

## Replacing Kit: cutover without losing signups

1. Build and test everything with your own address: the form, the confirmation, the welcome e-mail, a test broadcast to a one-person segment.
2. **Switch the forms first.** Change the generator's subscribe partial (about 200 pages) to post to the platform, and deploy. From now on, new signups land in the platform.
3. **Then export from Kit** (Subscribers → export, active only) and import in the UI: People & data → Import subscribers. The import maps Kit's columns (`email_address`, `first_name`, `created_at`, `state`), keeps the subscription date and "Kit" as proof, skips inactive rows and duplicates, and uploads in batches of 5,000. Because the export happens after the switch, nobody who signed up in between is lost.
4. **Rebuild Kit's automations** (a welcome sequence, if any) as a journey triggered by `Subscription Confirmed`. People imported from Kit do not trigger it; they already had their welcome.
5. **The first Friday issue from the platform.** Mention the change in one line ("same newsletter, new sending address") to limit spam complaints, and watch bounces and complaints in `broadcasts.status`.
6. **Close Kit** after one quiet issue: cancel scheduled broadcasts there, export a final archive, delete the subscriber data (GDPR: no copies without a purpose), cancel the plan, and remove Kit's DNS records.

## Umami alongside the platform

- Umami stays the on-site analytics, cookieless and without profiles. The platform does not replace it in phase A.
- **Newsletter traffic in Umami:** add UTM parameters to links in each issue, e.g. `?utm_source=newsletter&utm_medium=email&utm_campaign=signal-43`. Umami then shows which issues bring readers to which pages. The platform's click counting (if on) and UTM tags work together.
- **Signup conversions in Umami:** keep `data-umami-event="Newsletter subscribe"` on the button. The platform counts confirmations (`Subscription Confirmed`); Umami counts form submissions per page.

## Privacy and legal changes on the site

- **Privacy policy.**
  - Name the platform as the newsletter processor (self-hosted; data stays on the owner's infrastructure).
  - List what is stored: e-mail, first name, consent proof, the newsletter's delivery events, and clicks on links in the newsletter. If clicks should not be counted, set `EMAIL_TRACK_CLICKS=false`; the site's "no redirect trackers" promise is about vendor links on the site, but say so explicitly.
  - Fix the stale "fonts from Google Fonts" paragraph: fonts are self-hosted now (`font-src 'self'`).
- **Form text:** the `consentText` of the form must match the text shown next to the form. Its hash is stored as proof.
- **Kit migration:** import only active subscribers, with Kit's subscription date and source as proof. Then stop sending from Kit and delete the list there.

## Plan for the implementation session

1. **Platform up.**
   - Docker Compose on the homelab with `PUBLIC_URL` (LAN for admin/REST; use an HTTPS URL for MCP), `PUBLIC_PORT=3001` (public-only listener), `PUBLIC_LINKS_URL=https://am.martechsignal.com` and `CLIENT_IP_HEADER=cf-connecting-ip` (option A).
   - Bootstrap the owner (`cli bootstrap`); set the approval policy to `agent_changes`.
   - Add the e-mail provider (SMTP relay) with `useFor: [transactional, marketing]`.
   - Purposes: the defaults fit (`marketing_email` is consent-based; `onboarding` covers the confirmation e-mail). Double opt-in is set on the form (`doubleOptIn: true`); the purposes' `requiresDoubleOptIn` flag is informational only.
2. **Edge.** Set `PUBLIC_PORT=3001` and add the `am.martechsignal.com` hostname to the existing Umami tunnel pointing at `http://app:3001` (option A, no path rule). Check that `/f/…` reaches the app, `/` and `/v1/workspace.get` answer 404, and a raw traversal is refused:
   ```sh
   curl --path-as-is -s -o /dev/null -w '%{http_code}\n' -X POST https://am.martechsignal.com/f/../v1/workspace.get   # 400 or 404
   curl --path-as-is -s -o /dev/null -w '%{http_code}\n' -X POST https://am.martechsignal.com/f/%2e%2e/v1/workspace.get # 400 or 404
   ```
   Neither may answer 401 from the admin API. If the tunnel still uses a path rule, use `^/(f|u|c|a|hooks)(/[^/.%][^/%]*)+/?$`.
3. **Signup.**
   - Create the confirmation template (purpose `onboarding`), the form (DOI, `successUrl` and `confirmedUrl` pages on the site, `allowedOrigins: ["https://martechsignal.com"]`) and the two small pages (`/subscribe/check-your-inbox/`, `/subscribe/welcome/`).
   - Change the generator's subscribe partial to post to `https://am.martechsignal.com/f/<form id>` with the honeypot field (see "Replacing Kit" for the order).
   - Update the CSP: `form-action 'self' https://am.martechsignal.com`, and drop `app.kit.com` from `form-action` and `connect-src`.
4. **Import.** After the forms are switched, export active Kit subscribers and import them in the UI (People & data → Import subscribers).
5. **Newsletter.**
   - Segment `{"consent": "marketing_email"}` ("Newsletter subscribers").
   - Each week: Hermes drafts the issue template and a `broadcast` with `sendAt` Friday 07:00 UTC over MCP, runs `broadcasts.preview` and requests publishing; Tim approves; check with `broadcasts.status`.
6. **Welcome journey.** Trigger on the `Subscription Confirmed` event: welcome e-mail → wait 3 days → a "start here" e-mail with the three most-read reviews. (A branch on e-mail clicks is not possible yet; see known limits.)
7. **Measure.** Umami keeps on-site analytics. The platform reports the newsletter (`broadcasts.status`, `messages.stats`), signups (`Form Submitted` / `Subscription Confirmed` counts) and the journey (`journeys.stats`).

**Done when:** a real signup gets the confirmation and the welcome e-mail; imported subscribers and new ones receive one Friday issue sent by a broadcast that Hermes drafted and Tim approved; and unsubscribe and bounces work end to end.

## Known limits found while assessing

- People who never confirm keep a profile without consent until retention removes it. The scheduler runs hourly: form-only profiles with no consent record, no other identity and no merge are removed after `RETENTION_UNCONFIRMED_DAYS` (default 30), without suppression so they can sign up again. Finished deliveries and AI calls are removed after `RETENTION_LOG_DAYS` (default 180). `profiles.erase` remains available for an immediate erasure request; it is not needed for routine cleanup.
- Broadcasts have no A/B subject test or send-time optimisation; a broadcast goes to the segment as it is at send time.
- No dedicated UI for forms and broadcasts yet. They are artifacts, so the generic artifact editor, MCP and REST work.
- No consent banner component; phase B needs one.
- E-mail clicks are message events, not events on the person's profile, so segments and journey branches cannot use "clicked the newsletter" yet. A small follow-up: publish an `Email Link Clicked` event to the bus from the click route.

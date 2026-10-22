---
name: agentic-marketing-implement
description: Implement the Agentic Marketing platform (self-hosted, agent-first marketing stack) on a website. Covers deploying it, exposing only its public paths, newsletter signup with double opt-in, importing subscribers with consent, weekly broadcasts, welcome journeys, optional consent-gated tracking and personalization, and Cloudflare Pages/Workers/Tunnel/Turnstile specifics. Use when wiring a site such as martechsignal.com to the platform, migrating a newsletter from Kit, Mailchimp or similar, or planning such a rollout.
---

# Implementing Agentic Marketing on a website

The platform is a self-hosted TypeScript service (repo `TimChr78/Agentic-Marketing`): Postgres, ClickHouse, NATS and Valkey behind one app. Everything it can do is a **command**, exposed three ways: REST at `/v1/<command>`, MCP at `/mcp`, and the web UI. For operating it through MCP, use the `agentic-marketing-mcp` skill.

Read first, from the platform repo: `docs/pilots/martechsignal.md` (a worked assessment and plan), `docs/integrations.md`, `docs/development.md`.

## Principles (do not trade these away)

- **Consent first.** Marketing e-mail needs the `marketing_email` purpose allowed for the person. The send gateway enforces it per person and per message; never work around it (no sending through another tool, no "legitimate interest" without a documented LIA).
- **Double opt-in** for newsletter signups in the EU. Consent is recorded only after the confirmation click, with proof.
- **First-party and minimal.** Public paths go through the site's own domain (`/am/*`); the admin UI, REST commands and MCP never do. Do not add third-party script domains to the CSP for the platform.
- **Keep the site's privacy promise.** If the site says "no tracking", do not add the tracking SDK without a consent banner and an updated privacy policy (phase B).
- **Agents draft, people approve.** Set the workspace approval policy to `agent_changes`. Importing consent, approving, sending and settings are humans-only.

## Workflow

Copy this checklist and work through it in order. Each step says how to check it.

```
- [ ] 1 Assess the site
- [ ] 2 Deploy the platform
- [ ] 3 Expose the public paths (proxy + tunnel)
- [ ] 4 E-mail sending
- [ ] 5 Signup form with double opt-in
- [ ] 6 Import existing subscribers
- [ ] 7 Newsletter broadcast
- [ ] 8 Welcome journey
- [ ] 9 Privacy policy and CSP
- [ ] 10 (Phase B, optional) consent-gated tracking and personalization
```

### 1. Assess the site
Find out:
- the hosting (Cloudflare Pages in advanced mode with `_worker.js`? Then `functions/` does not run);
- the build (a generator? a bundler?);
- the CSP in `_headers`;
- the current newsletter tool and its forms (grep the HTML for the form action);
- the analytics (cookieless or not);
- the privacy policy's promises.

Write the fit down as a table (need / exists / gap), as in `docs/pilots/martechsignal.md`. Do not build platform features from the site repo: missing features belong in the platform repo.

### 2. Deploy the platform
Docker Compose on the host (homelab or VM): copy `.env.example` to `.env` and generate secrets with `openssl rand -base64 32`. Set:
- `PUBLIC_URL`: the admin URL (LAN or VPN), e.g. `http://am.lan:3000`.
- `PUBLIC_LINKS_URL`: the public base for links in e-mails and forms. Option A: `https://am.<site>`; option B: `https://<site>/am`.
- `CLIENT_IP_HEADER`: `cf-connecting-ip` behind a Cloudflare Tunnel (option A), or `x-am-client-ip` with the worker proxy (option B).
- `EGRESS_ALLOWED_HOSTS` only if webhooks must reach the LAN.

Then:
```sh
docker compose up -d
docker compose exec app pnpm --filter @agentic-marketing/server cli bootstrap --email you@site.com --password '…' --workspace 'Site name'
```
Sign in to the UI and set the approval policy to "Agent changes need a person". **Check:** `GET /readyz` returns `{"ok":true}`.

### 3. Expose the public paths
Only these are public: `f/` (forms and confirmations), `u/` (unsubscribe), `c/` (e-mail clicks), plus `hooks/` if a provider posts bounce webhooks. Read [references/cloudflare.md](references/cloudflare.md):
- **Option A (default when a Cloudflare Tunnel already exists, e.g. for Umami):** add a hostname `am.<site>` to that tunnel with a path rule `^/(f|u|c)/` and a 404 catch-all. Add `am.<site>` to the CSP's `form-action`.
- **Option B:** the site's own worker proxies `/am/*` with [references/cloudflare-worker-proxy.js](references/cloudflare-worker-proxy.js) to a tunnel hostname locked with a Cloudflare Access service token. No CSP change; best for phase B tracking.

For other hosts (Netlify, Vercel, nginx), expose the same paths the same way. **Check:** `/` and `/v1/workspace.get` on the public hostname return 404, and a form post returns 303.

### 4. E-mail sending
Add a provider in the UI (E-mails → providers) or with `emailProviders.create` (humans only):
- SMTP relay, SES, Postmark or Brevo; `useFor: ["transactional", "marketing"]`.
- Register the provider's webhook URL for bounces and complaints.
- Set up SPF, DKIM and DMARC for the sending domain.

**Check:** `messages.sendEmail` to yourself (with consent) arrives, and a test bounce shows in `messages.list`.

### 5. Signup form with double opt-in
1. Confirmation template: an `email_template` with **purpose `onboarding`** (contract, so it may be sent before consent) and a link to `{{ confirm_url | raw }}`. Publish it.
2. Form: a `form` artifact, published. Example:
   ```json
   {"purposes":["marketing_email"],"doubleOptIn":true,"confirmationTemplate":"eml_…",
    "consentText":"Send me the weekly newsletter. Unsubscribe any time.",
    "successUrl":"https://<site>/subscribe/check-your-inbox/","confirmedUrl":"https://<site>/subscribe/welcome/",
    "errorUrl":"https://<site>/subscribe/oops/","allowedOrigins":["https://<site>"],"turnstile":false}
   ```
   Publishing refuses a confirmation template whose purpose needs consent, or one without `confirm_url`.
3. Site: replace the old form with the HTML in [references/site-snippets.md](references/site-snippets.md). It is a plain POST to `/am/f/<form id>`: no JavaScript, works under `form-action 'self'`. Add the three small pages.
4. Bots: the honeypot and per-IP rate limit are always on. If spam arrives, set `turnstile: true`, store the secret with `secrets.set` as `turnstile.secret_key`, and add the widget (see the snippets; it needs a CSP change).

**Check:** submit with your own address. You are redirected to the inbox page, the confirmation mail arrives, and the button lands on the welcome page. `consent.history` then shows `granted`, source `form`, with `double_opt_in: true` in the proof. Before the click there is no consent.

### 6. Import existing subscribers
Switch the site's forms to the platform **first**, then export, so nobody who signs up in between is lost.

Export **active** subscribers from the old tool (Kit: Subscribers → export CSV). The person importing uses the UI: People & data → Import subscribers. It recognises Kit's columns (`email_address`, `first_name`, `created_at`, `state`), skips inactive rows and duplicates, and uploads in batches. For scripts, each row maps to:
```json
{"email":"…","traits":{"firstName":"…"},
 "consent":[{"purpose":"marketing_email","status":"granted","recordedAt":"<subscribed at, ISO>",
             "proof":{"system":"Kit","form":"<form or source>","state":"active"}}]}
```
`profiles.import` takes up to 5,000 rows per call and a `label` such as "Kit export 2026-10-22". It is humans only, never an agent token. Re-running the same rows is harmless. Imported people do not trigger journeys on `Subscription Confirmed`.

**Check:** nothing is rejected; a sample's `consent.history` shows the old date and the proof. Then rebuild the old tool's automations as journeys, send the first issue from the platform, and close the old account (delete its subscriber data and its DNS records).

### 7. Newsletter broadcast
- **Once:** a segment `{"consent":"marketing_email"}` named "Newsletter subscribers".
- **Each issue:**
  - an `email_template` with purpose `marketing_email` and `{{ unsubscribe_url | raw }}` in the footer;
  - then a `broadcast` `{"template":"eml_…","segment":"seg_…","sendAt":"<ISO, UTC>"}`;
  - `broadcasts.preview` (audience, would send, skip reasons);
  - request publishing; a person approves.

  A broadcast sends once; a new issue needs a new broadcast. `broadcasts.cancel` stops it.

**Check:** `broadcasts.status` shows `done` and the message counts. Unsubscribing from the issue removes the person from the segment.

### 8. Welcome journey
A `journey` (purpose `marketing_email`):
1. trigger `{"event":"Subscription Confirmed"}`;
2. `email` (welcome);
3. `wait` `P3D`;
4. `email` ("start here");
5. `exit`.

Simulate it with `journeys.simulate`, then publish. E-mail clicks are not profile events yet, so do not branch on "clicked".

### 9. Privacy policy and CSP
- **Privacy policy:** name the platform (self-hosted) as the newsletter processor, and list the data (e-mail, name, consent proof, delivery and click events). Set `EMAIL_TRACK_CLICKS=false` if clicks should not be counted.
- **Form text:** keep `consentText` identical to the text shown next to the form.
- **CSP:** remove the old tool's domains from `form-action` and `connect-src`. Nothing needs adding for phase A.

### 10. Phase B (optional)
Consent-gated tracking and personalization:
- build the SDK (`pnpm --filter @agentic-marketing/sdk-js build`) and host `dist/am.min.js` on the site;
- add a browser source with the site's origin;
- add the SDK's consent banner (`AgenticMarketing.createConsentBanner(am)`), which records choices as consent proof and sends Google Consent Mode v2 signals;
- create `experience` artifacts for placements.

See [references/site-snippets.md](references/site-snippets.md). Without consent, only page, referrer and UTM targeting applies.

## Gotchas
- Cloudflare Pages advanced mode: put the proxy branch first in `_worker.js`, **before** the edge-cache lookup.
- `PUBLIC_LINKS_URL` must match the public hostname or prefix exactly, or unsubscribe and confirm links break.
- Add UTM parameters to links in issues (`utm_source=newsletter&utm_medium=email&utm_campaign=<issue>`) so the site's analytics (e.g. Umami) attributes newsletter traffic.
- Form submissions and confirmations arrive as events; consent appears a moment later, after identity resolution.
- If the workspace's tracking plan blocks unknown events, add `Form Submitted`, `Subscription Confirmed` and `Subscription Imported`.
- People who never confirm keep a profile without consent; erase stale ones periodically (`profiles.erase`).

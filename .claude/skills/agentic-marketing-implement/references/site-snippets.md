# Site snippets

## Signup form (no JavaScript, CSP-safe)

The `action` is the links URL plus `/f/<form id>`: `https://am.<site>/f/frm_…` with option A (the tunnel hostname, listed in the CSP's `form-action`), or `/am/f/frm_…` with option B (the worker proxy).

```html
<form class="sub-form" action="https://am.example.com/f/frm_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" method="post">
  <label class="visually-hidden" for="sub-email">Work email</label>
  <input id="sub-email" type="email" name="email" placeholder="you@company.com" autocomplete="email" required>
  <input type="text" name="firstName" placeholder="First name (optional)" autocomplete="given-name">
  <!-- Honeypot: hidden from people, filled by bots. Keep the name am_hp. -->
  <div aria-hidden="true" style="position:absolute;left:-10000px"><input type="text" name="am_hp" tabindex="-1" autocomplete="off"></div>
  <input type="hidden" name="page" value="/current/path/">
  <button type="submit" data-umami-event="Newsletter subscribe">SUBSCRIBE</button>
  <p class="consent">Send me the weekly newsletter. Unsubscribe any time.</p>  <!-- = the form's consentText -->
</form>
```

- Inline `style` is allowed by `style-src 'unsafe-inline'`; with a stricter CSP use a class.
- Generators that emit the form on many pages should do it from one partial; set `page` per page.
- The form answers 303 to `successUrl`, or to `errorUrl?error=<code>`. Codes: `invalid_email`, `rate_limited`, `origin_not_allowed`, `challenge_failed`, `invalid`.

Pages to add:
- **`/subscribe/check-your-inbox/`**: "Check your inbox: we sent a confirmation link. It is valid for 7 days." Make it `noindex`.
- **`/subscribe/welcome/`**: "You're in. The next issue arrives Friday." Make it `noindex`.
- **`/subscribe/oops/`**: read `?error=` and say what to do. Without JavaScript, show a generic text with a link back.

## JSON post (when the site has its own JavaScript)

```js
const res = await fetch('/am/f/frm_…', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, firstName, page: location.pathname }) });
// { ok: true, doubleOptIn: true } | { ok: false, error: 'invalid_email' }
```

## Confirmation e-mail (MJML + Liquid, purpose "onboarding")

```xml
<mjml><mj-body><mj-section><mj-column>
  <mj-text>Hi {{ profile.firstName | default: "there" }}, one click to confirm your subscription:</mj-text>
  <mj-button href="{{ confirm_url | raw }}">Yes, subscribe me</mj-button>
  <mj-text font-size="12px">If you did not sign up, ignore this e-mail; nothing happens.</mj-text>
</mj-column></mj-section></mj-body></mjml>
```

## Newsletter issue footer (purpose "marketing_email")

```xml
<mj-text font-size="12px">You get this because you subscribed at example.com.
  <a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text>
```
The platform also adds `List-Unsubscribe` and `List-Unsubscribe-Post` headers (RFC 8058).

## Phase B: consent-gated tracking (only with a consent banner)

1. Build the SDK in the platform repo with `pnpm --filter @agentic-marketing/sdk-js build`. Copy `packages/sdk-js/dist/am.min.js` to the site as `/am.min.js` (self-hosted, so `script-src 'self'` covers it).
2. Create a browser source (`sources.create {"kind":"browser","allowedOrigins":["https://<site>"]}`) and copy its public write key.
3. Load the script:
   ```html
   <script src="/am.min.js" defer></script>
   <script src="/am-init.js" defer></script>   <!-- own file: no inline scripts under the CSP -->
   ```
   `am-init.js`:
   ```js
   window.am = AgenticMarketing.createAnalytics({ writeKey: 'pk_…', host: location.origin + '/am' });
   // The banner calls: am.setConsent({ analytics: true, web_personalization: false });
   am.page();
   ```
   Before consent the SDK sends nothing and stores nothing.
4. Extend the proxy allow-list with `v1/batch` and `v1/decide` (already in the reference). Phase A needs no `connect-src` change (same origin).

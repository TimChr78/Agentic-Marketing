# Cloudflare setup for Agentic Marketing

## Contents
- Topology
- Option A: hostname on the existing tunnel
- Option B: worker proxy and Access
- Pages worker proxy (option B)
- Turnstile
- DNS for e-mail
- Checks

## Topology

Two ways to publish the platform's public paths. Option A is the default and recommended choice when a tunnel already serves something like Umami; Option B keeps the links first-party under `/am/*` and is the natural fit for phase B.

```
Option A (existing tunnel)
visitor ─► https://site/…            Cloudflare Pages (unchanged)
form post, e-mail links ─► https://am.site/{f,u,c,hooks}/…  ─► tunnel ─► app:3001   (public-only listener; other paths 404 there)

Option B (worker proxy)
visitor ─► https://site/am/(f|u|c|n|v1/batch|v1/decide)… ─► _worker.js ─► https://am-edge.site (Access: service token) ─► tunnel ─► app:3000

admin UI, REST ─► http://am.lan:3000 or https://…  (LAN / VPN; plain HTTP is fine for admin and REST)
MCP, OAuth ─► https://…                             (HTTPS only: Tailscale, tunnel or TLS proxy)
```

The admin UI, REST and MCP are never public paths. With a plain-HTTP non-loopback `PUBLIC_URL` such as `http://am.lan:3000`, the server starts normally and the admin UI and REST work, but the MCP/OAuth endpoints are disabled; MCP needs HTTPS (Tailscale Serve/Funnel, a Cloudflare Tunnel or a TLS reverse proxy).

Provider webhooks (`/hooks/email/…`) and inbound connector webhooks (`/hooks/in/…`) need a public route only if they are used. They are part of the public listener, so enable `hooks` there (or in the strict path rule) when needed.

## Option A: hostname on the existing tunnel

Set `PUBLIC_PORT=3001` on the platform: it then serves the admin UI, REST and MCP on `3000` (LAN/VPN only) and **only** `/f`, `/u`, `/c`, `/a`, `/n`, `/hooks`, `/healthz` and `/readyz` on `3001`. Point the tunnel at `3001`, so no path rule is needed and nothing else can be reached whatever the proxy forwards. Option A is the default and recommended choice when a tunnel already serves something like Umami.

Tunnel config (locally managed `config.yml`), next to the existing rules:
```yaml
ingress:
  - hostname: analytics.example.com      # e.g. existing Umami
    service: http://umami:3000
  - hostname: am.example.com
    service: http://app:3001             # public-only listener; no path rule
  - service: http_status:404
```
- **Dashboard-managed tunnel:** Zero Trust → Networks → Tunnels → the tunnel → Public hostnames. Add one entry: `am.example.com` → `http://app:3001`. No catch-all entry and no path regex are needed.
- **Strict path rule, only if the tunnel cannot use the second port:** a loose prefix rule is unsafe because cloudflared matches the **raw** path and forwards it raw; `/f/../v1/workspace.get` passes a rule that only checks the prefix and the app then resolves it to the admin API. Use `^/(f|u|c|a|n|hooks)(/[^/.%][^/%]*)+/?$` with a `http_status:404` catch-all, and keep the platform's own guard (it rejects dot-segments and encoded dots/slashes with 400 on both listeners).
- **cloudflared in Compose** (if not running already):
  ```yaml
  cloudflared:
    image: cloudflare/cloudflared:2026.9.3
    command: tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}
  ```
- **Platform:** `PUBLIC_PORT=3001`, `PUBLIC_LINKS_URL=https://am.example.com`, `CLIENT_IP_HEADER=cf-connecting-ip`.
- **Site CSP:** `form-action 'self' https://am.example.com`, and remove the old newsletter tool's domain. Add `connect-src https://am.example.com` only if forms post JSON with JavaScript.

## Option B: worker proxy and Access

1. Create a tunnel hostname `am-edge.<domain>` → `http://app:3000`.
2. Protect it with Zero Trust → Access → Applications → Self-hosted for `am-edge.<domain>`:
   - add a policy with action **Service Auth**, including a new service token;
   - keep the client id and secret for the worker.

   Requests without the token never reach the app.

## Pages worker proxy (option B)

- Copy [cloudflare-worker-proxy.js](cloudflare-worker-proxy.js) to the site root as `am-proxy.js`. Make sure the deploy step uploads it, e.g. `stage_deploy.py` for a staged deploy dir.
- In `_worker.js`:
  ```js
  import { proxyAgenticMarketing } from './am-proxy.js';
  export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/am/')) return proxyAgenticMarketing(request, env, url);
      // … existing logic (slash normalisation, Markdown negotiation, edge cache) …
    },
  };
  ```
- Pages project → Settings → Variables and secrets: `AM_ORIGIN=https://am-edge.<domain>`, `AM_ACCESS_ID`, `AM_ACCESS_SECRET` (secret).
- Platform `.env`: `PUBLIC_LINKS_URL=https://<site>/am`, `CLIENT_IP_HEADER=x-am-client-ip`.
- `_headers`: no change is needed for forms (`form-action 'self'`). Responses under `/am/` are `no-store`; the site's `/*` cache headers do not apply to worker responses.

## Turnstile

Only if bots get through the honeypot:
1. Dashboard → Turnstile → add the site → keep the site key (public) and the secret key.
2. Platform: `secrets.set {"name":"turnstile.secret_key","value":"…"}` (humans only); on the form artifact set `"turnstile": true` and publish.
3. Site: add `<div class="cf-turnstile" data-sitekey="…"></div>` in the form and `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`.
4. CSP: add `https://challenges.cloudflare.com` to `script-src` and `frame-src` (add `frame-src` if absent).

## DNS for e-mail

In the Cloudflare DNS of the sending domain:
- SPF: `v=spf1 include:<relay's include> -all`;
- DKIM: the relay's CNAME or TXT records;
- DMARC: `_dmarc TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@<domain>"`.

Cloudflare Email Routing receives mail only; it does not send newsletters.

## Checks

```sh
# Option A
curl -s -o /dev/null -w '%{http_code}\n' https://am.<domain>/                     # 404: nothing but f/u/c/a/n/hooks is public
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://am.<domain>/v1/workspace.get  # 404: commands are not public
curl --path-as-is -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://am.<domain>/f/../v1/workspace.get                              # 400 or 404, never 401
curl --path-as-is -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://am.<domain>/f/%2e%2e/v1/workspace.get                          # 400 or 404, never 401
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -X POST \
  -d 'email=you@example.com' -H 'origin: https://<site>' https://am.<domain>/f/<form id>   # 303 to successUrl
# Option B: the same through https://<site>/am/…, and https://am-edge.<domain>/readyz gives 403 without the token
```

`curl --path-as-is` is required: without it curl removes the dot-segment before sending, which hides the bypass. A 401 means the raw path reached the admin API and the edge rule or public listener is not in place.

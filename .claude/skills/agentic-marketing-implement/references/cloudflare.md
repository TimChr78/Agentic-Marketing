# Cloudflare setup for Agentic Marketing

## Contents
- Topology
- Tunnel and Access
- Pages worker proxy
- Turnstile
- DNS for e-mail
- Checks

## Topology

```
visitor ─► https://site/…        Cloudflare Pages (_worker.js)
              └─ /am/*  ─────────► https://am-edge.<domain>  (Cloudflare Tunnel, Access: service token)
                                        └─► cloudflared ─► app:3000 (homelab)
admin, MCP ─► http://am.lan:3000  (LAN / Tailscale only)
```

Only the paths in the proxy's allow-list are reachable from the internet:
- `f/…` (forms and confirmations), `u/…` (unsubscribe), `c/…` (e-mail clicks);
- later `v1/batch` and `v1/decide` (SDK).

Provider webhooks (`/hooks/email/…`) and inbound connector webhooks (`/hooks/in/…`) need their own public route only if they are used. Add them to the tunnel's public ingress, not to the site proxy.

## Tunnel and Access

1. Create a tunnel: Zero Trust → Networks → Tunnels → Create (`cloudflared`). Run the connector next to the app, e.g. as a Compose service:
   ```yaml
   cloudflared:
     image: cloudflare/cloudflared:2026.9.3
     command: tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}
   ```
2. Add a public hostname `am-edge.<domain>` → `http://app:3000`.
3. Protect it with Zero Trust → Access → Applications → Self-hosted for `am-edge.<domain>`:
   - add a policy with action **Service Auth**, including a new service token;
   - keep the client id and secret for the worker.

   Requests without the token never reach the app.
4. If provider webhooks must reach the app, add a second hostname with an Access bypass policy for the exact path `/hooks/email/*` only.

## Pages worker proxy

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
curl -s -o /dev/null -w '%{http_code}\n' https://<site>/am/v1/artifacts.list   # 404: commands are not exposed
curl -s -o /dev/null -w '%{http_code}\n' https://am-edge.<domain>/readyz        # 403 from Access without the token
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -X POST \
  -d 'email=you@example.com' -H 'origin: https://<site>' https://<site>/am/f/<form id>   # 303 to successUrl
```

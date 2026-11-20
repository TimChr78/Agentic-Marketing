---
section: Fixed
issues: [1162]
---
- The Cloudflare Pages first-party proxy reference (`cloudflare-worker-proxy.js`) now allows the preference-centre and topic-unsubscribe links (`/u/p/*`, `/u/t/*`), public uploaded assets (`/a/*`), brand domain verification (`/.well-known/am-domain/*`) and web push (`/v1/push/config`, `/v1/push/subscribe`, `/v1/push/unsubscribe`). Sites using Option B should copy the updated file.

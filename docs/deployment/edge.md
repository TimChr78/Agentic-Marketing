# Edge decisions on Cloudflare Workers

The decision API (`POST /v1/decide`) can also answer from a Cloudflare Worker, in the visitor's region and on your own domain. The server stays the source of truth: it mirrors what the worker needs to Workers KV, and the worker decides with the same code (`@agentic-marketing/personalize/core`).

## What goes to KV

| Key | Value | Written |
|---|---|---|
| `am:key:<write key hash>` | the source: workspace, kind, allowed origins, enabled | when sources change |
| `am:exp:<workspace>` | published experiences and the workspace's purposes | when either changes |
| `am:snap:<workspace>:a:<anonymous id>`, `…:u:<user id>` | the profile snapshot: profile id, non-personal traits, segment ids | as snapshots change, 30-day expiry |

Write keys are stored only as hashes. Snapshots hold what the server's hot state holds and nothing more: no e-mail, phone or other personal traits. Erasing a person deletes their snapshots at the edge too, within seconds. With `snapshots: false` nothing about people goes to KV, and only page, referrer, UTM and device targeting work at the edge.

The edge does not see this visit's session (page views and events so far): session and new-visitor conditions read as "no session" there. Keep experiences that need them on the server's decision API.

## Set it up

1. In Cloudflare, create a KV namespace and an API token with **Workers KV Storage: Edit** for the account.
2. Turn on the mirror (people only, as it holds a credential):

   ```json
   edge.configure { "accountId": "<32 hex>", "namespaceId": "<32 hex>", "apiToken": "<token>", "enabled": true }
   ```

   The scheduler role pushes experiences and write keys within a second, then backfills everyone's snapshot. `edge.status` shows the last sync and any error; `edge.sync` pushes again (with `backfillSnapshots: true`, it also rewrites all snapshots).
3. Deploy the worker:

   ```bash
   cd packages/edge-worker
   cp wrangler.toml.example wrangler.toml   # set the KV namespace id and your route
   npx wrangler deploy
   ```

4. Point the SDK at it:

   ```js
   const am = createAnalytics({ writeKey, host: 'https://marketing.example.com', decideUrl: 'https://www.example.com/am/v1/decide' });
   ```

Events, forms and e-mail links keep going to `host`.

## Freshness

- Experiences and write keys: at most one sync (about a second) plus the worker's isolate cache (`AM_CACHE_SECONDS`, 10 by default) plus KV propagation (up to a minute in far regions).
- Snapshots: written when the server's snapshot changes, then KV propagation. A brand-new visitor has no snapshot anywhere, at the edge or on the server.
- If the mirror fails (bad token, Cloudflare down), the worker keeps answering from what KV has, and `edge.status` shows the error. Queued snapshot changes and deletions wait in the outbox until the next successful sync.

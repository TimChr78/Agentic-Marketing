# Edge decisions on Cloudflare Workers

The decision API (`POST /v1/decide`) can also answer from a Cloudflare Worker, in the visitor's region and on your own domain. The server stays the source of truth: it mirrors what the worker needs to Workers KV, and the worker decides with the same code (`@agentic-marketing/personalize/core`).

## What goes to KV

| Key | Value | Written |
|---|---|---|
| `am:key:<write key hash>` | the source: workspace, kind, allowed origins, enabled | when sources change |
| `am:exp:<workspace>` | published experiences and the workspace's purposes | when either changes |
| `am:snap:<workspace>:a:<anonymous id>`, `…:u:<user id>` | the profile snapshot: profile id, non-personal traits, segment ids | as snapshots change, 30-day expiry |

Write keys are stored only as hashes. Snapshots hold what the server's hot state holds and nothing more: no e-mail, phone or other personal traits. Erasing a person deletes their snapshots at the edge too, within seconds. With `snapshots: false` nothing new about people is written to KV, any snapshots already there are removed (see below), and only page, referrer, UTM and device targeting work at the edge.

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

## Turning it off, and changing the target

`edge.configure` with `enabled: false` stops all writes and owes a remote cleanup: the next sync deletes the workspace's bundle, write keys and every snapshot under `am:snap:<workspace>:` in KV. The worker then answers 401 (its write key is gone) and returns no experiences, so disabling the mirror revokes the serving configuration instead of only stopping new uploads. `snapshots: false` while staying enabled removes only the people (`am:snap:<workspace>:*`) and keeps the bundle and write keys for page, referrer, UTM and device targeting.

The cleanup is a state on the target, not a best-effort delete: `edge.status.cleanup` stays `snapshots` or `all` until Cloudflare confirms the deletions, `edge.status.lastError` shows a failed attempt, and the scheduler retries. People erased while a cleanup is owed are queued as tombstones and retried the same way; `edge.status.pendingDeletes` counts them. Never treat an erasure as complete at the edge while `pendingDeletes` or `cleanup` is non-zero. There is still a short window after a successful cleanup in which the worker's isolate cache (`AM_CACHE_SECONDS`) and KV propagation can serve the last copy; deployments that need an immediate cut-off should also remove the worker route.

Changing `accountId`, `namespaceId` or `apiBase` is a destination migration. It starts a fresh backfill in the new namespace and lists the old namespace's `am:snap:<workspace>:` keys and the keys the workspace pushed, deleting them before anything is written to the new target. Rotating only `apiToken` keeps the bundle and the finished backfill; omitting `apiBase` preserves the configured base. Concurrent syncs serialize per workspace across scheduler replicas. A configuration change fences an older sync, preserving the new backfill/cleanup and leaving snapshot work queued until it reaches the current destination. Returning to a previously used namespace includes its old write keys in cleanup. Targets disabled by an older version get the pending cleanup automatically when migration `0070_edge_cleanup.sql` runs.

An earlier destination is cleaned with the current token. The same account is enough when only the namespace moved; a target in another account needs a token with access to that account, which this version does not retain. Such copies remain listed in `edge.status.staleTargets` with the last error and must be deleted manually in Cloudflare (in the old namespace: `am:exp:<workspace>`, the workspace's `am:key:*` entries and `am:snap:<workspace>:*`). The server cannot discover them without credentials for that account and does not report the migration as fully cleaned.

## Freshness

- Experiences and write keys: at most one sync (about a second) plus the worker's isolate cache (`AM_CACHE_SECONDS`, 10 by default) plus KV propagation (up to a minute in far regions).
- Snapshots: written when the server's snapshot changes, then KV propagation. A brand-new visitor has no snapshot anywhere, at the edge or on the server.
- If the mirror fails (bad token, Cloudflare down), the worker keeps answering from what KV has, and `edge.status` shows the error. Queued snapshot changes and deletions wait in the outbox until the next successful sync.

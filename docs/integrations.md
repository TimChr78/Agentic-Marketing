# Integrations: webhooks, API tokens, connectors and n8n

How other systems talk to the platform and back. Design: [ADR-0013](architecture/adr/0013-integrations.md). In the UI, all of this is under Settings → Integrations and API tokens.

## API tokens (scripts, n8n, cron)

`apiTokens.create` (UI: Settings → Integrations and API tokens) makes a token `amk_…`, shown once. Admins can later rename it, narrow its scopes (applies on its next request) or widen them with their password (`apiTokens.update`); `apiTokens.get` shows its owner, last use and change history.
- It acts as an **agent** for the person who made it. Its permissions are their current role's, limited to the scopes chosen.
- An agent cannot run humans-only commands (approving, members, secrets, settings). Revoked or expired tokens, or tokens of someone who left the workspace, stop working at once.
- Every call is in the audit log as `token:<id>`.

```sh
curl -X POST https://marketing.example.com/v1/journeys.enroll \
  -H "Authorization: Bearer amk_…" -H "content-type: application/json" \
  -d '{"artifactId":"jrn_…","profileIds":["prf_…"],"reason":"n8n: trial ended"}'
```

The same token works for MCP at `/mcp`. In n8n, use the **MCP Client Tool** with "Bearer Auth".

## Outbound webhooks

`webhooks.create` registers an endpoint and returns its signing secret (`whsec_…`) once.

**What it receives:**
- **Customer events.** List event names (`"Order Completed"`, `"Segment Entered"`), `identify`/`page` for those calls, or `*` for everything.
- **Journey webhook steps**, which send to an endpoint whatever their events setting.

**Purpose.** Set `purpose` and only people for whom that purpose is allowed are sent. Journey steps check the journey's purpose.

**Payload** (Standard Webhooks; no e-mail addresses, phone numbers or other personal traits):
```json
{ "type": "event.track", "timestamp": "2026-10-22T10:00:00Z",
  "data": { "event": { "messageId": "…", "type": "track", "name": "Order Completed", "properties": { "total": 899 } },
            "profile": { "id": "prf_…", "traits": { "plan": "pro" } } } }
```
Journey steps send `"type": "journey.webhook"` with `data.journey` and the step's `data` (a JSONata expression, default: the profile and the trigger event).

**Verifying.** Use any Standard Webhooks library, or:
```js
const [id, ts, sig] = ['webhook-id', 'webhook-timestamp', 'webhook-signature'].map((h) => req.headers[h]);
const key = Buffer.from(secret.replace('whsec_', ''), 'base64');
const expected = 'v1,' + crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
const ok = sig.split(' ').includes(expected) && Math.abs(Date.now() / 1000 - ts) < 300;
```

**Retries.**
- A non-2xx answer or a timeout (10 s) is retried after 10 s, 1 min, 5 min, 30 min, 2 h, 6 h and 12 h, then the delivery is `dead`. A `410 Gone` gives up at once.
- `deliveries.list` shows every attempt. `deliveries.retry` sends a dead delivery again.
- Each event's `webhook-id` stays the same across retries, so receivers can de-duplicate.

**Network safety.**
- The platform only connects to public addresses: private, loopback, link-local and metadata ranges are refused, both in the URL and after DNS resolution.
- It never follows redirects.
- To reach something on your LAN (a homelab n8n), list it in `EGRESS_ALLOWED_HOSTS`, e.g. `n8n.lan,192.168.1.0/24`.

## Inbound webhooks (connections)

`connections.create` with a connector that receives webhooks returns a secret URL `/hooks/in/<connection>/<token>`, once. Its events go through the same tracking plan, personal-data rules and identity resolution as the Segment API.

| Connector | Receives | Actions |
|---|---|---|
| `webhook` | Any JSON. A JSONata `mapping` over `{body, headers}` returns Segment events. Optional `signature`: `hmac-sha256` (header, hex/base64, prefix, e.g. GitHub's `sha256=`) or `standard-webhooks` | – |
| `shopify` | `orders/create`, `orders/paid`, `orders/fulfilled`, `orders/cancelled`, `refunds/create`, `checkouts/create`, `customers/*`. Becomes identify (customer id as `shopify:<id>`, e-mail), Order Completed / Paid / Shipped / Cancelled / Refunded and Checkout Started; with `syncEmailConsent`, Shopify's e-mail marketing consent becomes `marketing_email` consent. Verified with `X-Shopify-Hmac-Sha256` | – |
| `shopify_app` | The same webhooks, signed with your app's secret. Installed with OAuth (`read_customers`, `read_orders`); `shopify.importCustomers` imports existing customers, 250 per call | `registerWebhooks {inboundUrl}` |
| `salesforce` | Records posted by a Flow or Apex callout, signed with HMAC-SHA256 (hex, `x-am-signature`): `{recordId, sobject, email, traits, event, properties}` become identify (`salesforce:<id>`) and track | `upsertContact {email, lastName, firstName, fields}`, `createLead`, `createTask {subject, whoId, whatId, dueDate}`, `query {soql}` (SELECT only); OAuth with your connected app |
| `slack` | – | `postMessage {text}` through an incoming-webhook URL |
| `http` | – | `request {method, path, body}` against a base URL with secret headers |

Example generic mapping (a form tool):
```
{ "type": "track", "event": "Lead Created", "userId": "lead:" & body.id, "properties": { "score": body.score } }
```

## Automation steps in journeys

| Step | Config | Behaviour |
|---|---|---|
| `transform` | `set`, `expression` (JSONata) | Stores the result as `vars.<set>` |
| `action` | `connection`, `action`, `input` (object or JSONata), `timeout` | Runs asynchronously; edges `[ok, error]`. Retries twice; the result is in `results.<node>` |
| `webhook` | `endpoint`, `data` (JSONata, optional) | Queues a signed delivery if the journey's purpose is allowed for the person; continues at once |

Expressions see `{profile: {id, traits}, event, vars, content, results}`, with non-personal traits only. `journeys.simulate` takes `actions: {node: "ok"|"error"}`. Publishing checks that endpoints, connections and actions exist and that literal inputs fit.

## n8n recipes

- **React to events:** n8n *Webhook* trigger node, then `webhooks.create` with its production URL and the events. Verify the signature in a *Code* node (snippet above).
- **Feed events in:** a `webhook` connection with a mapping. n8n's *HTTP Request* node POSTs to the inbound URL. Or call `/v1/track` with a server source's write key.
- **Drive the platform:** an API token with the scopes it needs, then *HTTP Request* to `/v1/<command>` or the *MCP Client Tool* on `/mcp` (e.g. enroll people in a journey, create a draft segment).

## Writing a connector

A connector is one object; add it to `packages/integrations/src/connectors` and to the `connectors` map.

```ts
import { z } from 'zod';
import { defineConnector } from '../sdk';

export const pipedriveConnector = defineConnector({
  id: 'pipedrive',
  label: 'Pipedrive',
  description: 'Creates deals in Pipedrive from journeys.',
  auth: 'api_key',
  settings: z.object({ companyDomain: z.string() }),
  secrets: z.object({ apiToken: z.string() }), // sealed, write-only
  rateLimit: 60, // calls per minute per connection
  actions: {
    createDeal: {
      label: 'Create a deal',
      description: 'A deal with a title and value.',
      input: z.object({ title: z.string(), value: z.number().optional() }),
      async run(input, { settings, secrets, request }) {
        const res = await request(`https://${settings.companyDomain}.pipedrive.com/api/v1/deals?api_token=${secrets.apiToken}`, {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (res.status >= 300) throw new Error(`Pipedrive answered ${res.status}`); // takes the error edge
        return JSON.parse(res.body).data; // stored as results.<node>.result
      },
    },
  },
});
```

**Rules for connectors:**
- Use the injected `request`, never your own HTTP client: it applies the egress guard, timeouts and size limits.
- Parse nothing outside the declared schemas.
- For inbound connectors, implement `verify` (return why a request is not authentic, or `null`) and `map` (payload → Segment events). Give each event a stable `messageId` from the sender's delivery id, so redelivered webhooks are de-duplicated.

The settings, secrets and input schemas show up in `connectors.list` (UI and MCP) automatically.

## Config as code

`config.export` returns every artifact of a workspace (published versions, or the latest drafts with `includeDrafts`) as one JSON bundle; `config.import` applies a bundle to a workspace. Artifact ids travel with the bundle (they are unique per workspace), so references between artifacts hold, e.g. from staging to production. An import creates missing artifacts, puts changed content in a new draft and leaves equal ones alone. It starts as a dry run; `publish: true` publishes in dependency order through the approval policy (an API token counts as an agent). Nothing is ever deleted.

With `includeSettings: true` the bundle also carries the workspace's **non-secret settings**: its name, display time zone, approval policy, test-send seed list and agent autonomy ceilings. `config.drift` compares a bundle with the current workspace and lists what would be created, updated, unchanged or conflicting, without writing anything. A bundle with settings imports them only for a person with `workspace:admin` (agents cannot change workspace settings), and it applies them before publishing, so a clone publishes under the copied approval policy.

Secrets never travel: provider credentials, API tokens, stored secret values, agents and people are not part of a bundle, and settings containing extra credential-shaped keys are refused rather than silently accepted. Keep those in `.env`, the encrypted secret store and `profiles.import`/`members.*`.

For git, `scripts/am-config.mjs` keeps one file per artifact plus an optional `_settings.json`:

```bash
export AM_URL=https://marketing.example.com AM_TOKEN=amk_…   # token scopes: artifacts:read, artifacts:write (+ artifacts:publish)
scripts/am-config.mjs pull config/                    # config/<type>/<name>.<id>.json
scripts/am-config.mjs pull config/ --settings         # also config/_settings.json (non-secret)
scripts/am-config.mjs push config/                    # dry run: what would change
scripts/am-config.mjs push config/ --apply --publish  # e.g. from CI after a merge
scripts/am-config.mjs drift config/                   # exit 1 on conflicts; writes nothing
```

Cloning a workspace (for example staging → a new production workspace):

1. In staging, export with settings: `config.export { "includeSettings": true }` (or `am-config.mjs pull config/ --settings`).
2. Create an empty workspace and make yourself its owner. Providers, API tokens, members and agents are configured there separately; they are not cloned.
3. In the new workspace, run `config.drift` with the bundle and review it, then `config.import { bundle, dryRun: false, publish: true }`. The artifacts keep their ids, so references survive; the settings are applied and the import publishes through the copied approval policy.
4. `config.drift` again: everything should be `unchanged`. Keep the bundle (or the `config/` directory) in git and run `drift` in CI to see changes before they are pushed.

## Warehouse export

`warehouse.create` (owners and admins, in the UI or over REST) adds a destination that receives the workspace's data on a schedule (`everyMinutes`, default 60; `warehouse.run` runs it now):

| Dataset | Rows | How |
|---|---|---|
| `profiles` | profile id, merged-into, non-personal traits, first/last seen | incremental (changed since the last run) |
| `identifiers` | user ids and anonymous ids (never e-mail or phone) | incremental (new ones) |
| `consent` | consent state per person, purpose and channel | incremental |
| `segment_memberships` | who is in which segment | full snapshot each run |
| `events` | events with properties and context | incremental, from ClickHouse |
| `message_events` | sends, deliveries, opens, clicks, bounces… | incremental, from ClickHouse |

Personal traits stay behind: they are sealed per person and never exported. Erasures are exported too, so the warehouse can forget the same people.

- **Postgres** (`kind: "postgres"`, `secrets: { url }`, `config: { schema }`): upserts into `am_*` tables with the workspace id in every key; snapshots are replaced in one transaction; erasures delete the person's rows (events through the exported ids) and are recorded in `am_erasures`.
- **S3-compatible storage** (`kind: "s3"`, `config: { bucket, region, endpoint?, prefix }`, `secrets: { accessKeyId, secretAccessKey }`): gzipped NDJSON under `<prefix>/workspace=<id>/<dataset>/dt=<day>/` (snapshots under `snapshot=<run>/`, complete when `_complete.ndjson.gz` exists; erasures under `erasures/`). Load it with BigQuery (`bq load --source_format=NEWLINE_DELIMITED_JSON`, or an external table), Snowflake (an external stage and `COPY INTO … FILE_FORMAT = (TYPE = JSON)`), Redshift `COPY … FORMAT JSON 'auto'`, DuckDB or Spark. Endpoints for R2, GCS (interoperability) or MinIO take path-style requests. Apply the erasure files downstream.

Runs read up to two minutes before now, so late writes land in the next run; a failed run is repeated in full (harmless for Postgres; files may repeat rows). Destinations on private addresses need `EGRESS_ALLOWED_HOSTS`.


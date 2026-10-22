# Integrations: webhooks, API tokens, connectors and n8n

How other systems talk to the platform and back. Design: [ADR-0013](architecture/adr/0013-integrations.md). In the UI, all of this is in Live workspace → Integrations.

## API tokens (scripts, n8n, cron)

`apiTokens.create` (UI: Integrations → API tokens) makes a token `amk_…`, shown once.
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
| `shopify` | `orders/create`, `orders/paid`, `checkouts/create`, `customers/*`. Becomes identify (customer id as `shopify:<id>`, e-mail), Order Completed / Order Paid and Checkout Started. Verified with `X-Shopify-Hmac-Sha256` | – |
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

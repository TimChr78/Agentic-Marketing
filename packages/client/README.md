# @agentic-marketing/client

The typed REST client. Input and output types are inferred from the command registry, so a
command change breaks callers at compile time.

```ts
import { callWithRetry, createClient } from '@agentic-marketing/client';
import type { Commands } from '@agentic-marketing/server/src/registry';

const api = createClient<Commands>({ baseUrl: 'https://am.example.com', headers: { authorization: `Bearer ${token}` } });
const artifact = await api.call('artifacts.create', { type: 'note', name: 'Hi', content: { title: 'Hi', body: 'x' } });
```

## Safe retries: `callWithRetry`

`call` sends one attempt. A retry of a write must reuse the same idempotency key, or the server
runs it a second time. `callWithRetry` does that for you: it mints one key per logical call (or
uses the `idempotencyKey` you pass) and keeps it across every attempt.

```ts
const sent = await callWithRetry(api, 'messages.sendEmail', { profileId, templateId }, { idempotencyKey: 'welcome-ada' });
```

- It retries a **network failure** and the `409 conflict` whose `details.reason` is
  `"idempotency_in_progress"` (the first request is still running after the server's ten-second
  wait). Delays are 250 ms, 1 s, 3 s and 8 s: five attempts, about 12 seconds in total.
- It never retries `"idempotency_key_reused"` (the key belongs to a different command, input or
  caller), any other 4xx, or a 5xx: those are answers, not races.
- A supplied key must be 1–200 printable characters without spaces; anything else throws before a
  request is sent, so an empty key can never silently run twice.

The older `{ idempotencyKey }` call option still works with `call` when you manage retries yourself.
`isIdempotencyInProgress(error)` and `conflictReason(error)` are exported for a custom loop.

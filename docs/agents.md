# Agents: connecting, limiting and granting autonomy

An **agent** is anything that works in this workspace through the MCP server or the REST API. The platform does not care which runtime it is: Hermes, Claude, an IDE assistant, n8n, a Grok-based bot or OpenClaw all use the same commands, permissions and limits. Nothing here depends on a particular product; anything that speaks MCP or HTTP works.

This page is the connection guide: how an agent gets in, what the workspace allows by default, and how a person grants one more autonomy with a **mandate**.

## What an agent is

An agent is a named principal, created the first time one of its credentials is used. Its credentials are an OAuth client (an MCP client) or an API token; several can belong to the same agent. The person who created the token or signed in the client is its **sponsor** — the person accountable for it.

- An agent's permissions are its **sponsor's role** intersected with the **scopes** granted to the credential. It never has more than the person behind it.
- People-only commands (approving, members, secrets, provider and connection setup, importing consent, erasing people) are never available to an agent, whatever its scopes.
- An agent has a status: `active`, `paused` or `revoked`.
- An agent may have a **mandate** (see below). Without one, the workspace's approval policy decides, exactly as before: `agent_changes` means an agent's publish waits for a person.

Every agent write goes through the same command layer as the UI and REST, so the limits on this page are enforced by the server, not by the agent's prompt or skill.

## Connect over MCP

1. Point the client at `https://<your platform>/mcp` (for example `https://am.example.com/mcp`). MCP needs an HTTPS `PUBLIC_URL`; plain loopback HTTP is fine for local development.
2. The client discovers the OAuth endpoints and registers itself. The person signs in and chooses the client's permissions on the **consent screen**. Read-only is the default; encourage the smallest set that does the job.
3. Scopes are the permission strings the commands use: `artifacts:read`, `artifacts:write`, `artifacts:publish`, `artifacts:approve`, `messages:send`, `audit:read`, `profiles:read`, `profiles:pii`, `profiles:write`, `profiles:erase`, `secrets:read`, `secrets:write`, `workspace:admin`. An agent's effective permissions are the sponsor's role intersected with these.
4. If the client calls a tool that the person's role allows but the connection was not granted, the request answers `403` with `insufficient_scope` and a `WWW-Authenticate` header naming the permission. A capable client asks the person to grant it (scope step-up) and retries. A client that cannot step up needs a new consent with the scope.
5. An MCP client without OAuth support can send an API token as `Authorization: Bearer amk_…` to the same `/mcp` endpoint.

```json
{
  "error": "insufficient_scope",
  "message": "This connection needs the artifacts:publish permission. Ask the person to grant it."
}
```

## Connect over REST

Everything an MCP tool does is also `POST /v1/<command>` with a JSON body. A person creates an API token under **Settings → Integrations and API tokens**, choosing its scopes there.

```bash
curl -sS https://am.example.com/v1/agents.get \
  -H 'Authorization: Bearer amk_…' \
  -H 'content-type: application/json' \
  -d '{}'
```

- A token acts as its owner's current role intersected with its scopes. Removing scopes, renaming or shortening the expiry applies at once; adding scopes or extending the expiry needs the owner's password.
- An unknown, revoked or expired token answers `401 invalid_token`. A token that lacks a scope for a tool answers `insufficient_scope`; API tokens cannot step up, so ask the owner to edit the token.
- The command names and JSON schemas are the same as the MCP tools; the MCP skill's `references/tools.md` is the catalogue.

## Client compatibility settings

Two environment variables adapt the MCP surface to clients that are picky about tool names or result text. Both are read at start-up; restart the server after changing them. REST is unaffected.

| Variable | Values | Default | Effect |
|---|---|---|---|
| `MCP_TOOL_NAME_STYLE` | `dotted`, `underscore` | `dotted` | `dotted` lists and accepts `artifacts.list`; `underscore` lists and accepts `artifacts_list`. REST always uses `artifacts.list` at `/v1/artifacts.list`. |
| `MCP_TEXT_CONTENT` | `json`, `summary` | `json` | `json` puts the full command result in the tool result's text block; `summary` puts a one-line summary there (for example `artifacts.list: 12 artifacts`). `structuredContent` always carries the full result. |

## Settings → Agents

**Settings → Agents** lists every agent: name, sponsor, status, credentials and what it did in the last 24 hours (`changes`, `escalated`, `denied`). Open one to see its action ledger and stop controls.

- **Name, describe, re-sponsor** with `agents.update`. The new sponsor must be a member of the workspace. People only.
- **Pause** with `agents.pause` (or the UI). Every credential it holds is refused from the next request, and its pending approvals cannot be approved until it is resumed. Pausing is resumable; the agent keeps its credentials and limits.
- **Resume** with `agents.resume`.
- **Revoke** with `agents.revoke`. Its credentials stop working for good and it cannot be resumed; its history and the content it created stay readable.
- Agents themselves can read the list (`agents.list`) and their own record (`agents.get` with no id), but cannot pause, resume, revoke or re-sponsor anything.

An agent appears the first time a credential acts, with the person who created or connected it as sponsor. Give it a name and a description right away, then attach a mandate if it should do more than propose.

## Hosted agents

A **hosted agent** is an agent the platform runs itself on a schedule, for self-hosters who have no agent runtime to connect. It is an agent like any other: it has a sponsor, a status, a mandate and a ledger, and every tool call passes the same executor, permissions and policy engine. The only difference is who starts the run.

Create one in **Settings → Agents → New hosted agent** (or with `agents.createHosted`). You give it:

- **Instructions** — the prompt for each run: what to look at, what to report, what to propose.
- **A schedule** — one of three forms, read in the workspace's time zone (`workspace.get` shows it):
  - `hourly` — every hour, at minute 0.
  - `daily:07:00` — every day at 07:00.
  - `weekly:mon:07:00` — every Monday at 07:00. Days are `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun`; times are 24-hour `HH:MM`.
- **Scopes** — the permissions a run may use. They are intersected with the sponsor's role, so a hosted agent never has more than the person accountable for it. A tool outside them is not offered, and a call made anyway is refused by the executor.
- **Budgets per run** — a token budget and a tool-call budget. The run stops when either is used up and records a partial summary; a tool call past the tool-call budget never reaches the command layer.
- **A model** (optional) — an AI provider id; without one the workspace's copilot provider is used.

Each run is a **fresh session** on the copilot's in-process MCP client, acting as the agent principal (the sponsor's role ∩ the scopes). There is no carry-over except the instructions; the mandate applies exactly as it does to an external agent, so a write outside its levels waits for a person or is refused, and the decision lands in the agent's activity ledger.

Runs never overlap: a durable claim on the hosted agent is taken before the model is called, and a second sweep records a skipped run instead of starting another. A failed run counts; **three consecutive failures disable the agent** and tell the sponsor by e-mail. The sponsor also receives every run's summary by e-mail.

| Command | Who | What |
|---|---|---|
| `agents.createHosted` | people only (`workspace:admin`) | Create the agent, its schedule, scopes and budgets |
| `agents.updateHosted` | people only (`workspace:admin`) | Change instructions, schedule, scopes, budgets or enabled |
| `agents.runHostedNow` | people only (`workspace:admin`) | Start a run at the scheduler's next tick, without changing the schedule |
| `agents.deleteHosted` | people only (`workspace:admin`) | Delete it and its run history; the ledger stays |
| `agents.hostedRuns` | `artifacts:read` | The hosted agent and its runs (status, summary, tool calls, tokens, error) |

### Starter templates

Both are ordinary hosted agents; edit anything after creating them.

**Weekly report** — `weekly:mon:07:00`, scopes `artifacts:read` and `audit:read`, 30,000 tokens and 25 tool calls per run. It summarises last week's broadcasts, journeys and campaigns with `analytics.query`, `analytics.campaignSummary` and `journeys.stats`, states the data window and recommends at most three next steps. Read-only: it reports, it does not change anything.

**Deliverability guardian** — `hourly`, scopes `artifacts:read`, `audit:read`, `artifacts:write` and `artifacts:publish`, 15,000 tokens and 15 tool calls per run. It reads the 24-hour and 7-day bounce and complaint rates, compares them with the workspace's delivery policy, and when a limit is crossed drafts a note that proposes pausing the marketing stream and calls `artifacts.requestPublish`. That proposal goes through the normal approval and mandate path (a proposal, a hold or a refusal), so the guardian never changes settings or pauses a stream by itself.

```json
{
  "name": "Weekly report",
  "schedule": "weekly:mon:07:00",
  "scopes": ["artifacts:read", "audit:read"],
  "maxTokensPerRun": 30000,
  "maxToolCallsPerRun": 25
}
```

## Undo

Where an agent's action can be reversed, the ledger stores how: the published version it replaced (or, for a first publish, that there was none), and for a broadcast its scheduled send. `agents.undo` with the `actionId` from `agents.activity` runs the reversal in one transaction and marks the entry undone with who did it and the result. It is a **person** command (agents get `403`) and needs `artifacts:publish`: the previous version goes live through the same publish checks and audit as any publish, a broadcast that has not gone out is cancelled, and the first publish of an artifact is taken out of service again. An action is undone at most once. A broadcast whose messages were already sent cannot be recalled; the ledger says so and the command explains it. Journeys and experiences have no pause of their own yet, so undoing their first publish takes the artifact out of service: it stops entering people and stops serving, while participants already in a journey keep going. The agent page in the admin UI shows an **Undo** button on every reversible entry, with a note that is kept in the ledger.

## The workspace's limits

The workspace's limits apply to every agent, with or without a mandate. Read them with `workspace.autonomy`; a person (owner or admin) changes them with `workspace.setAutonomy` or **Settings → Agents → Autonomy**.

| Setting | Default | Meaning |
|---|---|---|
| `switch` | `on` | `on`: agents work as their grants allow. `propose_only`: every change beyond a draft needs a person (levels are capped at 1). `off`: agents can read only; every write is refused. |
| `audienceThreshold` | `1000` | An agent action that reaches more people than this needs a person. Applies to sends and journeys, not to ordinary drafts. |
| `limits.changesPerDay` | `500` | Changes beyond drafts, per agent per 24 hours. |
| `limits.messagesPerDay` | `1000` | Messages an agent may send itself per 24 hours. |
| `maxLevel` | `1` for every class | The highest autonomy level a mandate may grant per action class. Missing classes are 1. |
| `allowLoops` | `false` | Whether any mandate may grant level 4 (run the loop). Level 4 must also be earned per agent and class; see Autonomy levels. |

At run time the engine uses the **lower** of the mandate's level and the workspace ceiling. Raising a ceiling takes effect for existing mandates; lowering one takes effect at once.

To let the weekly newsletter agent send at level 3, a person raises that one ceiling first:

```text
workspace.setAutonomy {"maxLevel":{"send.broadcast":3}}
```

## Mandates

A **mandate** is an `agent_mandate` artifact (prefix `mnd_`): versioned, reviewed and published like a journey. It is the grant a person gives one agent — a purpose, a scope, a level per kind of action, limits, guardrails, working hours and an end date.

Only people can create, change or publish a mandate. An agent that tries gets `403` with "Only people can create, change or publish agent mandates; agents cannot set their own borders."

### Autonomy levels

| Level | Name | What happens |
|---|---|---|
| 0 | **Observe** | Read only. Writes of that class are refused. |
| 1 | **Propose** | Drafts and publish requests; a person approves each publish. This is the default, and the ceiling of a new workspace. |
| 2 | **Act with veto** | The action is queued and announced, and runs after the hold window unless a person vetoes it. |
| 3 | **Act within limits** | Runs at once when it is inside the scope and limits; recorded in the activity ledger. |
| 4 | **Run the loop** | Level 3 plus creating new artifacts of the class: a new artifact of an allowed type is not held to the mandate's `scope.artifacts` list. Audiences, purposes, topics, channels, limits, guardrails, learning rules and the guardian still apply. **Earned**, see below. |

**Earning level 4.** A mandate may grant level 4 for a class only when the workspace allows it (`allowLoops` and a ceiling of 4) and the agent has earned it: it ran that class at level 3 (autonomously, decided by its mandate) for at least 28 days with no guardian episode in that time and no guardian cap in force, or its mandate recorded the class in shadow mode for 28 days without a would-have-run decision that a person rejected. Publishing a mandate that grants level 4 without that record is refused with what is missing. A class in shadow may record level 4 at any time; that is how the record is built. A guardian cap lowers level 4 like any other level.

A class that is not listed in `levels` counts as 1. Two classes can never be made autonomous, whatever the mandate says: `settings` and `destructive` always need a person, as do changes to purposes, the delivery policy, the tracking plan, a conversion map and the mandate itself. Above one of the mandate's limits an action drops one level: an L3 send becomes an L2 hold, an L2 action a proposal, with the reason. Anything outside the mandate's scope (another audience, purpose, topic, channel or artifact type) is only ever proposed.

### Scope, limits and guardrails

- **Scope.** `segments` are the audiences it may address (empty means none), `purposes` and `topics` what its messages may use (empty means any the audience allows), `channels` defaults to `["email"]`, `artifactTypes` and `artifacts` what it may change (empty means any within the levels), and `brand` is reserved for multi-brand.
- **Limits.** `recipientsPerSend`, `recipientGrowth` (a send may reach at most this multiple of the agent's previous send, for example `1.2`), `sendsPerDay`, `changesPerDay` and `messagesPerDay`. These are counters the platform keeps, not numbers the agent reports.
- **Guardrails.** `unsubscribeRate`, `complaintRate` and `bounceRate` are fractions (`0.005` is 0.5%), judged over `window` (`P7D`, `P14D` or `P30D`) once the agent's sends reached `minSent` people. Before a send, the platform checks the agent's own recent sends; a breach caps the action at propose.
- **Escalation.** `escalation.userIds` names who, besides the sponsor, is told about holds, refusals and guardrail hits.

### Working hours and holds

`workingHours` is `start`/`end` in `HH:MM`, in the workspace's time zone, with optional `days`. Outside those hours an irreversible action (a send, a direct message, spend) is not run at once; it is capped at level 2 and held. `blackoutDates` (`YYYY-MM-DD`) do the same for named days.

A level-2 action becomes a **hold**: a scheduled execution with a deadline (`runsAt`), shown in the approvals inbox with the agent's intent, the diff, the impact and a countdown. A person can approve early or veto it. When the hold window (`holdWindow`, one of `PT30M`, `PT1H`, `PT2H` (default), `PT4H`, `PT12H`, `PT24H`) ends without a veto, the action is re-checked (the agent still exists, is active, is not paused, the workspace switch is still `on`, the mandate still applies) and then runs. A hold whose agent is paused becomes an ordinary approval a person must decide.

### The independent check

Set `independentCheck: true` to have a second model review each level-2+ action before it runs: given the intent, the impact, the mandate and what the action would make live, does it match? For a publish that is the version's content (secrets scrubbed, capped at 20,000 characters) and its diff against the version that is live now; for a direct send it is the template's purpose, subject, MJML and text. A mismatch, an error or a missing AI provider sends the action to a person (it fails closed). It is off by default and costs tokens; turn it on for any agent that reads content from outside the workspace.

### Learning rules

`learning` keeps what an agent publishes measurable. `journeyControlPercent` requires its journeys to hold out at least that share of entrants (`controlGroup.percent`, or the control group of the campaign the journey belongs to); `broadcastHoldout: true` requires its broadcasts to have a holdout (their campaign's control group) or a subject test; `experienceHoldoutPercent` requires its experiences to hold out at least that share of visitors (`holdoutPercent`). A change without the required holdout is not refused: it goes to a person, with the reason, whatever the level. A member published in one bundle with its campaign counts the campaign's control group.

### Shadow mode

Set `shadow: true` (or a list of action classes, e.g. `["send.broadcast"]`) to try a mandate before trusting it. For those classes the policy engine works out what the mandate would decide, at the levels it grants even above the workspace ceiling, and records it in the ledger as `shadow`; the action itself is decided as if there were no mandate, so the approval policy and the people reviewing work exactly as before. `agents.shadowReport` (and the **Shadow mode** card on the agent page) compares the two over the last 30 days:

| Result | Meaning |
|---|---|
| `agree` | It would have run and a person approved, or it would have asked and a person rejected. |
| `too_bold` | It would have run (or been held), but a person rejected the change. |
| `too_cautious` | It would have asked, but a person approved. |
| `pending` / `unreviewed` | No decision yet / the approval policy let it run without a person. |

A high agreement rate with no `too_bold` changes over a few weeks is the evidence for raising the ceiling and publishing the mandate without `shadow`. Drafts are never recorded in shadow.

## Reports

`agents.report` (and the **Last 30 days** card on the agent page) shows what an agent did and what it led to in a period (default the last 30 days, `from`/`to` for any other): its actions by class and decision (ran, held, sent to a person, refused, failed), undos and guardian episodes, the outcome of the broadcasts it published and the direct messages it sent (sent, opens, clicks, unsubscribes, complaints, bounces), the journeys it published against their control groups, and its mandate's `goals` measured on its own broadcasts (value, and whether the target was met). An agent can read its own report by omitting `agentId`. Use it to review an agent and when you renew its mandate.

## Learnings

A **learning** is a conclusion with its evidence, not a memory dump: "subject lines with a number win for this audience: 3 of 4 tests, +2.1 pts". Each one has a statement, an optional scope (audience segment ids, channel, topic and purpose), the experiments behind it and its author. People and agents write them; agents read the active ones before they draft, and only people can retract one.

- `learnings.list` reads them, newest first, filtered by `status` (`active` by default, `retracted` or `all`), `segmentId`, `channel`, `topic` and `purpose`.
- `learnings.add` records one. Evidence is required, and every item names its kind (`subject_test`, `journey_holdout`, `campaign_holdout` or `experience`), the id of the broadcast, journey, campaign or experience it came from, a one-line summary and the measured numbers. An agent's evidence must reference something that exists in the workspace, so a guessed or remembered id is refused. Adding is `draft`-level: it never needs autonomy.
- `learnings.retract` is people-only and needs a `reason`. The row stays in the record with `status: "retracted"`, who retracted it and when, and it is no longer served as current.

Agents read the active learnings as the MCP resource `learnings://current` (the same JSON as `learnings.list` with the default filters). The server's agent instructions tell them to check it before drafting and to record what a result taught them. When a result no longer holds, retract the learning instead of adding a contradicting one without evidence.

## The guardian

A scheduler job (every five minutes) watches every active agent with a mandate, without a person, and acts by itself when something looks wrong:

| Check | Triggers when | Action |
|---|---|---|
| Guardrails | The mandate's unsubscribe, complaint or bounce rate on the agent's own sends is over its limit (the same check as before each send, run continuously because rates arrive after a send). | Cap: every change waits for a person. |
| Anomaly: send size | A send reaches more than 3× the median of the agent's previous sends (after at least 3). | Hold: sends and other irreversible actions are held for a veto window at most. |
| Anomaly: burst | 30 or more changes in an hour. | Cap: every change waits for a person. |
| Rising errors | 5 or more failed actions in an hour, at least half of its actions. | Cap. |
| Probing | 10 or more refusals in an hour. | Pause the agent. |
| Loop | The same artifact changed 6 or more times in an hour. | Pause the agent. |

Each time it acts the guardian records an **episode** with its evidence, turns the agent's pending holds into ordinary approvals (nothing it asked for runs by itself any more), and e-mails the sponsor and the mandate's escalation targets. The cap stays on the agent, on top of its mandate and the workspace ceilings, until a person reviews the episodes and clears it on the agent page or with `agents.clearGuard` (a note is required); a paused agent is resumed separately with `agents.resume`. `agents.guardian` lists the episodes and the cap in force. Each kind fires once until it is cleared, and after clearing only new activity counts.

### Expiry and renewal

`validUntil` is required, must be in the future and may be at most a year away; 30 days is a good default. After it passes the mandate stops applying and the agent falls back to the approval policy. Renewal is a person's decision: update the same mandate artifact with a new version (`artifacts.updateDraft`) and publish it, with the agent's activity and results in front of you. An agent can have only one active mandate; a second one is refused until the first is archived or expires.

## What an agent sees when it is held or refused

The decision is part of the response, so an agent can learn the border instead of guessing.

**Held for a veto window** (`on_hold`):

```json
{
  "status": "on_hold",
  "version": 4,
  "runsAt": "2026-10-30T09:00:00.000Z",
  "approvalId": "apr_0123456789abcdef0123456789abcdef",
  "reviewUrl": "https://am.example.com/approvals/apr_0123456789abcdef0123456789abcdef",
  "heldBecause": ["This reaches 4,812 people; the mandate allows 4,000 per send."],
  "next": "Held: it publishes at 2026-10-30T09:00:00.000Z unless a person rejects it (https://am.example.com/approvals/apr_…). Check the result with artifacts.get."
}
```

**Waiting for a person** (`in_review`): the same `heldBecause` array explains why the policy did not let it through; `reviewUrl` is where the person decides.

**Refused** (`403`): the action did not run, and `details.reasons` says why.

```json
{
  "error": "forbidden",
  "message": "It is 20:14 in Europe/Berlin; the mandate allows sends between 07:00 and 11:00. messages.sendEmail cannot be held for a veto window; level 3 is needed to run it, or a person can.",
  "details": {
    "decision": "deny",
    "actionClass": "send.direct",
    "reasons": [
      "It is 20:14 in Europe/Berlin; the mandate allows sends between 07:00 and 11:00.",
      "messages.sendEmail cannot be held for a veto window; level 3 is needed to run it, or a person can."
    ]
  }
}
```

A paused agent answers `403` with `This agent (<name>) is paused: <reason>. A person can resume it in Settings → Agents.` and no policy details.

`agents.get` with no id gives the agent its own status and `last24h` counts; `agents.activity` (needs `audit:read`) shows every write with its decision, reasons, intent and impact. `workspace.autonomy` gives the switch, threshold, daily limits and ceilings.

## Events

A loop should react instead of polling. An agent subscribes to the event types its loop cares about, and the scheduler (every five minutes) derives each event from what the platform already records and delivers it.

| Event | Emitted when | Subject ids |
|---|---|---|
| `hold.ran` | A held change's veto window ended without a veto (the hold runner published it). | `approvalId`, `artifactId`, `version` |
| `hold.vetoed` | A person rejected a held change before its window ended. | `approvalId`, `artifactId`, `version` |
| `hold.needs_person` | A held change could not run at recheck (the mandate changed, working hours, the guardian) and now waits for a person. | `actionId`, `command`, `actionClass`, `target` |
| `approval.decided` | A person approved, rejected or withdrew an agent's request. | `approvalId`, `artifactId`, `version`, `decision` |
| `guardian.episode` | The guardian capped, held or paused the agent. | `episodeId`, `kind`, `action`, `suspendedHolds` |
| `guardrail.breach` | The guardian found the mandate's unsubscribe, complaint or bounce guardrail over its limit. | `episodeId`, `kind`, `action`, `suspendedHolds` |
| `experiment.significant` | A subject test's winner was decided (a tie or too little data is not significant). | `broadcastId`, `winner`, `metric` |
| `alert.fired` | A threshold alert opened a firing episode. | `alertId`, `ruleId`, `value`, `threshold`, `window` |

Journey and campaign holdout verdicts are computed on demand by `journeys.holdoutResult` and `campaigns.holdoutResult` rather than stored, so they are not events; an agent reads them with those commands. A subject test's verdict is stored by the broadcast runner, so it is emitted.

Each event carries its type, a time, a short summary and subject ids — never personal data (no addresses, traits or profile ids).

```json
// agents.subscribe (an agent subscribes itself; a person passes agentId)
{ "eventTypes": ["hold.vetoed", "approval.decided"], "webhookId": "whk_…" }
```

- **`agents.subscribe`** — event types, an optional `filter` on subject ids (e.g. `{"artifactId": "bc_…"}`) and an optional `webhookId`. Without a webhook the events are recorded for `agents.events`.
- **`agents.unsubscribe`** — delete a subscription by id; recorded events stay readable, new ones stop.
- **`agents.subscriptions`** — an agent's subscriptions (a person may list one agent's or the workspace's).
- **`agents.events`** — the polling fallback: events for the agent since a cursor (`after`), oldest first, returning the next `cursor`. Pass the last id back next time.

An agent can only manage its own subscriptions; a person can subscribe any agent in the workspace. Subscription writes are low-risk (`draft`), so an agent can set them up without a person even under propose-only.

**Delivery.** A subscription with a `webhookId` gets each event as a Standard Webhooks signed `POST` (`type: "agent.event"`, signature headers `webhook-id`, `webhook-timestamp`, `webhook-signature`) through the same worker as customer webhooks: retried with backoff and dead-lettered if it keeps failing; `deliveries.list` shows the outcome. The payload holds the event's id, type, time, summary and subject only.

**MCP notifications.** The MCP server is stateless (one server per request, spec 2026-07-28), so it has no connected client to push a server-initiated notification to. MCP clients use `agents.events` with the `cursor` from the previous call; the same subscription decides what appears there.

## Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| `403` with "This agent (…) is paused: …" | The agent's status is `paused`. | Ask the sponsor to resume it in **Settings → Agents**. |
| `403` with `details.decision: "deny"` | The policy refused the call before it ran. `details.reasons` names the border: switch `off`, propose-only, level 0, outside the scope, over a limit, or a command that cannot wait for a person. | Change the plan to fit the reason, or ask a person. Retrying does not help. |
| `403` with "insufficient_scope" | The connection lacks the scope for that tool. | OAuth: let the client ask for the scope. API token: the owner edits the token. |
| `in_review` with `heldBecause` | The change is waiting for a person's approval. | Pass `reviewUrl` on with a one-line summary; do not resubmit. |
| `on_hold` with `runsAt` | It will run at `runsAt` unless a person vetoes it. | Do not resubmit; a second request creates another version. |
| `403` with "agents cannot set their own borders" | Agents may not create, change or publish mandates. | Ask the sponsor to change the mandate. |

## Mandate templates by role

These are `content` objects for an `agent_mandate` artifact. Replace the example ids with real ones (`agents.list` gives agent ids, `artifacts.list {"type":"segment"}` gives segment ids). A person creates the artifact, then publishes it:

```text
artifacts.create {"type":"agent_mandate","name":"Weekly newsletter","content":{ … }}
artifacts.requestPublish {"artifactId":"mnd_…","note":"Grant the weekly newsletter loop"}
```

Before any of them can be published, the workspace ceilings must allow the levels: the default is 1 for every class. Raise only what the role needs, with `workspace.setAutonomy` (owner or admin), then publish the mandate. Publishing checks that the agent exists and is not revoked, that every level fits its ceiling, that `validUntil` is in the future and at most a year away, and that the agent has no other active mandate.

### Newsletter agent

The pilot: one segment, one topic, one weekly broadcast at level 3, everything else level 1. The growth limit means each send may reach at most 1.2× the previous one; the guardrails cap a send at propose when its own unsubscribes pass 0.5% or complaints 0.1%. Sends are allowed on Tuesdays between 07:00 and 11:00 in the workspace's time zone; at other times they become holds.

```json
{
  "agent": "agt_4f8c2d1e6b9a4c7d8e0f1a2b3c4d5e6f",
  "purpose": "Write and send the weekly newsletter to the newsletter segment, on the newsletter topic, and report the result.",
  "goals": [
    { "measure": "email.click_rate", "target": 6, "direction": "up" },
    { "measure": "email.unsubscribe_rate", "target": 0.004, "direction": "down" }
  ],
  "scope": {
    "segments": ["seg_0123456789abcdef0123456789abcdef"],
    "purposes": ["marketing_email"],
    "topics": ["newsletter"],
    "channels": ["email"],
    "artifactTypes": [],
    "artifacts": [],
    "brand": null
  },
  "levels": {
    "draft": 1,
    "content.publish": 1,
    "audience.publish": 1,
    "send.broadcast": 3,
    "send.direct": 1,
    "journey.live": 1,
    "experience.live": 1,
    "spend": 1,
    "data.write": 1,
    "settings": 1,
    "destructive": 1
  },
  "limits": { "recipientGrowth": 1.2 },
  "learning": { "broadcastHoldout": true },
  "guardrails": { "unsubscribeRate": 0.005, "complaintRate": 0.001, "window": "P7D", "minSent": 100 },
  "validUntil": "2026-11-27T07:00:00Z",
  "workingHours": { "start": "07:00", "end": "11:00", "days": ["tue"] },
  "blackoutDates": [],
  "holdWindow": "PT2H",
  "escalation": { "userIds": [] },
  "independentCheck": false
}
```

As a **programme** (#316) the agent works from the article library (content sources and selections) and the topic backlog (approved briefs), sends each issue with a subject test (the `learning` rule requires a test or a holdout) and a staged send, and records what the test taught as a learning. The hosted-agent template **Newsletter editor** runs the loop every Monday; the recipe is in the MCP skill (`references/recipes.md`).

A bundle is judged by its riskiest member. Publishing this issue's template and broadcast together (`artifacts.requestPublishBundle`) counts as `send.broadcast` at level 3; the template on its own is still `content.publish` level 1 and waits for a person.

### Lifecycle optimiser

A programme (#313): the agent reads each journey's splits with `journeys.splitResult`, promotes winning arms and retires losing ones by publishing a new journey version, proposes the next variant, and records learnings. Its journeys must keep a control group (`learning`), it may only touch the journeys in its scope, and a journey publish is at most level 3 (level 4, earned, would let it create new journeys too). The hosted-agent template **Lifecycle optimiser** runs it weekly; the recipe is in the MCP skill (`references/recipes.md`).

```json
{
  "agent": "agt_4f8c2d1e6b9a4c7d8e0f1a2b3c4d5e6f",
  "purpose": "Improve the onboarding journeys with variants against their control groups, promote winners and retire losers.",
  "goals": [{ "measure": "journey.goal_reached", "target": 100, "direction": "up" }],
  "scope": {
    "segments": ["seg_0123456789abcdef0123456789abcdef"],
    "purposes": ["onboarding"],
    "topics": [],
    "channels": ["email"],
    "artifactTypes": ["journey", "email_template"],
    "artifacts": ["jny_0123456789abcdef0123456789abcdef"],
    "brand": null
  },
  "levels": { "content.publish": 3, "journey.live": 3 },
  "limits": { "changesPerDay": 10 },
  "learning": { "journeyControlPercent": 10 },
  "guardrails": { "unsubscribeRate": 0.005, "complaintRate": 0.001, "window": "P7D", "minSent": 200 },
  "validUntil": "2026-11-27T07:00:00Z",
  "holdWindow": "PT4H",
  "escalation": { "userIds": [] },
  "independentCheck": true
}
```

### Deliverability guardian

Watches bounces, complaints and provider signals; it never sends. Its levels are 0 (observe) except `data.write` at 1: a write is refused with the reason unless it can wait for a person's approval. The hosted deliverability guardian (above) proposes a pause and a person still pauses the stream in the UI or with a command.

```json
{
  "agent": "agt_9b7e5d3c1a0f2e4d6c8b0a9f7e5d3c1b",
  "purpose": "Watch deliverability, explain what changed, and propose fixes; never send.",
  "goals": [
    { "measure": "email.bounce_rate", "target": 0.02, "direction": "down" },
    { "measure": "email.complaint_rate", "target": 0.001, "direction": "down" }
  ],
  "scope": {
    "segments": [],
    "purposes": [],
    "topics": [],
    "channels": ["email"],
    "artifactTypes": [],
    "artifacts": [],
    "brand": null
  },
  "levels": {
    "draft": 0,
    "content.publish": 0,
    "audience.publish": 0,
    "send.broadcast": 0,
    "send.direct": 0,
    "journey.live": 0,
    "experience.live": 0,
    "spend": 0,
    "data.write": 1,
    "settings": 0,
    "destructive": 0
  },
  "limits": { "changesPerDay": 20 },
  "guardrails": { "window": "P7D", "minSent": 100 },
  "validUntil": "2026-11-27T07:00:00Z",
  "blackoutDates": [],
  "holdWindow": "PT2H",
  "escalation": { "userIds": [] },
  "independentCheck": false
}
```

### Reporting agent

Reads and reports; it can draft a note or a suggested change but publishes nothing. Levels are 0 except `draft` at 1. Reads (`analytics.query`, `agents.get`, `workspace.autonomy`) are not governed by levels and need no grant.

```json
{
  "agent": "agt_2a4c6e8f0b1d3f5a7c9e1b3d5f7a9c0e",
  "purpose": "Report the week: sends, opens, clicks, unsubscribes and journey funnels, with the numbers a person can check.",
  "goals": [
    { "measure": "email.click_rate", "target": 6, "direction": "up" }
  ],
  "scope": {
    "segments": [],
    "purposes": [],
    "topics": [],
    "channels": ["email"],
    "artifactTypes": [],
    "artifacts": [],
    "brand": null
  },
  "levels": {
    "draft": 1,
    "content.publish": 0,
    "audience.publish": 0,
    "send.broadcast": 0,
    "send.direct": 0,
    "journey.live": 0,
    "experience.live": 0,
    "spend": 0,
    "data.write": 0,
    "settings": 0,
    "destructive": 0
  },
  "limits": {},
  "guardrails": { "window": "P7D", "minSent": 100 },
  "validUntil": "2026-11-27T07:00:00Z",
  "blackoutDates": [],
  "holdWindow": "PT2H",
  "escalation": { "userIds": [] },
  "independentCheck": false
}
```

### Campaign drafter

Builds campaign bundles — a segment, a template, a broadcast or journey and a campaign — and proposes them: every publishing class is level 1, so each publish is a person's decision. Spend, data writes, settings and destructive actions are level 0.

```json
{
  "agent": "agt_c0ffee1234567890abcdef1234567890",
  "purpose": "Turn a brief into a campaign bundle (audience, content, broadcast or journey, campaign and holdout) and propose it.",
  "goals": [
    { "measure": "campaign.conversion_rate", "target": 2, "direction": "up" }
  ],
  "scope": {
    "segments": [],
    "purposes": ["marketing_email"],
    "topics": [],
    "channels": ["email"],
    "artifactTypes": ["email_template", "segment", "broadcast", "journey", "campaign"],
    "artifacts": [],
    "brand": null
  },
  "levels": {
    "draft": 1,
    "content.publish": 1,
    "audience.publish": 1,
    "send.broadcast": 1,
    "send.direct": 1,
    "journey.live": 1,
    "experience.live": 1,
    "spend": 0,
    "data.write": 0,
    "settings": 0,
    "destructive": 0
  },
  "limits": { "changesPerDay": 100 },
  "guardrails": { "window": "P7D", "minSent": 100 },
  "validUntil": "2026-11-27T07:00:00Z",
  "blackoutDates": [],
  "holdWindow": "PT2H",
  "escalation": { "userIds": [] },
  "independentCheck": false
}
```

Republish a template with a person's approval, not with the campaign drafter: at level 1 every `artifacts.requestPublish` it makes is a proposal, and `artifacts.requestPublishBundle` keeps a bundle under one review.

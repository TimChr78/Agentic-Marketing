---
name: agentic-marketing-mcp
description: Operate an Agentic Marketing workspace through its MCP server (or the identical REST commands). Covers connecting with OAuth or an API token, the draft → validate/simulate → request-publish workflow, segments, e-mail templates, broadcasts (newsletters), journeys, signup forms, web experiences, AI prompts, webhooks and reporting, within consent and approval guardrails. Use when an agent should build or run marketing in the platform, e.g. drafting the weekly newsletter, creating a segment or journey, or reporting results.
---

# Using the Agentic Marketing MCP server

Every capability is a **command**, and every command is an MCP tool with the same name (`segments.preview`, `artifacts.create`…). It is also available as `POST /v1/<command>` over REST. The input and output JSON schemas are in each tool's definition. Errors are written to be fixed: read the message, correct the input, retry.

## Connect

- **Interactive agents** (Claude, IDEs): add the server URL `https://<platform>/mcp`. The client discovers OAuth. The person signs in and chooses which permissions (scopes) to grant; read-only is the default.
- **Scripts and automation** (cron agents, n8n): a person creates an API token in the UI (Settings → Integrations and API tokens) with the scopes needed. Send it as `Authorization: Bearer amk_…` to `/mcp` or `/v1/<command>`.

You act as an **agent principal**: the person's role permissions, limited to the granted scopes. Some tools are never available to agents, whatever the scopes:
- approving;
- managing members, providers, sources, connections and webhooks;
- secrets;
- importing consent, exporting or erasing people.

Ask a person to do those in the UI.

Tools marked "Needs the … permission" are allowed by the person's role but were not granted to this connection. Calling one answers `insufficient_scope`; your MCP client then asks the person to grant that permission (scope step-up). Tell the person why you need it. API tokens cannot step up: ask for a token with the right scopes instead.

## The workflow for any change

1. **Look first.**
   - `artifacts.types` gives the content schema of every type; read it before writing content.
   - `artifacts.list` (filter by `type`) and `artifacts.get` show what exists.
   - `purposes.list` shows the lawful bases, and the MCP resources `learnings://current` and `business-context://current` show what the workspace already learned and what it sells and to whom. Read both before drafting.
2. **Draft.** `artifacts.create {type, name, content}` makes version 1 as a draft. `artifacts.updateDraft {artifactId, content}` changes it. Content is validated on every save (MJML compiles, references are well formed, journeys have one trigger…).
3. **Check:**
   - templates: `templates.preview {artifactId, profileId?}` renders HTML and text;
   - segments: `segments.preview {condition}` or `{artifactId}` gives a count and sample;
   - journeys: `journeys.simulate {artifactId, profileId?, events?, ai?, actions?}`;
   - broadcasts: `broadcasts.preview {artifactId}` gives the audience, would-send count and skip reasons;
   - prompts: `prompts.test {artifactId}` queues the test cases; read the results with `prompts.testRun {runId}` until `status` is `done`.
4. **Submit for review.** `artifacts.requestPublish {artifactId, note}`. Under the usual policy ("agent changes need a person") this creates an approval request. The result has `reviewUrl` (the request in the admin UI, where the person sees the rendered e-mail, form, journey, segment or broadcast) and `next` (what happens now): pass the link on with a one-line summary. The note shows to the reviewer. Publishing also runs publish checks, e.g. that referenced templates and segments are published. When an artifact refers to another draft (a broadcast and this week's template, a form and its confirmation e-mail), submit them together with `artifacts.requestPublishBundle {artifactIds, note}`: one review, one approval, published in dependency order.
5. **Report.** Give the ids you created and the results of your checks (counts, simulation outcome). Do not claim something was sent or published until `artifacts.get` shows `publishedVersion` or `broadcasts.status` says so.

## Guardrails (built in, do not try to work around them)

- **The send gateway decides every e-mail.** It checks the purpose's lawful basis and consent per person, suppressions and unsubscribes. "Skipped: no_lawful_basis" is correct behaviour, not a bug to fix.
- **Agents cannot record a consent**; they can only record restrictions (`consent.record` with `denied`, `withdrawn` or `objected`). Consent comes from forms, double opt-in, the SDK or a person's import.
- **Personal data is masked.** Agents see only traits the tracking plan marks `agentVisible`, and only with `profiles:pii`.
- **Writes are drafts.** Nothing reaches customers until a person approves, when the policy requires it.
- **The agent policy.** Every write is checked against the workspace's autonomy settings (`workspace.autonomy`). A publish answers `published` when it went live, `on_hold` with `runsAt` when a veto window is running (do not resubmit), `in_review` with `heldBecause` and `reviewUrl` when a person decides, or `403` with `details.reasons` when it is refused. A publish that reaches more people than the audience threshold (1,000 by default), or that comes after your daily change limit, goes to a person even when the approval policy would publish it. An action that cannot wait for a person (a direct send, `journeys.enroll`, a bulk `journeys.enrollSegment` above the threshold, `segments.refresh` while the workspace is propose-only) is refused with the reason. Plan within the limits: read `workspace.autonomy` and `agents.get` (your counts for the last 24 hours) first. With the switch `off` you can only read; when you are paused, every call is refused with the reason, so ask the person.

## Working under a mandate

Your sponsor may have granted you a mandate: a level per action class (0 observe, 1 propose, 2 act with veto, 3 act within limits, 4 run the loop), a scope, limits, guardrails, working hours and an end date. Read your borders before a change:

- `workspace.autonomy` — the switch (`on`, `propose_only`, `off`), the audience threshold, the daily limits and the highest level a mandate may grant per class.
- `agents.get` with no id — your own record: status, `last24h` counts (`changes`, `escalated`, `denied`) and id. `agents.activity` (with `audit:read`) shows the ledger with the reasons for each decision; `agents.report` shows what your actions led to and your mandate's goals.
- `learnings.list` or `learnings://current` — what the workspace already learned; `business-context://current` — the brief you write from.
- `agents.subscriptions` and `agents.events` — the events your loop reacts to. Subscribe with `agents.subscribe` instead of polling; pass the last event id back as `after`, or attach a webhook.

What a result can say:

- `published` — it went live. Read it back with `artifacts.get` or the relevant status command.
- `on_hold` with `runsAt` — a level-2 action: it runs at that time unless a person vetoes it. Do not resubmit.
- `in_review` with `heldBecause` — it waits for a person; `reviewUrl` is where they decide. Pass the link on with a one-line summary.
- `403` with `details.reasons` — refused before it ran. Fix the plan to fit the reason (scope, limit, level 0, propose-only, switch off) or ask a person; retrying does not help.

**Level 4 is earned, not granted on request.** It needs a workspace that allows loops (ceiling 4) and 28 days of the class at level 3 without a guardian episode, or 28 days in shadow without a rejected would-have-run decision. The ledger records the level the policy engine decided, and only entries from 0.6.1 at level 3 or above count; earning restarted in 0.6.1. At level 4 a new artifact of an allowed type is not held to the `scope.artifacts` list, but only when its first version was drafted by your own credential.

State your intent in the `note` of `artifacts.requestPublish` and `artifacts.requestPublishBundle`: it is stored as the action's intent and shown to the reviewer and in the ledger. Never try to create, change or publish a mandate — only people can, and an agent cannot widen its own scope, levels or limits. If a border blocks work you believe is right, ask your sponsor to change the mandate.

## Tool catalog (by area)

Read [references/tools.md](references/tools.md) for the full list with effects and who may call each tool. The ones used most:

| Area | Tools |
|---|---|
| Artifacts | `artifacts.types`, `.list`, `.get`, `.create`, `.updateDraft`, `.history`, `.diff`, `.requestPublish`, `.requestPublishBundle`; `approvals.list`, `approvals.get` |
| Agents | `agents.get`, `.list`, `.activity`, `.report`, `.shadowReport`, `.guardian`, `.subscriptions`, `.subscribe`, `.unsubscribe`, `.events`; hosted agents with `.createHosted`, `.updateHosted`, `.runHostedNow`, `.hostedRuns`, `.deleteHosted`; `.pause`, `.resume`, `.revoke` and `.undo` are people only |
| Learnings | `learnings.list` (filter by status, segment, channel, topic and purpose), `learnings.add` with evidence; there is no delete, and only people may `learnings.retract` |
| Content | `content.sources.list` (adding or changing a source is people only), `content.items.list` (score and explanation), `content.selections.create`, `.get`, `.list`; a selection stays a draft, there is no approve command yet |
| Editorial | `content.topics.list`, `.create`, `.update`, `.score`, `.toBrief` (archive is people only); `toBrief` creates a `content_brief` (`brf_…`) artifact |
| Recipes | `recipes.list`, `.get`, `.preview`, `.install`; an install creates version 1 drafts and never publishes |
| Analytics | `analytics.query` (measures × up to three dimensions), `analytics.emailPerformance`, `analytics.journeyFunnel`, `analytics.campaignSummary`, `analytics.metrics.list` (the catalogue) |
| Campaigns | `campaigns.plan` (an approved brief → deterministic draft plan), `campaigns.fromBrief` (create the plan's drafts), `campaigns.of`, `campaigns.members`, `campaigns.archive`, `campaigns.holdoutResult`; campaigns are `campaign` artifacts grouping broadcasts, journeys, templates, experiences, forms and segments, built from a `campaign_brief` a person approves |
| Alerts | `alerts.list`, `.get`, `.create`, `.update`, `.delete`, `.test`, `.history` |
| Blocks | `blocks.preview`, `blocks.usage`; `templates.check` before publishing an e-mail |
| Topics | `topics.preferences` (a person’s choices), `topics.set` (agents may only unsubscribe); topics live under a purpose |
| Audiences | `audiences.add`, `.remove`, `.import`, `.imports`, `.snapshot`, `.refreshSnapshot` for static, CSV and snapshot segments |
| Assets | `assets.upload` (base64, PNG/JPEG/GIF/WebP/SVG/PDF; an SVG is sanitised and returns a `rendition` PNG for e-mail), `.list`, `.get`, `.update` (alt text), `.delete`; use the returned `url` in templates and the brand |
| Brand | artifact type `brand` (one per workspace); `hostedPages.preview` renders the confirm/unsubscribe pages with a draft brand |
| People | `profiles.find {type:"email", value}`, `profiles.get`, `profiles.events`, `profiles.list`, `consent.history`, `segments.ofProfile` |
| Segments | `segments.preview`, `segments.members`, `segments.refresh` |
| E-mail | `templates.preview`, `templates.sendTest`, `messages.list`, `messages.stats`; `messages.sendEmail` (needs `messages:send`) |
| SMS | `smsTemplates.preview` (segments, cost); `messages.sendSms` (needs `messages:send`) |
| Deliverability | `deliverability.health`, `emailProviders.checkDomain` |
| Ads | `ads.performance` (cost, conversions, CPA, ROAS per campaign), `ads.audiences`, `ads.conversions`, `ads.importSpend`, `ads.syncAudience`, `ads.test`; rules are the `conversion_map` and `audience_sync` artifacts (draft them, a person publishes) |
| Newsletter | `broadcasts.preview`, `broadcasts.sendTest`, `broadcasts.status`, `broadcasts.cancel`; `workspace.setSeedList` (admin) |
| Journeys | `journeys.simulate`, `journeys.stats`, `journeys.holdoutResult`, `journeys.splitResult` (each arm against the first, with lift and a verdict), `journeys.enroll` (needs `messages:send`), `journeys.enrollSegment` (bulk, chunks of 500; `journeys.enrollmentJob(s)`, `journeys.cancelEnrollment`), `journeys.migrate` (move people to the published version; dry run first) |
| Web | `experiences.results` |
| AI | `prompts.test` + `prompts.testRun`, `ai.calls`, `ai.usage`, `aiProviders.list` |
| Integrations | `connectors.list`, `connections.list` (shows OAuth status), `connections.runAction`, `webhooks.list`, `deliveries.list`; `connections.authorize` is for people only |
| Workspace | `workspace.get`, `purposes.list`, `audit.list` |

## Recipes

Worked examples with full payloads are in [references/recipes.md](references/recipes.md):
- installing a starter recipe as drafts (`recipes.list/get/preview/install`: welcome and double opt-in, lead-magnet drip, weekly newsletter, win-back; see [docs/recipes.md](../../../docs/recipes.md));
- the four programme loops: the newsletter editor (content library and an approved topic brief → issue with a subject test or staged send → report and learning), the lifecycle optimiser (`journeys.splitResult` → promote or retire an arm → learning), the experimentation agent (`experiences.results` → promote, remove, learn) and the audience curator (sizes, overlaps and sunset policies as drafts);
- the weekly newsletter (template + broadcast, scheduled for Friday);
- a segment of engaged readers;
- a welcome journey after double opt-in;
- a signup form with double opt-in;
- an AI-chosen branch with a tested prompt;
- a campaign with a control group;
- a campaign from a goal and an approved brief (brief → approval → plan → drafts → bundle → evaluate);
- a weekly issue built from reusable blocks and published as a bundle;
- topics, the preference centre and the archive;
- a subject test and a recipient-local send window;
- a static or CSV audience;
- a journey wait and business entry keys;
- reporting the week with the analytics layer.

## Content rules that save round trips

- **Ids** look like `not_` (note), `jrn_` (journey), `blk_` (e-mail block), `eml_` (e-mail template), `sms_` (SMS template), `psh_` (push template), `seg_` (segment), `exp_` (web experience), `prm_` (AI prompt), `frm_` (signup form), `brd_` (brand), `bct_` (broadcast), `cmp_` (campaign), `cpb_` (campaign brief), `brf_` (content brief), `tpl_` (tracking plan), `pur_` (purposes), `cvm_` (conversion map), `aud_` (audience sync), `dlp_` (delivery policy), `mnd_` (agent mandate), `bcx_` (business context), each followed by 32 hex characters. Assets are `ast_`, people `prf_`, content topics `ctp_`, content selections `csel_`, content sources `csrc_` and learnings `lrn_`.
- **Durations** are ISO 8601: `PT6H`, `P2D`, `P1W`. **Timestamps** are ISO in UTC: `2026-10-30T07:00:00Z`.
- **E-mail templates:** MJML with Liquid.
  - Variables: `{{ profile.firstName | default: "there" }}`, `{{ content.<slot> }}` (AI-generated text), and journey context.
  - Use `{{ unsubscribe_url | raw }}` in marketing footers and `{{ confirm_url | raw }}` in double opt-in confirmations.
  - Template purposes: `marketing_email` for newsletters, `onboarding` for transactional or confirmation mail.
- **SMS templates:** plain text with Liquid; purposes `marketing_sms` (needs consent) or `service_sms`. Check `smsTemplates.preview` for segments and cost before publishing.
- **Campaign briefs:** a `campaign_brief` (`cpb_…`) is the contract for one campaign: objective, measurable goal, audience and segment refs, message, offer, channels, schedule, guardrails, success criteria and holdout intent. Draft it, submit it, and let a person approve it; then `campaigns.plan` and `campaigns.fromBrief` build drafts. Never publish the brief or the bundle on the agent's own authority.
- **Ads reporting:** campaigns are matched by `utm_campaign` = the platform's campaign id or name; tell the site owner to tag ad URLs that way. Report ROAS from `ads.performance`, and say when conversions are unattributed. Never propose changes as done: budgets and bids are for people.
- **Conversion map:** rules `{event, value?, currency?, meta?: {connection, eventName}, google?: {connection, conversionAction}}`. Use the confirmed event (e.g. `Subscription Confirmed` → Meta `Lead`), not the form submission. Only people who allowed `ad_measurement` are sent. Agents never change budgets or bids.
- **Delivery policy:** frequency caps, quiet hours and the auto-pause live in the workspace's `delivery_policy` artifact. A `queued` message with a `quiet_hours:` or `paused:` reason is held, not lost; a `frequency_cap:` reason means it was not sent.
- **Segment conditions:** `{"trait":"plan","op":"eq","value":"pro"}`, `{"event":"Product Viewed","where":{"category":"tents"},"count":{"gte":2},"within":"P7D"}`, `{"consent":"marketing_email"}`, `{"segment":"seg_…"}`. Combine them with `{"all":[…]}`, `{"any":[…]}` and `{"not":…}`.
- **Journey nodes:**
  - kinds: `trigger`, `wait`, `waitEvent`, `waitUntil`, `branch`, `split`, `email`, `sms`, `push`, `webhook`, `action`, `transform`, `updateProfile`, `aiDecide`, `aiGenerate`, `goal`, `exit`;
  - give `next` edges explicitly when a node has several outcomes (branch: `[yes, no]`; waitEvent, waitUntil and goal: `[matched, timeout]`; action: `[ok, error]`; split: one per weight; aiDecide: one per option).

## Inputs and results

- Date-times (`sendAt`, `before`, `recordedAt`) take ISO 8601 with `Z` or an offset (`2026-10-30T09:00:00+01:00`) and are stored in UTC. The workspace's time zone is in `workspace.get` (`timeZone`).
- Unknown input keys are not ignored silently: the result carries `warnings` naming the key and the allowed keys. Servers with `STRICT_INPUTS=true` reject them. Read the warnings and fix the call.
- Every tool declares an output schema; read `structuredContent` rather than parsing the text block.
- `workspace.get` returns `permissionsExplained`: what each of your permissions lets you do under the current approval policy.

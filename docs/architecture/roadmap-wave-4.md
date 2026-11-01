# Roadmap, wave 4: agentic marketing (plan 2026-10-30; Phases 17–20 built)

> **Status at 0.6.1:** Phases 17–20 are built. Phase 17 shipped in 0.3.0 (tracker #219), Phase 18 in 0.4.0 (#230), Phase 19 in 0.5.0 (#259) and Phase 20 in 0.6.0 (#317), with fixes in 0.4.1, 0.5.1–0.5.5 and 0.6.1. The pilot done-criteria — four weekly issues without a person in the send path, a month of the newsletter programme, and a promoted lifecycle variant — are remaining work, not missing code. Phases 21–22 are planned. The text below keeps the original plan; the status lines say what happened.

Wave 3 (Phases 12 to 16) is built, and 0.2.10 hardened the build, the release path and the docs. The platform now has everything an agent needs to see and do marketing: one command layer for REST and MCP, drafts and approvals, a send gateway that enforces consent, a metric layer, campaigns, holdouts and alerts.

What it did not have at 0.2.10 was **autonomy with borders**. Then an agent either proposed and a person approved every change, or published whatever its scopes allowed. Wave 4 was about the space in between and beyond it: agents that run whole marketing loops (plan, build, send, measure, learn) on their own, inside borders a person set, with the platform enforcing those borders and stepping in by itself when results go wrong. That design is built through Phase 20; what remains is the full hosted runtime and many-agent/multi-brand coordination.

This replaces the single "Phase 17: agents with bounded autonomy" of [wave 3](roadmap-wave-3.md). The scope is deliberately not limited to one release; it is split into phases that each ship something usable and each make the next one safe. The model is in [agentic-autonomy.md](agentic-autonomy.md) and [ADR-0016](adr/0016-agent-autonomy-model.md).

## How it is prioritised

Wave 3's four questions still apply (unblocks real use, prerequisite, value per effort, risk if postponed). Two rules are added for agentic work:

1. **Brakes before engines.** No level of autonomy ships before the controls that bound it: limits and the stop button before autonomous sends; the guardian and undo before autonomous loops.
2. **Earn each step on the pilot.** Each new level is first granted to one agent on MartechSignal, in shadow mode or at a small cap, and widened from its record, not from a plan.

## The phases at a glance

| Phase | Theme | Main contents | Depends on | Size* | "Done" means |
|---|---|---|---|---|---|
| **17** ✅ | **Agent controls** (built in 0.3.0; #207 still open) | Agents as first-class principals with sponsors and a pause button; action classes on every command; workspace ceilings and an autonomy switch; the policy engine with counters and impact estimates; the guardrails the docs promise (audience threshold, per-agent limits); the action ledger; the MCP pilot-loop e2e test | 0.2.10 | L | Every agent write passes one decision point that enforces limits and explains itself; a person can see every agent, what it did, and stop it in one click |
| **18** ✅ | **Mandates and the first autonomy** (built in 0.4.0; the pilot run is still open) | The `agent_mandate` artifact (scope, levels, limits, guardrails, expiry, escalation); levels L0–L3; holds with veto windows; intent records; notifications and digests; business context artifact; optional independent check | 17 | L | Hermes sends the weekly newsletter to the subscriber segment without a person in the loop, under a mandate with a recipient cap and an unsubscribe guardrail, for four weeks in a row |
| **19** ✅ | **The safety net** (built in 0.5.0; fixes in 0.5.1–0.5.5) | The guardian (guardrails and anomaly checks, automatic downgrade and pause); staged sends and canaries; undo for reversible actions; shadow mode; required holdouts for autonomous experiments; loop and probing detection; thin hosted agents (scheduled reports, the deliverability guardian) | 18 | L | A tripped guardrail downgrades an agent within minutes without a person, an unsafe send stops after its canary stage, and a person undoes an agent's change in one action |
| **20** ✅ | **Closed loops** (built in 0.6.0; fixes in 0.6.1; the pilot runs are still open) | Level L4; goals in mandates; outcome attribution per agent; learnings store; events for agents (webhooks and MCP polling); the campaign agent (#64); lifecycle optimiser and experimentation programmes; editorial backlog and sources for the newsletter agent (#140, #141); recipes (#150); bulk enrollment (#148) | 19 | XL | An agent runs the newsletter programme end to end for a month (topics, issues, subject tests, sends, report, learnings) and a lifecycle agent ships and promotes a journey variant against a holdout, both within their mandates |
| **21** | **Hosted agents** (planned) | The full hosted runtime (the thin version shipped in Phase 19): event-triggered runs, templates for every programme, the copilot attached to an agent, decision models in journeys (#192–#194), memory and skills for hosted agents | 20 | L | A self-hoster with no agent runtime runs the newsletter programme inside the platform, under a mandate |
| **22** | **Many agents, many brands** (planned) | Coordination between agents (artifact ownership, contact pressure across agents, conflicts); brand scoping (#184, #187); progressive rollout for agent changes (#102); ad audiences and conversions under mandates (budgets: #212); agent performance comparison and renewal at scale | 21, multi-brand track | XL | Three agents run side by side in one workspace, or across two brands, without stepping on each other or exceeding the workspace's limits |

\*Size in working sessions of the current kind: S ≈ 1, M ≈ 2–3, L ≈ 4+, XL ≈ 8+.

Phases 17 to 19 were the core and ran in order (0.3.0, 0.4.0, 0.5.0); Phase 20 followed in 0.6.0. From here the order of Phases 21–22 can change with the pilot: hosted agents (21) move up if a self-hoster without an agent runtime appears; multi-brand (22) moves up if a second brand does.

Alongside the phases runs a **fundamentals track** (below): open bugs, privacy fixes and process items that are scheduled with the phases rather than in a separate hygiene release.

## Phase 17: agent controls

**Status: built in 0.3.0; tracker #219 (closed).** #207 (strict inputs by default) is the one item still open.

Tracked in #219 (wave epic #220): #213 agents as principals, #214 action classes, #215 ceilings, #216 policy engine, #217 guardrails, #218 ledger.

Goal: one place that decides what an agent may do, measured in consequences, and a person who can see and stop every agent. Phase 17 added no new autonomy: every agent still proposed as before. It made the guardrails in `agents-and-mcp.md` real.

- **Agents as principals** (ADR-0016): `agents.*` commands (list, get, update, pause, resume, revoke), a sponsor per agent, credentials (OAuth clients, API tokens) attached to an agent. Agents appear on first use. On upgrade every existing token and OAuth client became an agent with no mandate. Removing the sponsor pauses the agent.
- **Action classes**: every command an agent may run declares one (people-only commands derive it from `effect`); a registry test fails for a write without it. Classes that reach people or money also declare an impact estimator.
- **Workspace ceilings and the autonomy switch**: maximum level per class (default L1: the default is a person), an audience threshold, per-agent limits per 24 hours, whether L4 is allowed, and on / propose-only / off. Settings → Agents → Autonomy (`workspace.setAutonomy`). There is no setup question in 0.6.1.
- **A brand field, reserved**: agents and (in Phase 18) mandates carry an optional brand scope that defaults to the whole workspace, so multi-brand (#184) does not force a rework.
- **The policy engine** in the command executor: `allow | hold | ask | deny` with reasons for every agent write; per-agent counters (changes, messages, sends and the previous send's reach) read from the ledger and updated in the action's transaction; decisions in responses.
- **Impact estimates** for sends (after consent, suppression, topics and caps), journeys (waiting people, entry rate, sending steps), segments (in and out, dependants), experiences (traffic).
- **The promised guardrails**: the audience-size threshold for agent sends (default 1,000, a workspace ceiling), per-agent daily limits for changes and sends, and pausing an agent with its pending approvals. All three are enforced (0.3.0); `agents-and-mcp.md` §3 carries their defaults.
- **`policy.check`**: the same decision without acting, with the nearest allowed alternative. **Not implemented in 0.6.1**: the decision and its reasons come back with the action that was attempted, but there is no read-only preview command.
- **The action ledger**: every agent action with its decision, reasons, impact estimate and later outcome; `agents.activity`; the agent page in the admin UI (what it did, what it was denied, its credentials, pause).
- **Tests**: the end-to-end pilot loop over MCP (#149: draft, approve, send, measure) as the safety net for everything after it.

Done when every agent write goes through the engine, the three promised guardrails are enforced and tested, and a person stops an agent (all its credentials and pending approvals) in one action.

## Phase 18: mandates and the first autonomy

**Status: built in 0.4.0; tracker #230 (closed).** The pilot mandate's four weekly issues are still the open done-criterion.

Goal: a person grants an agent bounded autonomy for a purpose and a period, and the agent uses it. The first grant is the one wave 3 decided: the weekly newsletter.

- **The `agent_mandate` artifact**: purpose and goals, scope (segments, audiences, purposes, topics, channels, artifacts), a level per action class, limits, guardrails, validity (default 30 days), working hours and blackout dates for irreversible actions, escalation targets. People-only to create, change and approve; validated against the workspace ceilings.
- **Levels L0–L3** in the engine (L4 in Phase 20). Out-of-limit actions drop a level with a reason; out-of-scope actions are only ever proposed.
- **Holds (L2)**: queued actions with a deadline in the approvals inbox, with intent, diff, impact and a countdown; veto, approve early, move the deadline; re-checked when they run.
- **Intent records**: required for L2+ actions, stored in the ledger, shown on holds and in the activity feed.
- **Notifications and digests**: holds and refusals go to the sponsor and the mandate's escalation people by e-mail; holds also appear in the approvals inbox; a daily digest per sponsor, and a notice before a mandate expires. Agents can subscribe to events separately (Phase 20).
- **Renewal**: expiring mandates show the agent's record for the period (actions, vetoes, guardrail hits, goal results) and are renewed, changed or left to lapse.
- **Business context** (#85, the narrow part): a versioned `business_context` artifact (audience, offer, voice, claims to avoid, legal lines) as an MCP resource.
- **The independent check**: a second model compares intent, diff and mandate before an L2+ action; off by default and switchable per mandate. The lifecycle and experimentation templates turn it on; external-content reading agents should too.
- **The pilot mandate**: Hermes may publish the weekly broadcast to the Newsletter segment at L3, newsletter topic only, at most 1.2× the last issue's recipients, Tuesday mornings, with an unsubscribe guardrail of 0.5% and a complaint guardrail of 0.1%; everything else L1.

Done when the pilot mandate has run four weekly issues with no person in the send path, and every one of them is in the ledger with its intent, impact and outcome.

## Phase 19: the safety net

**Status: built in 0.5.0; tracker #259 (closed).** Fixes in 0.5.1–0.5.5 (held changes re-decided, undo safety, staged-send checks, hosted-run budgets). The pilot's hosted weekly report and deliverability guardian run is still the open done-criterion.

Goal: the platform protects itself from a confused or manipulated agent without a person watching. This phase is what makes L3 safe to grant widely and L4 possible.

- **The guardian**: evaluates each mandate's guardrails on the metric layer (reusing the alert evaluator) and the ledger; downgrades to L1 or pauses; suspends holds; tells the sponsor with evidence.
- **Anomaly checks**: send size and frequency against the agent's own history, bursts of changes, new artifact types, error rates, repeated denials (probing). A deviation holds the next irreversible action.
- **Staged sends**: canary share (reusing the subject-test sampling), a wait, a check on bounces, complaints, unsubscribes and early clicks, then the rest or a stop. As built, staging applies to broadcasts; journey changes are not canaried.
- **Undo**: the ledger stores how to reverse each reversible action; `agents.undo` for people. As built in 0.5.0 (hardened in 0.5.2–0.6.0), that means republishing the version the agent replaced (or taking a first publish out of service again) and cancelling a broadcast that has not gone out or stopping a staged send. It does not pause a journey or move participants back; a send that already happened cannot be recalled, and the ledger says so.
- **Shadow mode**: a mandate (or one class in it) runs as "would have done", compared with what people did; the record supports granting the level for real.
- **Learning rules**: mandates can require holdouts on new journeys, broadcast variants and experiences.
- **Thin hosted agents** (the early part of #86): scheduled, read-mostly runs on the copilot's runtime, with run history and budgets; templates for a weekly report agent and the **deliverability guardian**. As built (0.5.0) the guardian proposes a pause through the normal approval and mandate path; a person still pauses the stream.
- **Loop detection**: the same artifact changed back and forth, or an agent reacting to its own events.

Done when, in a test workspace, a deliberately bad agent (oversized send, rising unsubscribes, change bursts) is stopped by the guardian at each step without a person, a staged send halts after its canary, and the pilot runs a hosted weekly report and deliverability guardian.

## Phase 20: closed loops

**Status: built in 0.6.0; tracker #317 (closed).** Fixes in 0.6.1 (L4 earning, report counts, bulk enrollment version pinning). The month-long newsletter run and the promoted lifecycle variant are still the open done-criteria.

Goal: agents that run a programme, not a task: they choose what to do next from goals and results, within their mandate.

- **L4 "run the loop"**: within its goals and scope, the agent creates new artifacts and starts experiments without a grant for each. Earned per agent and class: 28 days at L3 without a guardian episode, or a shadow-mode run of the same length. Built in 0.6.0; 0.6.1 counts only actions the engine decided at level 3 or above, and only artifacts the agent drafted itself.
- **Goals and attribution**: mandate goals on metric-layer measures; the ledger links actions to outcomes; `agents.report` per agent and period, with results against holdouts.
- **Learnings**: an inspectable store of conclusions with their evidence experiment, readable by agents as an MCP resource, retractable by people.
- **Events for agents**: subscriptions to holds decided, approvals, guardrail hits, experiments reaching significance, alerts and schedules, through webhooks and MCP polling (`agents.events`; the stateless MCP server cannot push notifications), built in 0.6.0.
- **Programmes** (mandate templates, skills and recipes, not hard-coded features):
  - the **newsletter editor** with an editorial topic backlog and briefs (#141) and content sources (#140);
  - the **campaign agent** (#64): goal and brief → campaign bundle → run → evaluate;
  - the **lifecycle optimiser**: journey variants to a share of entrants against a holdout, promote or retire;
  - the **experimentation agent** for web experiences;
  - the **audience curator** (sunset policies, overlaps, growth).
- **Recipes** (#150): starter journeys and templates the programmes and people build from.
- **Bulk enrollment** (#148) beyond 1,000 ids, which the lifecycle optimiser needs.

Done when the newsletter programme runs end to end for a month, and a lifecycle agent ships and promotes a journey variant against a holdout, both within their mandates and visible in their reports.

## Phase 21: hosted agents

**Status: planned.** The thin version shipped in 0.5.0 (scheduled hosted runs, the weekly report and deliverability guardian templates).

Goal: the full hosted runtime, building on the thin version from Phase 19: agents that run inside the platform for self-hosters without Hermes, Claude or n8n, under the same mandates.

- **Hosted runs** (#86): scheduled and event-triggered; a fresh session with the mandate, business context, learnings and a summary of previous runs; run history, budgets, failure handling.
- **Event-triggered runs and mandate templates** for every programme of Phase 20.
- **The copilot attached to an agent**: a conversation can act as an agent under its mandate, instead of as the person.
- **Decision models in journeys** (#192–#194): scope-B agents deciding per person inside a step, under the AI budgets and the decision log.
- **Agent memory and skills** (the rest of #85), only for hosted agents; external agents keep their own.

Done when a self-hoster turns on a deliverability guardian and a weekly report agent from templates, and both run under mandates with their own history.

## Phase 22: many agents, many brands

**Status: planned.** The brand field on agents and mandates exists as a reserved placeholder; multi-brand (#184, #187), progressive rollout (#102) and agent-managed ad budgets (#212) are open.

Goal: several agents and several brands in one instance without conflicts.

- **Coordination**: artifact ownership by an agent's mandate; conflicts (two agents changing the same journey) held for a person; contact pressure across agents per person on top of the delivery policy's caps.
- **Brands** (#184 track below): mandates scoped to a brand; agents and tokens across brands (#187).
- **Progressive rollout** (#102) for agent changes beyond sends and journeys (experiences, segments, settings).
- **Ad audiences and conversions** under mandates. Budget and bid autonomy is not in this wave: it needs its own design first (#212).
- **Agent comparison**: performance of agents and mandates side by side; renewal at scale.

Done when three agents run side by side (or across two brands) for a month without conflicts and within the workspace's ceilings.

## Fundamentals track

Scheduled with the phases, not as a separate release. Bugs first.

| Item | Why | What happened |
|---|---|---|
| **Erased people recreated by queued or late events: identifier tombstones (#210)** | Privacy bug found in 0.2.10; system events are fixed, customer events and restores were not | **Shipped 0.3.0** (#210 closed): the resolver drops events that name only erased identifiers inside `ERASURE_GRACE_HOURS`. |
| **Restores must not resurrect erased people (#144)** | Same problem through backups; shares the tombstones | **Shipped 0.5.0** (#144 closed): `am restore` replays erasures and tombstones after the Postgres load. |
| **Analytics: campaign ratio aliases (#209)** | Latent bug found by the unit tests; agents read these outputs | **Shipped 0.3.0** (#209 closed). |
| **Strict inputs by default (#207)** | Agents are the main clients; unknown keys are usually agent mistakes | **Still open.** Unknown keys are recorded and `STRICT_INPUTS` exists, but the default still warns in 0.6.1. |
| **End-to-end pilot loop over MCP (#149)** | The regression net for every agentic phase | **Shipped 0.3.0** (#149 closed): `apps/server/test/pilot-loop-mcp.test.ts`. |
| **Operational health: metrics endpoint and system alerts (#147)** | Autonomous agents need the platform's own health visible; the guardian should know when the platform is degraded | **Shipped 0.5.0** (#147 closed): `GET /metrics` with `METRICS_TOKEN`, plus `am doctor` queue and delivery checks. |
| **Workspace portability and clone (#151)** | A cloned workspace is the rehearsal ground for shadow mode and new mandates | **Shipped 0.5.0** (#151 closed): `config.export` includes settings, `config.drift` previews a clone. |
| **Test structure by domain, shared fixtures, UI coverage (#173 rest)** | Applied to the areas each phase touches | **Open** (#173): the 0.2.10 test layout landed, the coverage gaps do not. |
| **Accessibility checks (#206)** | The agent pages and holds inbox are new UI | **Open** (#206): axe-core checks are not in the e2e suite yet. |
| **GitHub hardening: provenance, SBOM, Actions policy (#182 rest)** | Supply-chain trust for a platform that runs agents | **Partly shipped 0.3.0**: provenance and SBOM are in the release; CodeQL, rulesets and the Actions policy remain open (#182). |
| **mjml 5 (#205)** | Removes four accepted advisories; the newsletter agent renders a lot of e-mail | **Fixed** (#205): the server and the editor use mjml 5, rendering is async, and the mjml, `minimatch` and `glob` advisories are gone from the audit. |
| **Contributor scaffolding (#208)** | Before inviting contributors to agent programmes | **Open** (#208). |
| **Backups: remote target, integrity, key handling, ClickHouse at scale (#142, #143, #145, #146)** | Operational safety; more pressing as agents write more | **Open** (#142, #143, #145, #146). The erasure replay from #144 shipped in 0.5.0; the remote target, key verification, integrity checks and a scaled ClickHouse backup do not. |
| **Self-service password reset (#191)** | Every agent has a sponsor who must be able to sign in | **Open** (#191). |
| **AI PR reviewer (#183)** | Optional; worth it once more than one person contributes | **Open, parked** (#183). |
| **Undo offered only when it would work (#305)** | The agent page must not offer an undo that would refuse | **Shipped 0.6.0** (#305 closed): `agents.activity` reports `undoable` and `undoBlockedBy`. |

### Multi-brand track (#184)

Multi-brand and multi-domain on one instance (#184 with #185, #186, #188, #189, #190, #195) is not agentic, but agents across brands (#187) depend on it, and the per-brand privacy semantics (#189) affect what a mandate's scope means. It runs as its own track: designed during Phases 18–19, built when a second brand needs it, and in any case before Phase 22. Branding (#195) and the navigation collapse (#180) are small UI items that can land with any phase.

## What stays from wave 3

The "Later, when a pilot needs it" and "Parked" lists in [wave 3](roadmap-wave-3.md#later-when-a-pilot-needs-it) still hold, with three changes:

- **Feature flags and progressive rollout (#102)** moves into Phase 22 (and the staged sends of Phase 19 cover broadcasts earlier). Still open.
- **Scheduled agent routines (#86)** shipped in a thin, scheduled form with hosted agents in 0.5.0; event-triggered runs and **agent memory and skills (the rest of #85)** remain in Phase 21.
- **Predictive scores (#69)** stays parked, but the decision-model work in Phase 21 (#192–#194) is its likely entry point.

## Decisions (owner, 2026-10-30)

Recorded in [agentic-autonomy.md §11](agentic-autonomy.md#11-decisions-owner-2026-10-30):

1. The default is a person (L1 ceiling); enabling L2 is one choice in setup or settings. **Built in 0.3.0**; in 0.6.1 the choice is in Settings → Agents → Autonomy, not in setup.
2. L4 in Phase 20, earned per agent and class. **Built in 0.6.0** (only level-3 operation counts from 0.6.1).
3. The independent model check in Phase 18; on by default for agents reading external content. **Built in 0.4.0**; off by default, on in the lifecycle and experimentation templates.
4. Thin hosted agents early (Phase 19), the full runtime in Phase 21. **Thin version built in 0.5.0.**
5. Ad audiences and conversions only; agent-managed spend needs its own design first (#212). **Still open.**
6. Multi-brand after the autonomy phases, with a brand field reserved in Phase 17. **The brand field exists; multi-brand (#184, #187) is open.**

# Roadmap, wave 4: agentic marketing (planned 2026-10-30)

Wave 3 (Phases 12 to 16) is built, and 0.2.10 hardened the build, the release path and the docs. The platform now has everything an agent needs to see and do marketing: one command layer for REST and MCP, drafts and approvals, a send gateway that enforces consent, a metric layer, campaigns, holdouts and alerts.

What it does not have is **autonomy with borders**. Today an agent either proposes and a person approves every change, or publishes whatever its scopes allow. Wave 4 is about the space in between and beyond it: agents that run whole marketing loops (plan, build, send, measure, learn) on their own, inside borders a person set, with the platform enforcing those borders and stepping in by itself when results go wrong.

This replaces the single "Phase 17: agents with bounded autonomy" of [wave 3](roadmap-wave-3.md). The scope is deliberately not limited to one release; it is split into phases that each ship something usable and each make the next one safe. The model is in [agentic-autonomy.md](agentic-autonomy.md) and [ADR-0016](adr/0016-agent-autonomy-model.md).

## How it is prioritised

Wave 3's four questions still apply (unblocks real use, prerequisite, value per effort, risk if postponed). Two rules are added for agentic work:

1. **Brakes before engines.** No level of autonomy ships before the controls that bound it: limits and the stop button before autonomous sends; the guardian and undo before autonomous loops.
2. **Earn each step on the pilot.** Each new level is first granted to one agent on MartechSignal, in shadow mode or at a small cap, and widened from its record, not from a plan.

## The phases at a glance

| Phase | Theme | Main contents | Depends on | Size* | "Done" means |
|---|---|---|---|---|---|
| **17** ✅ | **Agent controls** (built in 0.3.0; #144 and #207 still open) | Agents as first-class principals with sponsors and a pause button; action classes on every command; workspace ceilings and an autonomy switch; the policy engine with counters and impact estimates; the guardrails the docs promise (audience threshold, per-agent limits); `policy.check`; the action ledger; the MCP pilot-loop e2e test | 0.2.10 | L | Every agent write passes one decision point that enforces limits and explains itself; a person can see every agent, what it did, and stop it in one click |
| **18** ✅ | **Mandates and the first autonomy** (built in 0.4.0; the pilot run follows) | The `agent_mandate` artifact (scope, levels, limits, guardrails, expiry, escalation); levels L0–L3; holds with veto windows; intent records; notifications and digests; business context artifact; optional independent check | 17 | L | Hermes sends the weekly newsletter to the subscriber segment without a person in the loop, under a mandate with a recipient cap and an unsubscribe guardrail, for four weeks in a row |
| **19** | **The safety net** | The guardian (guardrails and anomaly checks, automatic downgrade and pause); staged sends and canaries; undo for reversible actions; shadow mode; required holdouts for autonomous experiments; loop and probing detection; thin hosted agents (scheduled reports, the deliverability guardian) | 18 | L | A tripped guardrail downgrades an agent within minutes without a person, an unsafe send stops after its canary stage, and a person undoes an agent's change in one action |
| **20** | **Closed loops** | Level L4; goals in mandates; outcome attribution per agent; learnings store; events for agents (webhooks and MCP notifications); the campaign agent (#64); lifecycle optimiser and experimentation programmes; editorial backlog and sources for the newsletter agent (#140, #141); recipes (#150) | 19 | XL | An agent runs the newsletter programme end to end for a month (topics, issues, subject tests, sends, report, learnings) and a lifecycle agent ships and promotes a journey variant against a holdout, both within their mandates |
| **21** | **Hosted agents** | The full hosted runtime (the thin version ships in Phase 19): event-triggered runs, templates for every programme, the copilot attached to an agent, decision models in journeys (#192–#194), memory and skills for hosted agents | 20 | L | A self-hoster with no agent runtime runs the newsletter programme inside the platform, under a mandate |
| **22** | **Many agents, many brands** | Coordination between agents (artifact ownership, contact pressure across agents, conflicts); brand scoping (#184, #187); progressive rollout for agent changes (#102); ad audiences and conversions under mandates (budgets: #212); agent performance comparison and renewal at scale | 21, multi-brand track | XL | Three agents run side by side in one workspace, or across two brands, without stepping on each other or exceeding the workspace's limits |

\*Size in working sessions of the current kind: S ≈ 1, M ≈ 2–3, L ≈ 4+, XL ≈ 8+.

Phases 17 to 19 are the core and should run in order. From Phase 20 the order can change with the pilot: hosted agents (21) move up if a self-hoster without an agent runtime appears; multi-brand (22) moves up if a second brand does.

Alongside the phases runs a **fundamentals track** (below): open bugs, privacy fixes and process items that are scheduled with the phases rather than in a separate hygiene release.

## Phase 17: agent controls

Tracked in #219 (wave epic #220): #213 agents as principals, #214 action classes, #215 ceilings, #216 policy engine, #217 guardrails, #218 ledger.

Goal: one place that decides what an agent may do, measured in consequences, and a person who can see and stop every agent. No new autonomy yet: every agent still proposes as today. This phase makes the guardrails in `agents-and-mcp.md` real.

- **Agents as principals** (ADR-0016): `agents.*` commands (list, get, create, update, pause, resume, revoke), a sponsor per agent, credentials (OAuth clients, API tokens) attached to an agent. On upgrade every existing token and OAuth client becomes an agent with no mandate. Removing the sponsor pauses the agent.
- **Action classes**: every command declares one; a registry test fails for a command without it. Classes that reach people or money also declare an impact estimator.
- **Workspace ceilings and the autonomy switch**: maximum level per class (default L1: the default is a person), maximum recipients per autonomous send, autonomous messages per week, whether L4 is allowed; on / propose-only / off. Settings → Agents in the UI, and one question in setup (`am init`, first sign-in) to allow L2.
- **A brand field, reserved**: agents and (in Phase 18) mandates carry an optional brand scope that defaults to the whole workspace, so multi-brand (#184) does not force a rework.
- **The policy engine** in the command executor: `allow | hold | ask | deny` with reasons for every agent write; counters per agent and workspace (sends, messages, people, changes, spend; day and week) updated in the action's transaction; decisions in responses.
- **Impact estimates** for sends (after consent, suppression, topics and caps), journeys (waiting people, entry rate, sending steps), segments (in and out, dependants), experiences (traffic).
- **The promised guardrails**: the audience-size threshold for agent sends (default 1,000, a workspace ceiling), per-agent daily limits for changes and sends, and pausing an agent with its pending drafts. Until each ships, `agents-and-mcp.md` §3 marks it as planned.
- **`policy.check`**: the same decision without acting, with the nearest allowed alternative.
- **The action ledger**: every agent action with its decision, reasons, impact estimate and later outcome; `agents.activity`; the agent page in the admin UI (what it did, what it was denied, its credentials, pause).
- **Tests**: the end-to-end pilot loop over MCP (#149: draft, approve, send, measure) as the safety net for everything after it.

Done when every agent write goes through the engine, the three promised guardrails are enforced and tested, and a person stops an agent (all its credentials and pending drafts) in one action.

## Phase 18: mandates and the first autonomy

Goal: a person grants an agent bounded autonomy for a purpose and a period, and the agent uses it. The first grant is the one wave 3 decided: the weekly newsletter.

- **The `agent_mandate` artifact**: purpose and goals, scope (segments, audiences, purposes, topics, channels, artifacts), a level per action class, limits, guardrails, validity (default 30 days), working hours and blackout dates for irreversible actions, escalation targets. People-only to create, change and approve; validated against the workspace ceilings.
- **Levels L0–L3** in the engine (L4 in Phase 20). Out-of-limit actions drop a level with a reason; out-of-scope actions are only ever proposed.
- **Holds (L2)**: queued actions with a deadline in the approvals inbox, with intent, diff, impact and a countdown; veto, approve early, move the deadline; re-checked when they run.
- **Intent records**: required for L2+ actions, stored in the ledger, shown on holds and in the activity feed.
- **Notifications and digests**: holds, downgrades and daily or weekly digests per agent to its sponsor (in-app, e-mail, webhook).
- **Renewal**: expiring mandates show the agent's record for the period (actions, vetoes, guardrail hits, goal results) and are renewed, changed or left to lapse.
- **Business context** (#85, the narrow part): a versioned `business_context` artifact (audience, offer, voice, claims to avoid, legal lines) as an MCP resource.
- **The independent check**: a second model compares intent, diff and mandate before an L2+ action; off by default and switchable per mandate, on by default for agents that read external content.
- **The pilot mandate**: Hermes may publish the weekly broadcast to the Newsletter segment at L3, newsletter topic only, at most 1.2× the last issue's recipients, Tuesday mornings, with an unsubscribe guardrail of 0.5% and a complaint guardrail of 0.1%; everything else L1.

Done when the pilot mandate has run four weekly issues with no person in the send path, and every one of them is in the ledger with its intent, impact and outcome.

## Phase 19: the safety net

Goal: the platform protects itself from a confused or manipulated agent without a person watching. This phase is what makes L3 safe to grant widely and L4 possible.

- **The guardian**: evaluates each mandate's guardrails on the metric layer (reusing the alert evaluator) and the ledger; downgrades to L1 or pauses; suspends holds; tells the sponsor with evidence.
- **Anomaly checks**: send size and frequency against the agent's own history, bursts of changes, new artifact types, error rates, repeated denials (probing). A deviation holds the next irreversible action.
- **Staged sends**: canary share (reusing the subject-test sampling), a wait, a check on bounces, complaints, unsubscribes and early clicks, then the rest or a stop. Live journey changes to a share of new entrants first.
- **Undo**: the ledger stores how to reverse each reversible action; `agents.undo` for people and the guardian (republish the previous version, cancel a scheduled send or its remaining stages, pause a journey, restore a segment version, end an experience).
- **Shadow mode**: a mandate (or one class in it) runs as "would have done", compared with what people did; the record supports granting the level for real.
- **Learning rules**: mandates can require holdouts on new journeys, broadcast variants and experiences.
- **Thin hosted agents** (the early part of #86): scheduled, read-mostly runs on the copilot's runtime, with run history and budgets; templates for a weekly report agent and the **deliverability guardian** (L3 for throttling and pausing streams only).
- **Loop detection**: the same artifact changed back and forth, or an agent reacting to its own events.

Done when, in a test workspace, a deliberately bad agent (oversized send, rising unsubscribes, change bursts) is stopped by the guardian at each step without a person, a staged send halts after its canary, and the pilot runs a hosted weekly report and deliverability guardian.

## Phase 20: closed loops

Goal: agents that run a programme, not a task: they choose what to do next from goals and results, within their mandate.

- **L4 "run the loop"**: within its goals and scope, the agent creates new artifacts and starts experiments without a grant for each. Earned per agent and class: four weeks at L3 without a tripwire, or a shadow-mode run of the same length.
- **Goals and attribution**: mandate goals on metric-layer measures; the ledger links actions to outcomes; `agents.report` per agent and period, with results against holdouts.
- **Learnings**: an inspectable store of conclusions with their evidence experiment, readable by agents as an MCP resource, retractable by people.
- **Events for agents**: subscriptions to holds decided, approvals, guardrail hits, experiments reaching significance, alerts and schedules, through webhooks and MCP notifications.
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

Goal: the full hosted runtime, building on the thin version from Phase 19: agents that run inside the platform for self-hosters without Hermes, Claude or n8n, under the same mandates.

- **Hosted runs** (#86): scheduled and event-triggered; a fresh session with the mandate, business context, learnings and a summary of previous runs; run history, budgets, failure handling.
- **Event-triggered runs and mandate templates** for every programme of Phase 20.
- **The copilot attached to an agent**: a conversation can act as an agent under its mandate, instead of as the person.
- **Decision models in journeys** (#192–#194): scope-B agents deciding per person inside a step, under the AI budgets and the decision log.
- **Agent memory and skills** (the rest of #85), only for hosted agents; external agents keep their own.

Done when a self-hoster turns on a deliverability guardian and a weekly report agent from templates, and both run under mandates with their own history.

## Phase 22: many agents, many brands

Goal: several agents and several brands in one instance without conflicts.

- **Coordination**: artifact ownership by an agent's mandate; conflicts (two agents changing the same journey) held for a person; contact pressure across agents per person on top of the delivery policy's caps.
- **Brands** (#184 track below): mandates scoped to a brand; agents and tokens across brands (#187).
- **Progressive rollout** (#102) for agent changes beyond sends and journeys (experiences, segments, settings).
- **Ad audiences and conversions** under mandates. Budget and bid autonomy is not in this wave: it needs its own design first (#212).
- **Agent comparison**: performance of agents and mandates side by side; renewal at scale.

Done when three agents run side by side (or across two brands) for a month without conflicts and within the workspace's ceilings.

## Fundamentals track

Scheduled with the phases, not as a separate release. Bugs first.

| Item | Why | Lands with |
|---|---|---|
| **Erased people recreated by queued or late events: identifier tombstones (#210)** | Privacy bug found in 0.2.10; system events are fixed, customer events and restores are not | Phase 17 (before agents act on audiences) |
| **Restores must not resurrect erased people (#144)** | Same problem through backups; shares the tombstones | Phase 17, with #210 |
| **Analytics: campaign ratio aliases (#209)** | Latent bug found by the unit tests; agents will read these outputs | Phase 17 |
| **Strict inputs by default (#207)** | Agents are the main clients; unknown keys are usually agent mistakes | Phase 17 (first minor release) |
| **End-to-end pilot loop over MCP (#149)** | The regression net for every agentic phase | Phase 17 |
| **Operational health: metrics endpoint and system alerts (#147)** | Autonomous agents need the platform's own health visible; the guardian should know when the platform is degraded | Phase 19 |
| **Workspace portability and clone (#151)** | A cloned workspace is the rehearsal ground for shadow mode and new mandates | Phase 19 |
| **Test structure by domain, shared fixtures, UI coverage (#173 rest)** | Applied to the areas each phase touches | Each phase |
| **Accessibility checks (#206)** | The agent pages and holds inbox are new UI | Phase 18 |
| **GitHub hardening: provenance, SBOM, Actions policy (#182 rest)** | Supply-chain trust for a platform that runs agents | Phase 17 |
| **mjml 5 (#205)** | Removes two accepted advisories; the newsletter agent will render a lot of e-mail | Phase 20 (before the newsletter programme scales) |
| **Contributor scaffolding (#208)** | Before inviting contributors to agent programmes | Any time |
| **Backups: remote target, integrity, key handling, ClickHouse at scale (#142, #143, #145, #146)** | Operational safety; more pressing as agents write more | Between phases, by pilot need |
| **Self-service password reset (#191)** | Every agent has a sponsor who must be able to sign in | Phase 18 |
| **AI PR reviewer (#183)** | Optional; worth it once more than one person contributes | Parked |

### Multi-brand track (#184)

Multi-brand and multi-domain on one instance (#184 with #185, #186, #188, #189, #190, #195) is not agentic, but agents across brands (#187) depend on it, and the per-brand privacy semantics (#189) affect what a mandate's scope means. It runs as its own track: designed during Phases 18–19, built when a second brand needs it, and in any case before Phase 22. Branding (#195) and the navigation collapse (#180) are small UI items that can land with any phase.

## What stays from wave 3

The "Later, when a pilot needs it" and "Parked" lists in [wave 3](roadmap-wave-3.md#later-when-a-pilot-needs-it) still hold, with three changes:

- **Feature flags and progressive rollout (#102)** moves into Phase 22 (and the staged sends of Phase 19 cover sends and journeys earlier).
- **Scheduled agent routines (#86)** and **agent memory and skills (the rest of #85)** move into Phase 21.
- **Predictive scores (#69)** stays parked, but the decision-model work in Phase 21 (#192–#194) is its likely entry point.

## Decisions (owner, 2026-10-30)

Recorded in [agentic-autonomy.md §11](agentic-autonomy.md#11-decisions-owner-2026-10-30):

1. The default is a person (L1 ceiling); enabling L2 is one choice in setup or settings.
2. L4 in Phase 20, earned per agent and class.
3. The independent model check in Phase 18; on by default for agents reading external content.
4. Thin hosted agents early (Phase 19), the full runtime in Phase 21.
5. Ad audiences and conversions only; agent-managed spend needs its own design first (#212).
6. Multi-brand after the autonomy phases, with a brand field reserved in Phase 17.

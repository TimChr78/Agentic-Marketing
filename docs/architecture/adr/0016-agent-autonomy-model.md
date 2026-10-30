# ADR-0016: Agent autonomy through mandates, levels and a policy engine in the command layer

- Status: Accepted (owner decisions 2026-10-30, see the design §11)
- Date: 2026-10-30
- Design: [agentic-autonomy.md](../agentic-autonomy.md); plan: [wave 4](../roadmap-wave-4.md)
- Related: #91 (autonomy modes), #64 (campaign agent), #85 (business context), #86 (routines), #102 (progressive rollout)

## Context
Autonomy for agents is one workspace switch today: the approval policy (`none`, `agent_changes`, `all_publishes`) decides whether an agent's publish waits for a person. Either agents propose and a person approves every change, or they act with whatever their scopes allow. The architecture docs also describe guardrails that were never built: an audience-size threshold for agent sends, per-agent rate limits and budgets, and a kill switch per agent.

The product's purpose is agents running marketing loops (plan, build, send, measure, learn) without a person in every step. That needs borders the platform enforces, measured in consequences (people reached, money, reversibility), not in command names.

## Options
| Option | Pros | Cons |
|---|---|---|
| **Mandates + levels + a policy engine in the executor** | One enforcement point for REST, MCP, copilot and hosted runs; borders in consequences; per agent, per action class; expiry and review built in; can grow to full loops | The largest build; every action class needs an impact estimate |
| Finer approval policies only (per artifact type, per token) | Small change on today's model | Still "approve or not"; no limits, no outcome-based brake, no loops |
| A separate policy service (OPA/Cedar) | Mature policy languages | A second system to run for self-hosters; impact and counters still have to come from the platform; agents' borders would live outside the artifacts people already review |
| Trust the agent runtime (limits in the agent's prompt or skill) | No platform work | Not a control: a confused or manipulated agent ignores it |

## Decision
- **Agents are first-class principals** with a sponsor (a person), credentials, a status (active, paused, revoked) and a current mandate. Pausing an agent stops all its credentials.
- **Commands declare an action class** (read, draft, content.publish, audience.publish, send.broadcast, send.direct, journey.live, experience.live, spend, data.write, settings, destructive).
- **A mandate** (`agent_mandate` artifact, versioned, approved by a person, never editable by the agent) gives a level per action class (L0 observe, L1 propose, L2 act with veto, L3 act within limits, L4 run the loop), a scope, limits, guardrails, learning rules, a validity period and escalation targets.
- **Workspace ceilings** cap every mandate; an autonomy switch (on, propose-only, off) overrides all of them at once.
- **A policy engine in the command executor** decides each agent write (allow, hold, ask, deny, with reasons) from the mandate, ceilings, live counters, an impact estimate and open tripwires. `policy.check` gives the same answer without acting.
- **Fixed rule:** destructive actions, credentials, and changes to consent, purposes or delivery caps always ask, whatever the mandate says.
- **A guardian** evaluates guardrails and anomalies on the metric layer and the action ledger, and downgrades or pauses agents by itself.
- Every L2+ action carries an **intent**; every agent action is recorded in a **ledger** linked to the mandate version, its impact estimate and later its outcome.
- The approval policy remains, and an agent without a mandate behaves as today (L1 for every class under `agent_changes`).
- **The default is a person**: new workspaces have an L1 ceiling; enabling L2 is one choice in setup or settings. **L4 is earned** per agent and class (four weeks at L3 without a tripwire, or a shadow run).
- **An independent model check** of intent against diff and mandate is available per mandate from the first autonomy, and on by default for agents that read external content.
- Spend autonomy (ad budgets and bids) is excluded until its own design (#212); ad audiences and conversions follow the normal rules.
- Agents and mandates carry an optional **brand** scope from the start, defaulting to the workspace.

## Consequences
- Autonomy becomes something a person grants, sees, reviews and withdraws per agent, and the platform enforces it the same way for every runtime.
- Every command needs an action class, and every class that reaches people or money needs an impact estimate; new commands must declare both (a registry test enforces it).
- Agents get clearer feedback (decisions with reasons and the nearest allowed action) and must state intents for autonomous actions.
- The guardrails promised in `agents-and-mcp.md` become real, and the doc is corrected until they ship.
- Hosted agent runs and progressive rollout build on the same engine instead of adding their own controls.

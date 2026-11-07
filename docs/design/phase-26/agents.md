# Agents · #509

Inventory retains active/paused/revoked state, with Pause visible on every active row. Detail uses
four tabs: Overview / Activity / Mandate / Credentials. Pause remains in the header across tabs.
Workspace autonomy stays in Settings; do not recreate its editor here.

## Period and exact reads

Inventory agents.list({})=1, no per-agent reports, hosted or mandate reads. Comparison is explicit
selection (1..20 ids), agents.compare({agentIds,from,to})=1 on opening/applying; no default polling.
Detail initial Overview: agents.get({id})=1 plus agents.report({agentId:id,from,to})=1 when audit:read
=2 total. Refresh report1. Activity first open: agents.activity({agentId:id,since:from,limit:50})=1;
next page1 with before:next (numeric id unchanged). This endpoint lacks to: label “Since [from]”,
not a closed report-period ledger. Do not drop later rows invisibly to fake closed-period paging.
Optional Guardian details loads agents.guardian({agentId:id,limit:50})=1 only when expanded.
Mandate first open: proposed agents.mandate({agentId:id}) + workspace.autonomy({})=2, reuse get.guard.
Credentials uses existing get.credentials=0 more; hosted section loads agents.hostedRuns({agentId:id,
limit:20})=1 on expansion, subsequent before:next pages1. No artifact scans or credential lookups.
These budgets replace existing cards’ eager duplicate fetches; share parent results explicitly.

Read permissions: list/get/mandate/autonomy/hosted artifacts:read; activity/report/compare/guardian
 audit:read. Pause/resume/revoke/update workspace:admin. profiles:read is not assumed for outcomes;
never fetch recipient identity. Existing credential mutations retain their own server permissions.

Pause: agents.pause({id}) exactly1 mutation, no modal or mandatory reason; disable during request,
on success update returned agent and announce Paused; error inline with Retry, preserve active state.
No optimistic paused claim. Resume/revoke keep existing confirmation semantics. Pause stops future
agent authorization under existing policy; do not promise cancellation of already-queued delivery.

## Visual sections and cuts

Overview: outcome tiles from report.outcomes.broadcasts and direct kept in separate lanes;
broadcast sent/opened/clicked/unsubscribed/complained/bounced are distinct people, direct are
messages. Null whole outcomes or lane → unavailable. Goals tiles measure,target,direction,value,
met,note; missing target → no target, missing/unsupported value → unavailable, never failed goal.
No causal claims. Journey outcomes show returned verdict/note. Report provides from/to but no
freshness: Latest event in period Unavailable, fetched-at separately.

Decision breakdown uses report.actions[actionClass].allow/hold/ask/deny/failed, plain labels Ran /
Held / Asked a person / Refused / Failed, grouped bars and table. These are action tallies, not
unique people; do not infer failed from !ok or derive totals from first ledger page. No percentage
partition unless server categories are established disjoint; use count bars as default.
Activity timeline shows ledger rows with decision, timestamp, intent, reasons, target/surface,
result/error, undo evidence; no complete-history claim from first50. Ownership/conflicts remain
separate summaries, not invented timeline events. Hosted runs and guardian episodes stay separate
source lanes with their own bounded labels and cursors. No merged global cursor or daily trend.

Mandate matrix rows=existing action classes, columns=granted level, workspace ceiling, guardian
cap (including irreversible cap where relevant), explanation. Missing class level defaults1 per
policy, never0. Show workspace switch, scope, limits, validity, working hours/outsideHours and
shadow separately; do not collapse to a “permission granted” badge. Null mandate → No active
mandate, not empty level0. B6 is required to avoid current P+2M fan-out; no draft-as-active inference.
Credentials: kind, since, copy identifier; no token/secret values or last-used timestamps invented.

Comparison: small multiples with common scales per same-unit metric, from one compare result;
period totals, not trends/ranking. Unknown AI cost remains unavailable; known cost labelled USD.
Respect truncated and goalsMet/goalsTotal; do not count unknown goals as unmet. Never add broadcast
people and direct messages. No historic mandate matrix, causal ranking or outcome daily series.

1440: Overview tiles4 columns and decision bars; Activity main/context; matrix full main width;
comparison2 columns. 768 tiles2 columns, matrix wraps by action. 390 tiles/comparison1 column,
Pause visible beneath title without menu, timeline vertical, matrix stacked labelled rows.

## Data states and access

Apply the README shared contract in full. Loading: section-sized skeleton and aria-busy;
empty: keep period/filter controls and explain no recorded activity; observed zero: numeric 0
only when explicitly returned by a successful read; null/missing: em dash and Unavailable;
suppressed: em dash and server k/notes, never infer hidden values. Partial failures stay local
with Retry; stale responses cannot replace a newer selection. On refresh remove current-value
claims from old data. Restricted sections issue zero reads and contain no hidden payload.
Not found is distinct from empty. No event timestamp means “Latest event in period: Unavailable”;
operational reads may additionally show “Computed at” or “Checked at”. Never render epoch dates.

## Keyboard, focus and chart alternatives

Native labelled controls; 40 px targets; visible 2 px accent focus with 2 px offset. Tabs use
arrow keys/Home/End and roving tabindex; Tab enters the selected panel. Filter changes retain
focus and announce completion politely. Retry retains focus; pagination moves focus to the
list heading after success and announces rows shown. Dialog Escape returns focus to its trigger.
No hover-only values: every chart has a named figure, units, textual summary and visible table
below from the same returned values, including missing/suppressed cells. Keyboard-accessible
legend toggles never remove data from the table. No smoothed lines, mixed-unit axes or silent
zero fill. Dates and numerals wrap; tables become labelled row stacks on phones. Use v2 viz
colours with markers/dashes and labels; colour alone conveys nothing.

## Tests the build must add

Add request-spy tests for the exact budget above, zero denied reads and no per-row requests;
loading, empty, observed zero, null, suppression, local error/retry, stale-response and not-found
fixtures. Assert period/denominator/freshness captions, no raw keys/ids outside copy controls,
and chart/table parity. Add both-theme 1440/768/390 screenshots and axe coverage via integration
ownership; manual keyboard, focus return, 200% zoom and screen-reader checks are required.
Tests listed below are additional surface-specific acceptance, not replacements for these checks.

Test one-click Pause for admin across every tab and list at390; viewer issues no mutation; failed pause retains active; no mandate fan-out; level default1; null outcomes/unknown AI cost and mixed people/message units; activity cursor vs closed report period.

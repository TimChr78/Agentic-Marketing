# Wave 5 data inventory

Research for #435, Phase 23; checked 2026-11-05 against
[the Wave 5 plan](../architecture/roadmap-wave-5.md). This is a read-path inventory,
not a proposal for new product capabilities. Command names below are registered in
[`apps/server/src/registry.ts`](../../apps/server/src/registry.ts); the
[MCP catalogue](../../.claude/skills/agentic-marketing-mcp/references/tools.md) is the
index, and the linked schemas and handlers are the authority for inputs, outputs and cost.
In particular, catalogue descriptions alone do not establish pagination, counting units,
or freshness. No code changes accompany this document.

## Reading the inventory

- **(a) UI-only:** existing reads suffice, including presentation, composition, explicit
  unavailable states and bounded lists linked to their full destination.
- **(b) Small read-only server addition:** existing rows/events and existing rules suffice;
  precise candidate contracts B1–B7 appear below. These are proposed, not registered commands.
- **(c) New storage or semantics:** cut or defer in this wave. A different name on an
  unsupported state does not make that state exist.

Costs distinguish client round trips from server work. “One call” can still mean several
Postgres queries and expensive ClickHouse `FINAL` scans. N means objects, P means pages,
M means mandate artifacts, J means journeys with controls, and G means mandate goals.
No latency estimates were measured. All reads must retain workspace RLS and the existing
command permission; a Home aggregate must not bypass `profiles:read` or `audit:read`.
`workspace.get.you.permissions` supports role-aware ordering and hiding inaccessible cards,
not granting access ([workspace implementation](../../packages/artifacts/src/workspace.ts)).

For analytics, use a fixed explicit period and workspace time zone. The common result is
`columns[{name,kind,unit}], rows, meta{timeZone,currency,from,to,freshness,suppressed,k,notes}`.
`freshness` is the newest event **in the selected range**, not pipeline health or query time.
Null is unavailable, never 1970. The current `segment.members` Postgres query is the exception:
its freshness is computation time, not an event timestamp. Non-time breakdowns suppress groups below k=5; do not replace
suppressed nulls with zero. Ratios are recomputed from bases, not averaged. Query inputs allow
at most 10 measures, 3 dimensions, 5,000 rows and 400 days; measures from different sources
need separate queries. The cache is 60 seconds. See
[`query.ts`](../../packages/analytics/src/query.ts),
[`registry.ts`](../../packages/analytics/src/registry.ts) and
[`compile.ts`](../../packages/analytics/src/compile.ts).

Fetched/computed time may be displayed for operational Postgres reads, but must not be labelled
“latest event.” Where an existing report drops event-freshness metadata, label it unavailable.
Across screens choose one counting contract: analytics e-mail measures count distinct **people**,
whereas `broadcasts.status.messages` and `messages.stats.counts` count distinct **messages** per
event type. Daily distinct people cannot be summed to obtain period distinct people.

## Home — Phase 24

| Surface | Existing feed and output fields | Enough as-is? Cost and gaps |
|---|---|---|
| Needs me: reviews and holds | `approvals.list({status:'pending',limit})`: `approvals[].id,artifactId,artifactName,artifactType,version,requester,note,createdAt,holdUntil,reviewUrl,bundle,artifactLatestVersion,artifactPublishedVersion`. `system.status({}).pendingApprovals` counts pending rows. | **(a)** One list call plus one count call; ordinary Postgres joins. Split holds using `holdUntil !== null`; group bundle members into one task. Count is approval rows, not distinct bundles or “tasks assigned to me.” List max 200, default 50, no cursor: show “oldest pending requests,” not a complete personal inbox. A held request remains pending after its window until executed/rechecked; do not mark it completed from the clock. |
| Needs me: alerts and guardian intervention | `alerts.list({}).rules[]`: `id,name,kind,enabled,state,firingSince,config`; optional `alerts.history({ruleId,limit}).events[]`: `value,threshold,window,firedAt,resolvedAt,notified`. `agents.list({}).agents[].guard`: `cap,irreversibleCap?,reason,since,episodeIds`. | **(a)** Two calls for open alerts/guard cards; optional history per selected alert. These are existing conditions, not new assigned tasks. Alert list is unpaged. A guardian cap is not the same as agent pause or a specific held approval. |
| Needs me: failed runs | `agents.list` supplies agent ids; `agents.hostedRuns({agentId,limit,before})`: `hosted`, `runs[].id,status,startedAt,finishedAt,summary,error`, `next`. | Functionally possible with 1+N calls, but looking at one recent page per agent can miss failures. **(b) B2** provides a bounded workspace failure list. Describe rows as recent failures, not unresolved incidents: there is no acknowledgement/recovery lifecycle. **(c)** Defer that lifecycle. Journey failures already appear in `journeys.stats.now.failed` and configured alerts; there is no universal “all background jobs” command. |
| Running: broadcasts | `artifacts.list({type:'broadcast',cursor})`: `artifacts[].id,name,latestVersion,latestState,publishedVersion,updatedAt,total,nextCursor`; `broadcasts.status({artifactId})`: `run.status,sendAt,startedAt,finishedAt,error,queued`, `stage`, `messages`. | P+N calls plus N ClickHouse status scans. Filtering a page of artifacts locally cannot find all scheduled work. **(b) B1** supplies state filtering/order without loading every report. |
| Running: journeys | `artifacts.list({type:'journey',cursor})`: published pointer and draft state; `journeys.stats({artifactId})`: `now.ready,waiting,failed,completed,exited,converted`, `waitingAt`, `reached`. | **(a)** Published journeys as a bounded recent list; P calls for all published pointers, +N Postgres/ClickHouse calls if counts are displayed. Defer counts on Home if too expensive; keep them on the Report tab. Published means live for enrollment, not evidence of active participants. **(c)** No independent journey paused/stopped state is stored by this command layer. |
| Running: agents | `agents.list`: `agents[].id,name,status,statusReason,guard,last24h,credentials`; hosted details via `agents.hostedRuns.hosted.running,enabled,nextRunAt,lastRunAt`. | **(a)** One inventory call; +N hosted detail calls only if needed. Active is permission to act, not currently executing. Home can say “active agents” without loading schedules. “Held” is a badge from approvals/guard, not a persisted fourth agent status. |
| KPI tiles | `analytics.query({measures:['email.sent','email.delivered','email.clicked','email.click_rate'],dimensions:[],from,to})`; separate query for `conversions`/`revenue` if selected. `deliverability.health` for an operational warning tile. | **(a)** One ClickHouse call for e-mail totals; another for prior period; separate source query for conversions. Keep the minimal Home to these supported measures. Reuse the same period, filters, unit and denominator on reports. Do not derive a global People count from consent totals; use B3 if that tile is chosen. |

Sources: [approvals and artifact lists](../../packages/artifacts/src/commands.ts),
[status](../../packages/artifacts/src/workspace.ts), [alerts](../../packages/alerts/src/commands.ts),
[agents](../../packages/auth/src/agents.ts), [hosted runs](../../packages/auth/src/hostedAgents.ts),
[broadcasts](../../packages/audience/src/broadcasts.ts), [journeys](../../packages/journeys/src/commands.ts).
A bounded Home needs no new dashboard storage or orchestration command.

## Broadcast list and report — Phases 24–25

### Operational list

`artifacts.list` provides publication state, pagination and an accurate artifact `total`, but
neither operational state nor schedule/audience/result. `artifacts.get({artifactId,version})`
adds `version.content` (broadcast `segment,template,sendAt,sendWindow,subjectTest,stagedSend`),
`references`, `latestVersion` and `publishedVersion`.
`broadcasts.status` returns:

- `run{status,version,sendAt,recipients,queued,skipped,windowSkipped,startedAt,finishedAt,error}`;
  statuses are `not_scheduled|scheduled|running|done|cancelled|failed|stopped`.
- `messages`: event-type to distinct-message count since the run's creation.
- `test`: sample state, variants with `sent,delivered,opened,clicked,clickRate,openRate`, winner,
  decision times and reason; null without a subject test.
- `stage`: canary stage, counts, rates, thresholds, check times, `checkSkipped,stopReason,stoppedAt,
  resumedAt,completedAt`; null without a staged send.

Enough for a single detail **(a)**: one status call, Postgres reads plus ClickHouse messageStats,
plus variant-result work where applicable. A list is P+N status calls (+N definition reads if
needed), and the result scans are unnecessary for finding scheduled work. **(b) B1** is the
recommended list read.

Operational labels are **(a)** only where backed by these facts: `scheduled` → scheduled,
`running` → preparing/sending, `done` → send preparation finished, `stopped` with stage reason →
stopped after canary check, and `failed` → failed/blocked with error. `done` means messages were
queued; do not claim all delivered, or even all provider sends completed, while queued messages
remain. A queued stream pause needs actual policy/message evidence. Publication `latestState`
may say in review while the published version's old run is sending; show both version contexts.
`cancelled` must stay visible even though the plan's short vocabulary omits it.
**(c)** A new resumable broadcast pause state is outside scope; `broadcasts.continue` resumes a
staged stop, not arbitrary cancellation. See [broadcast handler](../../packages/audience/src/broadcasts.ts),
[definitions](../../packages/artifacts/src/types.ts) and
[delivery policy](../../packages/email/src/policy.ts).

Audience at compose/review time is `broadcasts.preview({artifactId,version,templateVersion?})`:
`audience,checked,wouldSend,wouldSkip,sendAt,sendWindow,subjectTest`. It is **one expensive call**:
a membership count, up to 2,000 membership reads, and serial gateway checks per person.
`wouldSend` is eligible **among checked members**, not the full eligible audience when
`checked < audience`. **(a)** Display the cap and skip reasons; do not extrapolate or run this
for every list row. Run `recipients/queued/skipped` are execution facts with different meanings.
**(c)** A frozen, exact approval-time eligible audience or guaranteed future reach would need
snapshot/execution semantics; defer. The planned summary should say “eligible in current check”
and show the checked denominator. An exact full-audience uncapped scan is not a small cheap read.

### Report

| Question | Feed, fields and cost | Sufficiency / classification |
|---|---|---|
| Delivery, opens, clicks and unsubscribes over time | `analytics.query` with `filters:{broadcast:id}`, `dimensions:['day']`, explicit `from,to`; measures `email.sent,delivered,bounced,complained,opened,clicked,unsubscribed` (with `email.` prefix). One ClickHouse report call; add one dimensionless totals call and two equivalent calls for comparison if shown. | **(a)** Sufficient. `analytics.emailPerformance({from,to,by:'day'})` has no broadcast filter and is workspace-wide: use query for detail. Show opens only as tracked opens, never infer no opens from disabled tracking. `system.status.emailProvider.tracking` is current provider capability, not a historical tracking record. Missing historical coverage → unavailable/qualified, not zero engagement. |
| Rates and summary | `analytics.query` using `email.click_rate,open_rate,unsubscribe_rate` plus their bases; max 10 measures per call. `broadcasts.status` for A/B and canary outcomes. | **(a)** Click/open/unsubscribe rates use delivered people; bounce/complaint use sent people. Status variant/canary rates are percentages of sent messages, not the same rates. `messages.stats` is not a broadcast detail replacement: its `journeyId` input only accepts `jrn_…`. Its description about no pixels also lags the opened event/analytics implementation. |
| Top links | Message events store `url`; `messages.list` returns events with `type,at,reason,url`, but has no broadcast filter and only fetches up to 1,000 events for a returned page. Analytics has no URL dimension. | **(b) B4**. No exact ranking can be made by sampling message pages. One scoped grouped ClickHouse query over existing events is enough; no link-history storage. |
| Holdout uplift | `campaigns.of({artifactId}).campaigns[].id,name,role,goal`; for a campaign with a control, `campaigns.holdoutResult({campaignId,from,to})`: `control,treatment` (entered/converted/unsubscribed/rates/revenue), `absoluteLift,relativeLift,ci95,minSampleSizeMet,verdict,note`. | **(a)** Two calls, second heavy: assignments plus conversion/event attribution. Show explicitly **campaign-wide** lift in the broadcast report. **(c)** Broadcast has no own control-group definition or standalone holdout report; a subject test is not a no-send control. Cut standalone/per-broadcast causal lift, rather than relabel a campaign result. |

Sources: [analytics reports](../../packages/analytics/src/reports.ts),
[metric catalogue](../../packages/analytics/src/registry.ts), [messages](../../packages/email/src/messages.ts),
[event queries](../../packages/events/src/clickhouse.ts),
[campaign membership and uplift](../../packages/campaigns/src/campaigns.ts).

## Approval consequence summary — Phase 25

`approvals.get({approvalId})` already returns the exact reviewed `version,content`, publication
pointers, `artifactLatestVersion`, `publishedContent`, `diff{from,to,changes}`, `history`,
requester/note, `holdUntil`, and `bundle{id,members[{approvalId,artifactId,artifactName,
artifactType,version}]}` in publish order. This is **one Postgres call** with several joins/reads.
It is sufficient **(a)** for “what publishes,” stale-version notice, bundle members and diff.
Each bundle member's content requires its own `approvals.get` or version-pinned `artifacts.get`.
`artifacts.get.references` names referenced ids; fetching the pinned template/segment supplies
names and published-version facts. Cost: 1 + O(bundle members + dependencies) calls.

For a broadcast, add `broadcasts.preview` at the **reviewed** version and, if its template is
in the same bundle, pass that member's `templateVersion`. Use reviewed content for schedule;
show immediate versus scheduled and recipient-local send windows without inventing an ETA.
A reviewed segment change can make a pre-publication membership preview differ from eventual
membership: label this limitation. Preview does not simulate the whole bundle's future audience.
`templates.preview({artifactId,version})` supplies `subject,html,text` for the exact template;
`templates.check` returns `findings` (severity/category/location/fix), `summary` and `checkedAt`. Provider coverage
comes from `system.status.emailProvider`, domain evidence from `sendingDomains.list`.
These are **(a)** compositions, with expensive preview checks loaded on the review detail only.

`publishImpact` in [impact.ts](../../packages/artifacts/src/impact.ts) is an internal policy
estimator (`people,summary,touches,learning`), **not** an approval read command, and its people
estimate is not eligible recipients. Do not call a publish command to obtain a summary.
The existing [`checkBundlePublishable`](../../packages/artifacts/src/commands.ts) performs
savepoint writes/rollback; it is not a new read-only UI endpoint. **(c)** Cut guarantees about
future eligibility or simulated bundle side effects. Four-eyes/policy rules remain authoritative
in `approvals.approve`, not inferred from a new summary. No new server summary is necessary.

## Analytics presets — Phase 26

All presets are **(a)** fixed UI configuration; no saved-view storage. `analytics.metrics.list({})`
returns `measures` (id, unit, source, aggregation, dimensions and ratio bases where applicable)
and `dimensions` for the label registry/picker. Reuse it once, not per chart.

| Preset | Query contract | Cost and limits |
|---|---|---|
| Newsletter performance | `analytics.query` with e-mail measures above, day/week dimensions and selected broadcast/template filters; `analytics.emailPerformance({from,to,by:'broadcast'|'template'|'day'})` for the unfiltered named report. | One call per series/totals selection, another for comparison; named report requests all 12 supported e-mail measures internally even though public query caps input at 10. Keep table/chart on the same result. Non-time groups can be suppressed. |
| Journey conversion | `analytics.query` for `journey.entered,journey.goal_reached,journey.completed,journey.exited,journey.failed` by day and optional journey filter; divide goal reached by entered only with a labelled participant denominator. `analytics.journeyFunnel` for a selected journey. | One ClickHouse time-series call + one totals call per period; funnel is two metric queries. These are events occurring in the period, not an entry cohort's eventual conversion. Goal events and entry counts need not form a monotone cohort funnel. |
| Deliverability | `analytics.query` for `email.sent,email.bounced,email.complained,email.bounce_rate,email.complaint_rate` by day, filters channel/purpose; `deliverability.health` for current enforcement. | One ClickHouse call per period, plus one health call. Analytics is distinct-person event-date data; enforcement is current message status over creation-date windows. Overlaying enforcement thresholds as if these were the same denominator is misleading; B5 supplies a matching operational trend. |

General conversions and revenue require their event source/conversion map queries; campaign
attribution requires `campaign.*` measures, not arbitrary joins in the UI. Period comparison is
two identical queries with different bounds. No (b) preset engine is needed. **(c)** Persisted
views, segment history/overlap and cohort-retention semantics remain deferred per the plan.

## Journeys: Report, canvas and funnel — Phase 26

`journeys.stats({artifactId})` is enough **(a)** for live canvas `waitingAt[node]` and all-time
`reached[node]`, plus `now{ready,waiting,completed,exited,failed,converted}` and
`duplicatesSkipped,missingKeySkipped`. One call = grouped Postgres participant query + skip
query + ClickHouse `journeyCounts`. `reached` takes the max of distinct step/resumed counts;
it is not a count of visits and not period-filtered. Label all-time counts separately from
current participants. Join node ids to the appropriate `artifacts.get.version.content.nodes`
labels; never silently map historic nodes to a newer draft's topology.

`analytics.journeyFunnel({journeyId,from,to})` returns
`entered,goalReached,completed,exited,steps[{step,reached,dropOff,dropOffRate}],meta` in one call
(two ClickHouse-backed queries). `analytics.query` with `journey.step_reached` and
`dimensions:['journey_step']` is also available. The compiler orders steps via event sequence;
that is not proof that a branched or looping graph has a single funnel path. **(a)** Use bars or
node counts for those graphs, with nulls for suppressed steps. Only show a funnel where a
linear graph and compatible period make sequential comparison meaningful; counts are distinct
participants per event type, not a persisted entry-cohort ledger. **(c)** Defer universal
path/cohort funnels and negative-drop-off “repairs” based on invented ordering.

Conversion/control result: `journeys.holdoutResult({journeyId,from?,to?})` supplies arm
`entered,converted,unsubscribed,conversionRate,unsubscribeRate`, `absoluteLift,relativeLift,
ci95,minSampleSizeMet,verdict,note,controlGroup`. One heavy call over assignments/events;
missing control means unavailable, not zero lift. Campaign-controlled journeys must use the
campaign result. `journeys.splitResult` already covers split arms when that experiment is wanted.

The [journey definition](../../packages/artifacts/src/types.ts) has graph/purpose/goal/control,
not a pause flag. There is no registered `artifacts.unpublish` command. The internal
`unpublishArtifactVersion` helper used by undo removes publication; the
[unpublish implementation](../../packages/artifacts/src/commands.ts) says it stops new entry.
**(c)** Distinct resumable pause versus terminal stop semantics must be cut/deferred, not inferred
from an empty queue. Draft/live plus current participant counts are supported as-is.
Sources: [journey commands](../../packages/journeys/src/commands.ts),
[funnel wrapper](../../packages/analytics/src/reports.ts), [event counts](../../packages/events/src/clickhouse.ts).

## Deliverability: states, trends and DNS — Phase 26

`deliverability.health({})` returns `windowDays`,
`thresholds{complaintWarn,complaintStop,bounceStop,minVolume}`, `autoPause`,
`email.marketing/transactional` and `sms.marketing/transactional`, each with
`sent,bounced,complained,bounceRate,complaintRate,status,reason`, plus `brand.linksUrl,linksHost`.
One call, four grouped **Postgres** stream queries, not ClickHouse.
[`streamRates`](../../packages/email/src/policy.ts) counts non-test messages whose **current**
status is sent/delivered/bounced/complained, created within the rolling policy window,
classified by currently published purpose basis. A delivered message later complained belongs
to the complained bucket; sent is the sum of these statuses, not just rows with status sent.

Data-state mapping is **(a)**: `sent===0` → no data; `sent<minVolume` → below evaluation volume;
then warn/ok from the returned status. `status==='paused'` indicates a stop threshold, but actual
policy pausing applies to marketing when `autoPause` is true. With autoPause false or a
transactional stream, say “above stop threshold,” not “sending paused.” Rates of zero at no
volume must not render a green healthy state. Show sample size, denominator and window beside
the current threshold. No backend state-enum change is needed.

A truthful **operational** trend with the same denominator needs **(b) B5**. Existing analytics
can show a separately labelled e-mail event trend now; it cannot reproduce current streamRates
with `email.*` measures, nor recover past policy configuration/pause decisions. **(c)** Historical
policy-state charts, exact historical threshold lines and DNS history require historical
semantics/storage and are deferred. B5 compares recalculated message-creation cohorts under
current configuration; it does not pretend to be archived health readings.

DNS cards use `sendingDomains.list({dkimSelectors?})`:
`checkedAt,domains[].domain,uses,ok,spf{ok,record,advice},dkim[{selector,ok,record}],
dmarc{ok,record,advice,policy}`. **(a)** One call with external DNS lookups per domain/selector
(3-second resolver timeout); load independently from metric polling. No selectors means DKIM
was not checked, not “DKIM healthy.” DNS errors collapse to missing records in this implementation;
show check advice/limitations, not a claim of DNS history or complete authentication success.
Source: [deliverability commands](../../packages/email/src/deliverability.ts).

## Agents — Phase 26

| Surface | Existing contract | Sufficiency and cost |
|---|---|---|
| Overview / credentials | `agents.list` or `agents.get({id})`: `id,name,description,sponsor,status,statusReason,statusChangedAt,credentials[{kind,id,since}],guard,last24h{changes,denied,escalated,held}`. `agents.hostedRuns.hosted`: `schedule,scheduleText,timeZone,enabled,running,budgets,consecutiveFailures,lastRunAt,nextRunAt`. | **(a)** One inventory/detail call, plus one hosted call for a selected agent. Agent status is active/paused/revoked; guard and holds are additional evidence. Pause controls use existing `agents.pause`; no execution semantics added. |
| Activity timeline | `agents.activity({agentId?,decision?,actionClass?,since?,before?,limit})`: `actions[].id,agentId,command,actionClass,decision,mandateId,mandateVersion,intent,reasons,impact,ok,error,target,surface,at,undoable,undoBlockedBy,undoneAt`, `next`; with agent id also `ownedArtifacts,heldConflicts,contactPressureSkipped`. `agents.guardian({agentId})`: `guard,episodes`; `agents.hostedRuns`: run timeline above. | **(a)** One call per ledger page; add guardian/hosted sources as separate typed lanes. Activity uses stable numeric ids; hosted pagination is timestamp-only. Polling `agents.events` is subscription/event notification data, not a substitute for the action ledger. A bounded merged display is possible, but no claim of a globally paginated complete timeline across these streams. |
| Decision breakdown | `agents.report({agentId,from,to})`: `actions[actionClass]{allow,hold,ask,deny,failed}`, `undone,guardian`, coordination fields. | **(a)** One call; Postgres grouped ledger/guardian queries, but also computes outcomes with ClickHouse. Do not aggregate only the first activity page. Failed excludes denials; denied writes roll back and are recorded `ok:false`, so naive `!ok` overcounts failures. |
| Mandate matrix | `artifacts.list({type:'agent_mandate',cursor})` + version-pinned `artifacts.get`: published content `agent,levels,scope,limits,guardrails,validUntil,workingHours,blackoutDates,shadow,goals`. `workspace.autonomy` supplies workspace switch, ceilings and limits; agent guard supplies caps. | **(a)** P + up to 2M reads (latest and published differ), plus autonomy and agent reads; **(b) B6** avoids loading all mandate drafts and repeating policy selection. Missing class level means 1, not 0. Render granted levels, workspace ceilings, guard caps and scope separately; a level alone is not permission to execute a particular action. |
| Outcome / goal tiles | `agents.report.outcomes`: nullable `broadcasts` and `direct` with `count,sent,opened,clicked,unsubscribed,complained,bounced`; `journeys[{id,verdict,note}]`; `goals[{measure,target?,direction,value,met,note}]`. | **(a)** One report call, but outcome service adds one broadcast metrics query, direct-message stats, J holdout computations and up to G metric queries. No outcomes service/no relevant artifacts/unsupported goals yields nulls or notes; show unavailable. Goals measure this agent's broadcasts, not all workspace activity. Report has `from,to` but no event freshness; disclose unavailable, display computed time separately. |
| Comparison / small multiples | `agents.compare({agentIds?,from?,to?})`: `from,to,agents[].agentId,name,status,outcomes,goalsMet,goalsTotal,guardian{caps,episodes},ai{calls,inputTokens,outputTokens,cost},mandates[]` with mandate id/version/active/validUntil, action tallies, undos, `holds{rejected,ran,pending}`. | **(a)** One potentially heavy call: per-agent Postgres work and the full outcome work above. Use explicit agent selection (input max 50), lazy-load comparison, avoid Home polling. Cost null means unknown model price. These are period totals; small multiples can be bars. True daily outcome/decision time series would require more reads/aggregation; **(c)** do not promise historic mandate state or causal cross-agent ranking from these totals. |

Sources: [agent schemas and aggregation](../../packages/auth/src/agents.ts),
[hosted agents](../../packages/auth/src/hostedAgents.ts),
[server outcome implementation](../../apps/server/src/agents/report.ts),
[active mandate selection](../../packages/artifacts/src/mandates.ts),
[current UI's mandate fan-out](../../apps/web/src/features/agents/MandateCard.tsx).
Broadcast outcomes use distinct-person analytics, direct outcomes use distinct-message stats;
keep separate lanes/denominators rather than adding them. Publishing/ownership-based attribution
is the existing operational report contract, not proof of incremental agent impact.

## People — Phase 26

- **Pagination — (a):** `profiles.list({limit,before,beforeId})` already returns
  `profiles` and `nextCursor{lastSeen,id}|null`. Pass both cursor parts unchanged; retain
  microseconds and use a cursor stack for Back. One call per page, max 200; Postgres list/consent
  subqueries plus identifier reads/decryption where permitted. The current
  [PeoplePage](../../apps/web/src/pages/audience/PeoplePage.tsx) simply asks for 50 and labels
  the loaded length “people.” This is not a missing pagination backend.
- **Accurate total — (b) B3:** list has no total. `consent.summary` reports purpose/channel
  status counts and topic choices, not all profiles; adding purpose totals double-counts people
  and excludes those with no consent record. Do not page through the whole population to count it.
- **Identity and consent — (a):** each list row has `id,traits,known,email,firstSeen,lastSeen,
  consent[{purpose,status}]`. `email` is null without PII permission. `purposes.list` supplies
  purpose key/name/basis/channel configuration; label each purpose and raw consent status.
  A missing record is not automatically refusal or allowance: use lawful basis rules when
  displaying eligibility (`purposeAllowed` in [consent.ts](../../packages/profiles/src/consent.ts)).
  `profiles.get({profileId})` supplies `personal,identifiers,consent,mergedFrom` for detail;
  do not fetch it per list row just to repeat e-mail. Names requiring hidden personal data remain hidden.
- **Profile timeline — (a), with bounded completeness:** `profiles.events({profileId,limit,
  before,beforeId})` returns `events[{eventId,type,name,timestamp,properties,context}],nextCursor`;
  one ClickHouse call after canonical-profile/identifier queries. `messages.list({profileId,
  limit,cursor})` returns messages with `createdAt,status,reason,attempts,lastError,notBefore,
  nextAttemptAt,test` and `events[{type,at,reason,url}],nextCursor`; one Postgres page plus a
  ClickHouse fetch capped at 1,000 events for the page. `consent.history({profileId})` returns
  all `records[{purpose,channel,status,basis,source,proof,recordedAt,recordedBy}]`, oldest first,
  including merged profiles. Three calls for the initial lanes, then separate pagination for
  events/messages; consent is unbounded. UI can interleave loaded entries and expose “load more”
  per source; it cannot claim one globally complete event cursor. `messages.list` filters the
  literal profile id, unlike the merged-family consent ledger: a current-profile message lane
  must say so, or query each `mergedFrom` id (1+N message pages). A complete scalable merged
  timeline/consent cursor is not necessary for the bounded Wave 5 version; **(c)** cut any claim
  of unlimited, single-cursor history. No new timeline storage is warranted.

Sources: [profile commands](../../packages/profiles/src/commands.ts),
[message commands](../../packages/email/src/messages.ts), [event store](../../packages/events/src/clickhouse.ts).

## Campaign roll-up — Phase 26

`analytics.campaignSummary({campaignId,from?,to?})` is already the roll-up. It returns either:

- `state:'not_started',goal,readiness{published,membersPublished,sendingMembers,
  publishedSendingMembers,sendingMembersScheduled},meta`; or
- `state:'measured',goal,headline{recipients,delivered,clickers,unsubscribers,complaintRate,
  unsubscribeRate,converters,conversionRate,revenue[],revenuePerRecipient[],targetProgress},
  funnel[{step,count,stepRate,shareOfRecipients}],members[{artifactId,name,type,role,sent,
  delivered,clickRate,unsubscribeRate,converters}],holdouts[],meta`.

**(a)** Enough as-is, one **heavy** call: campaign/member/readiness Postgres reads, sent-existence
check, three metric queries (attributed campaign recipients/conversions, e-mail, revenue),
member attribution query and J journey holdout computations. Attribution joins sends to
conversion events, not just a sum of member counters. `campaigns.members` adds member
publication status and `lastSendAt`; `campaigns.holdoutResult` adds campaign-wide control uplift
where configured. `campaignSummary.holdouts` are journey controls, not the campaign control.
For a campaign list, N summaries are N heavy reports: show roll-up on the campaign detail and
load selected summaries lazily rather than inventing a new cached roll-up pipeline.

The readiness/not_started branch is essential. Preserve per-currency revenue and null target
progress. Complaint/unsubscribe headline rates here divide by delivered, whereas the general
analytics complaint rate divides by sent. The recipient → delivered → clicked → converted
sequence is an attribution summary; converters need not have clicked, so it is not necessarily
monotone. Do not imply click-conditioned conversion or repair the counts. **(c)** Cross-channel
unified revenue attribution and historical campaign-membership snapshots are outside this report
and deferred. Sources: [summary](../../packages/analytics/src/campaignSummary.ts),
[attribution compiler](../../packages/analytics/src/campaign.ts),
[membership and holdouts](../../packages/campaigns/src/campaigns.ts).

## New-brand onboarding checklist — Phase 24

This is **(a)** derived UI state, not persisted checklist completion:

| Check | Existing feed / exact fact | Cost / qualification |
|---|---|---|
| Brand configured/published | `workspace.get.brand` for published brand summary; `artifacts.list({type:'brand'})` for `publishedVersion`, optionally `artifacts.get.version.content` for required brand fields. | 1–3 Postgres calls. A generated draft brand from workspace creation is not proof the brand is finished. |
| E-mail configured | `system.status.emailProvider.{marketing,transactional,configured}`. | One cheap call, safe without provider admin permission. Configuration is not a successful send. |
| Domain ready | `workspace.get.domains,linksUrl`; admin-only `workspace.domains.list` for domain management; `sendingDomains.list.checkedAt,domains` for sending DNS evidence. | Workspace call plus DNS call; brand link-domain verification and sending SPF/DKIM/DMARC are different checks. Empty selectors means DKIM unverified. |
| Purposes reviewed / content ready | `purposes.list.source,purposes`; `artifacts.list({type:'purposes'|'template'|'form'|'segment',limit:1})` per selected checklist item gives published pointer/latest state. | One purposes call + one per type; `source:'default'` is allowed configuration, not proof a person reviewed it. A recent first row alone cannot prove **any published** artifact exists; follow pages until found or label the visible artifact only. |
| Audience present / first send | B3 total if needed; otherwise `profiles.list({limit:1}).profiles.length>0` proves existence. `analytics.query` dimensionless `email.sent` over an explicit period proves observed sends in that period. | One profiles read (permission-gated) + one ClickHouse read. Zero within a limited period is not “never sent.” Do not require first send as a permanent checked milestone without an all-history contract. |
| Agent connected (optional) | `agents.list.agents[].status,credentials`. | One read, only for an agent-specific onboarding branch; not a required new-brand capability. |

The existing [Setup screen](../../apps/web/src/screens/Setup.tsx) is a legacy/mock screen with
hard-coded channel state, endpoint and provider text, not an onboarding aggregate. Derive new
checks from the commands above. No (b) checklist service is required. **(c)** Dismissal history,
“completed by,” permanently remembered first-use milestones and new tracking events are deferred.

## Candidate read-only additions (b): precise contracts

All commands below would have `effect:'read'`, retain tenant scoping, use parameterized queries
and existing permissions, and be exported through their package command array and the server
registry. Inputs/outputs here are proposed contracts, not descriptions of existing commands.
No new tables, materialized histories, policy decisions or permissions are proposed.

### B1 — `broadcasts.list` (operational rows)

- **Input:** `{limit:1..100=50,cursor?:string,statuses?:RunStatus[]}`; status filters use existing
  run enums, including `not_scheduled`, not invented UI pause states. Order by full-precision
  artifact updatedAt/id; filter before pagination/count.
- **Output:** `{broadcasts:[{artifactId,name,latestVersion,latestState,publishedVersion,
  updatedAt,run:{status,version,sendAt,recipients,queued,skipped,windowSkipped,startedAt,
  finishedAt,error},segmentId,templateId,stage:{stage,stopReason}|null}],total,nextCursor,asOf}`.
  Return `run` defaults as in status for never-scheduled rows; content uses the run's pinned
  version when present and declares that version. No per-row eligible-audience preview.
- **Location/reuse:** `packages/audience/src/broadcasts.ts`; factor the Postgres run/stage and
  definition projection out of `broadcasts.status`, reuse artifact keyset conventions in
  `packages/artifacts/src/list.ts` / `commands.ts`. Join runs/stages/versions in batches.
  Permission `artifacts:read`. No ClickHouse on the minimal list. Detailed results stay lazy;
  operational preparation counts are the initial list's result column.
- **Cost:** one client call, page + total queries with joins; no N report scans. If list design
  insists on delivered/click results, an explicitly separate grouped analytics query for visible
  broadcast ids adds one ClickHouse scan; do not silently fold N `status` calls into this command.

### B2 — `agents.runFailures`

- **Input:** `{since:ISO,limit:1..100=20,cursor?:string}`; bounded recent period, order by
  `(startedAt,id)` descending with a stable opaque cursor.
- **Output:** `{runs:[{id,agentId,agentName,startedAt,finishedAt,status:'failed',summary,error}],
  nextCursor,asOf}`. No unresolved count, acknowledgement or inferred recovery flag.
- **Location/reuse:** `packages/auth/src/hostedAgents.ts`; reuse the `agents.hostedRuns` projection
  and query over `hostedAgentRuns`, join agent names, filter `status='failed'` in SQL before
  pagination. Permission `artifacts:read`, matching hostedRuns; no instructions/credentials.
- **Cost:** one Postgres page call. Home says “recent failed hosted runs”; other worker failures
  remain their existing alerts/detail views.

### B3 — `profiles.list.total`

- **Input:** retain `{limit,before,beforeId}`; add `{includeTotal?:boolean=false}`.
- **Output:** retain `profiles,nextCursor`; add optional `total:number` only when requested.
  Count all canonical (unmerged) workspace profiles, known and anonymous, independently of
  the page cursor. The People header must describe this population accurately.
- **Location/reuse:** `packages/profiles/src/commands.ts`; reuse list's
  `isNull(profiles.mergedInto)` filter, execute `COUNT(*)` under the same RLS; no identifier join,
  decryption or consent join in the count. Permission stays `profiles:read` and audited behavior
  is unchanged. Request total on initial load/refresh, not every page.
- **Cost:** one extra Postgres count, potentially scanning the canonical population; not O(1).
  No global cache that mixes workspaces. This is preferable to a new count table.

### B4 — `analytics.broadcastLinks`

- **Input:** `{broadcastId,from:ISO,to:ISO,limit:1..100=10}`.
- **Output:** `{links:[{url,clickers:number|null}],meta:AnalyticsMeta}` ordered by clickers
  descending; `clickers` means distinct profile ids per URL, consistent with analytics people
  measures. Repeated clicks are not extra people. Apply k=5 suppression to link groups; never
  leak low-volume URL identities through a supposedly suppressed ranking.
- **Location/reuse:** `packages/analytics/src/reports.ts` plus a bounded report-query helper;
  reuse tenant/time/test exclusion, metadata and suppression conventions from `query.ts` /
  `compile.ts`. Existing `message_events.url,type,profile_id,journey_id,at` suffice; scope
  `journey_id= broadcastId AND type='clicked'`. Do not expand the arbitrary metric dimension
  catalogue just to expose raw personalized URLs. Retain existing URL redaction expectations;
  expose only safe non-personal link labels/URLs, omit unsafe groups rather than reveal PII.
  Permission `artifacts:read`.
- **Cost:** one grouped ClickHouse `FINAL` scan, plus freshness/suppression work as needed.
  If safe URL display cannot be established from the stored URLs without new semantics, cut
  the ranking for Wave 5 and link to existing authorized message inspection instead.

### B5 — `deliverability.trend`

- **Input:** `{from:ISO,to:ISO,channel:'email'|'sms',stream:'marketing'|'transactional'}`,
  max 90 daily points in workspace time zone.
- **Output:** `{points:[{day,windowFrom,windowTo,sent,bounced,complained,bounceRate:number|null,
  complaintRate:number|null}],windowDays,thresholds:{complaintWarn,complaintStop,bounceStop,
  minVolume},autoPause,timeZone,computedAt,semantics:'current_status_by_creation_window'}`.
  Each point uses the policy-length rolling creation window ending at that day's boundary;
  zero-volume rates are null. Include an as-of-now point if the chart compares its last value
  to health. Thresholds are explicitly today's policy, not historical values.
- **Location/reuse:** `packages/email/src/deliverability.ts` and `policy.ts`; factor the
  `streamRates` message filters and purpose-basis classification into a shared read helper,
  group current message statuses by creation day then compute bounded rolling sums. Reuse
  `deliveryPolicy` and published purposes. Permission `artifacts:read`.
- **Cost:** one bounded Postgres aggregate over the requested range plus window lookback;
  potentially heavy on large message tables, but no N daily full scans. Existing
  `messages_recent(workspace_id,channel,created_at)` supports the range. Read-only recalculation
  can revise previous points after late bounces/complaints; label that. Historic pause state is
  (c), and is not included.

### B6 — `agents.mandate`

- **Input:** `{agentId}`.
- **Output:** `{agentId,mandate:null|{id,version,content},outsideHours:string|null,asOf}`;
  `content` is the published `AgentMandate` shape already readable via `artifacts.get`.
  Workspace ceilings and guardian caps remain `workspace.autonomy` and `agents.get.guard`.
- **Location/reuse:** `packages/auth/src/agents.ts`, using existing
  `ctx.services.activeMandate` / `packages/artifacts/src/mandates.ts:activeMandate`.
  Reuse its published, unarchived, unexpired selection and working-hours calculation exactly;
  do not approximate policy with “latest draft.” If the service view omits full content, project
  the selected id/version through the existing artifact-version query. Permission `artifacts:read`.
- **Cost:** one call and a few Postgres reads; replaces P+2M client requests. This is convenience,
  not a prerequisite to displaying a granted-level matrix with existing reads.

### B7 — `approvals.list` completeness metadata

- **Input:** retain current filters and limit, add `{cursor?:string}` (createdAt/id ascending).
- **Output:** retain `approvals`, add `{total:number,nextCursor:string|null}` for the same
  status/artifact filter, independent of page cursor. `total` counts request rows including
  held rows; it is not a count of grouped bundle tasks. Preserve bundle-member resolution.
- **Location/reuse:** `packages/artifacts/src/commands.ts:listApprovals`, reuse its joins and
  requester/bundle helpers and the artifact-list full-precision keyset pattern. Permission
  `artifacts:read`. No assignment logic or new inbox storage.
- **Cost:** one extra count query per list request; bounded page joins. Optional for minimal
  Home, useful to avoid an incomplete Approvals destination after clicking “view all.”

## Prioritised (b) implementation list

Sizes follow the plan's working-session convention: S ≈ 1, M ≈ 2–3; XS is less than a session.
These are estimates including focused contract/query verification, not commitments.

| Priority | Candidate | Rough size | First phase needing it | Why / fallback |
|---|---|---|---|---|
| 1 | **B1 `broadcasts.list`** | M | **24** | Reference operational list and scheduled/sending Home without N heavy status queries. Single-detail reads already work. |
| 2 | **B3 `profiles.list.includeTotal/total`** | XS–S | **26** (24 only if Home shows People total) | Honest total; pagination itself is already (a). Until then say “loaded people,” not total. |
| 3 | **B2 `agents.runFailures`** | S | **24** | Home's failed-hosted-run queue without querying every agent. Can ship a bounded recent-error link first. |
| 4 | **B4 `analytics.broadcastLinks`** | S–M | **25** | Only missing basic broadcast report aggregate; safe URL handling and suppression are acceptance gates. Cut ranking if those cannot be met. |
| 5 | **B5 `deliverability.trend`** | M | **26** | Trend comparable to current policy denominator; label recalculated history. Separate event trends are available immediately. |
| 6 | **B6 `agents.mandate`** | S | **26** | Remove mandate fan-out and match policy's active selection. Existing artifact reads remain a functional fallback. |
| 7 | **B7 approvals pagination/count** | S | **24** for full queue; optional for bounded Home | Complete destination and honest counts. Minimal Home can show oldest requests and system pending-row count. |

Resolve the (c) scope decisions in Phase 23 screen contracts before mock-ups imply unsupported
states: no new broadcast/journey pause semantics, standalone broadcast controls, frozen audience
promises, universal cohort funnels, historic policy/DNS states, stored analytics views, or new
onboarding/timeline history. Most remaining work in Phases 24–27 is (a): composing existing reads,
labelling their actual units, handling permissions and rendering truthful empty/unavailable states.

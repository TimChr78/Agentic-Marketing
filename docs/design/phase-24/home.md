# Home · task H

Task: decide what to inspect next, not operate a new automation cockpit. `/` renders Home
for every signed-in role. Title “Home”; subtitle “MartechSignal · your brand at a glance”
using actual brand name. Header Refresh reloads permitted operational blocks together; New
broadcast link only artifacts:write. Sources and ownership: [README](README.md), inventory Home/B1/B2/B7.

## Order and composition

Role is used only to order blocks; permissions gate reads/actions. `marketer` is displayed as
Builder. Unknown/custom roles use viewer order; extra permissions do not create new role names.

| Role | Exact section order after header |
|---|---|
| owner / admin | Setup checklist (when applicable), Needs attention, Running, E-mail performance |
| marketer / builder | Setup checklist (when applicable), Running, Needs attention, E-mail performance |
| approver | Needs attention, Running, E-mail performance (no checklist) |
| viewer | E-mail performance, Running, Needs attention (no checklist) |

Needs attention is deliberately not “assigned to me”: there is no assignment feed. Within it:
Pending review, Holds, Firing alerts, Guardian caps, Recent failed hosted runs. Within Running:
Scheduled and sending broadcasts, Live journeys, Active agents. Keep headings even when empty;
never move a failing block to another section. Render each section in one surface with horizontal
separators, not nested outlined cards. At 1440 attention/running sublists form two equal columns,
KPI row four columns; at 768 sublists stack, KPI two columns; at 390 everything one column.
Page insets and gaps follow DESIGN v2 (32/24/16; sections 32/24/24); summary rows min 64px,
actions 40px on mobile. Long object names wrap; IDs use Identifier, not headings.

## Read contracts and bounds

A load shares workspace/system/agents/approvals calls between blocks. Freeze `now` and the
period at load; no polling while hidden. Initial load and explicit Refresh only on Home; no
per-agent runs/reports, journey statistics, broadcast previews/status or per-row message calls.
Each block loads/fails independently. No unsupported source is treated as an empty result.

| Block | Call and fields | Selection / limit / destination |
|---|---|---|
| Pending review + Holds | B7 `approvals.list({status:'pending',limit:20})`: approvals `id,artifactId,artifactName,artifactType,version,requester,note,createdAt,holdUntil,reviewUrl,bundle`; `total,nextCursor` | Oldest 20 request rows ascending; partition `holdUntil !== null` (Holds), otherwise review. Group members by bundle within loaded page; mark partially loaded bundle “More members in Approvals” if completeness unknown. Show max 3 groups per partition. Header “N pending requests” uses total across both, never sum of displayed tasks. Link View all → `/approvals`; each request → `/approvals/:id`, existing bundle resolution. Holds show holdUntil in workspace zone, even if time passed; say “Window passed; awaiting recheck”, never auto-complete. |
| Firing alerts | `alerts.list({}).rules`: id,name,enabled,state,firingSince,kind | Enabled rules whose state is firing, oldest firingSince first (null last), id tie; max 3. Show name + since, unknown since labelled unavailable. Link `/insights/alerts`. No history fan-out. |
| Guardian caps | `agents.list({}).agents`: id,name,status,guard.cap,guard.reason,guard.since | Any guard with numeric cap including 0; since ascending null last, id tie; max 3. Label “Guardian cap”, retain status separately via stateOfAgent. Link `/work/agents/:id`. Not a count of held approvals. |
| Recent failed hosted runs | B2 `agents.runFailures({since: now−7×24h ISO,limit:3})`: runs id,agentId,agentName,startedAt,finishedAt,status,summary,error; nextCursor,asOf | Returned descending startedAt/id; max 3. Copy “Failed in the last 7 days”, show started time + error/summary truncated to two lines (full text in detail). Link `/work/agents/:agentId` to existing hosted runs. Footer “More recent failures” when nextCursor, opens Agents; no unresolved total or dismiss/retry-run action. |
| Scheduled and sending broadcasts | B1 `broadcasts.list({statuses:['scheduled','running'],limit:5})`: artifactId,name,latestState,publishedVersion,run,stage,delivery,asOf,total,nextCursor | Returned updatedAt/id order (not claimed chronological send queue); max 5, label “Recently updated scheduled and sending broadcasts”. stateOfBroadcast row; schedule workspace zone; total counts matching broadcasts. Link canonical detail and View all `/marketing/broadcasts?status=active`. |
| Live journeys | `artifacts.list({type:'journey',limit:20})`: id,name,publishedVersion,latestState,updatedAt,nextCursor | Filter first returned page for publishedVersion !== null, show up to 3 in returned order. Label “Live journeys · recently updated sample”; if no matches and cursor exists say “No live journeys in this sample. View journeys”; do not claim globally empty/count. Link detail Report. Published means open to enrollment, not currently processing people. No stats fan-out. |
| Active agents | shared `agents.list`: id,name,status,statusReason,guard | Filter status active; sort name locale then id; max 3; total from full unpaged array, label “Active agents · allowed to act”. stateOfAgent may still show Held with guard. Link detail and all Agents. Never say “running now”. |
| Performance | `analytics.query({measures:['email.sent','email.delivered','email.clicked','email.click_rate'],dimensions:[],from,to})` fields columns/rows/meta | One current aggregate and one same-length previous aggregate only. Four KpiTile values; see below. All link `/insights/analytics?from=…&to=…`. No People total or conversion/revenue tiles in Phase 24. |

All table rows above except performance need artifacts:read. If not granted hide the block and do
not issue its read; empty whole section says “Your role cannot view operational work” with no count
and “Ask an admin for access”. No artifacts:approve: review links say “View request”, not “Review”.
Can approve: label Review; no inline approve/reject. Read-only viewer can inspect all permitted work.
No admin gate on safe system.status or DNS reads; admin-only provider/domain editors stay gated.

For every operational block: loading = fixed-height three-row skeleton + aria-busy and named Loading;
loaded empty = specific “No pending reviews” / “No held requests” / “No firing alerts” / “No guardian
caps” / “No failed hosted runs in the last 7 days” / “No scheduled or sending broadcasts” / sample
journey message above / “No active agents”. For reviews/holds, if B7 nextCursor exists and a partition is empty, say “No [reviews/holds]
in the oldest 20 loaded requests” and link Approvals; do not claim that partition is globally
empty. If total is zero both may say no pending requests. No green health check from empty data. Error = “Couldn’t
load [block]” plus Retry and safe errText; no zero count, retain other blocks. Refresh error may retain
last values explicitly “Last loaded [time]; refresh failed”, never as current. Operational fetch time
is “Fetched [time]”, B1/B2 `asOf` is “As of [time]”; not latest event. No invented stale threshold.

## KPI contract

Order: E-mails sent, Delivered, Clicked, Click rate; labels from lib/labels. Last 7 **complete local
calendar days**, from local midnight 7 days ago inclusive to today's local midnight exclusive,
workspace zone. Previous seven calendar days immediately before (DST may differ in hours).
Counts are distinct people per measure in the whole period, not messages or sums of daily uniques.
Click rate uses clicked people / delivered people; format ratio as percent to one decimal, comparison
in percentage points. Count deltas are relative percent to one decimal; favourable direction neutral
for volume counts, up for click rate (no healthy claim). Prior zero → “No comparable baseline”.
No sparklines: no daily query is needed. Counts format locale integers; full values available.

Map query metadata to existing KpiTile/DataStatePill: loading skeleton; error “Performance unavailable”
with Retry; suppressed null = “Suppressed · fewer than 5 people”, no delta; sent=0 valid observation
shows 0 sent/delivered/clicked and “No sends in this period”, click rate em dash without denominator.
Delivered>0/clicked=0 shows 0 and 0% with denominator. Missing measure/null non-suppressed = unavailable,
not 0. Prior error removes delta only. Show exact date range + zone, denominator for rate, freshness
from `meta.freshness` labelled “Latest event in period”; null says unavailable. A 60s cache is not a
staleness threshold. Do not create paused/below-volume/stale states without source evidence. No new
chart props: adapt to existing ui/charts.tsx API. Header and table text keep numerical semantics.

## Derived setup checklist

Only owner/admin/marketer, and only while at least one required check below is incomplete or unknown,
subject to local dismissal. No createdAt heuristic. No server completion, history, first-send flag,
new capability or Setup mock constants. Required four items in exact order:

| Item / destination | Exact detection |
|---|---|
| Publish your brand → `/content/brand` | Page through `artifacts.list({type:'brand',limit:100,cursor})` until a publishedVersion exists or exhausted. Published pointer is the completion fact; generated draft is incomplete. workspace.get.brand supplies display name/logo only. |
| Configure marketing e-mail → `/settings/providers` (workspace:admin), otherwise “Ask an admin to configure e-mail” | `system.status.emailProvider.configured && emailProvider.marketing`. Not proof of successful delivery. |
| Set up a link domain → `/settings/workspace` (workspace:admin), otherwise “Ask an admin to verify a link domain” | `workspace.get.domains` contains a verified primary domain per existing domain status; use the actual status enum in domains.ts, not linksUrl truthiness. linksUrl shown as effective URL, never proof of tenant verification. |
| Add your audience → `/audience/people?tab=imports` with profiles:write, otherwise People with profiles:read | `profiles.list({limit:1}).profiles.length>0`. No B3 total dependency. Missing permission = unknown/restricted, not incomplete or zero; no call. |

Domain clarification: `workspace.get.domains.some(d => d.status === 'verified' && d.isPrimary)` is the link-domain
check; sending DNS is **separate advisory**, after required items: “Review sending DNS” →
Deliverability. On opening that advisory, `sendingDomains.list({dkimSelectors:[]})` supplies
`checkedAt,domains` SPF/DMARC evidence; DKIM is unverified without selectors. Advisory never blocks
completion and is not a new permanently completed milestone. Purposes defaults are not evidence
of human review; content publication and first send are intentionally not checklist requirements.

Checklist heading “Set up MartechSignal”, progress “2 of 4 confirmed”, incomplete rows are links,
completed rows get Check and “Confirmed from current configuration”. No manual checkboxes.
Loading leaves row “Checking…”; failed row “Couldn’t check · Retry”; restricted row “Ask an admin”
with explanation, excluded from confirmed count but denominator remains 4. No success auto-dismiss
until all four confirmed on a successful read. If later configuration regresses it can reappear.
Refresh recomputes; stop pagination immediately on published brand match; unknown until exhausted.

Dismiss button “Hide setup checklist” stores only localStorage
`am.homeChecklist.<userId>.<workspaceId>.v1 = 'hidden'` (device preference, not completion).
Home footer “Show setup checklist” deletes key; visible for eligible roles even when all complete,
opening a read-only “Setup confirmed” checklist until closed, without changing real state. Storage
failure uses memory. No timestamps/history/telemetry; user/workspace isolation; no server write.
If dismissed it stays hidden on this device regardless of later regression until restored. A missing
permission never marks a check complete. New-brand Home still renders empty Running and honest no-data
performance; checklist supplements the page rather than replacing it with a wizard.

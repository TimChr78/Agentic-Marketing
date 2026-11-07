# Broadcast Report · #500

Keep existing BroadcastReport({artifactId,active}) and Report tab. Lazy-load only when active and
authorized. Run facts/status remain in Sending; analytics counts here are distinct **people** per
event type, exclude tests and use event dates. Never present run.queued as delivered or sum daily
unique people into a whole-period total. No new causal attribution or independent broadcast control.

## Period and exact reads

Default **Last 7 complete days**, using existing workspace-local period utility. Picker options
Last 7 complete days / Last 30 complete days; no prior-period comparison in Phase25. Header displays
inclusive human dates plus IANA workspace zone; logical interval is `[from,nextMidnight)` at local day
boundaries (calendar arithmetic, not 24-hour subtraction across DST). Current analytics SQL uses
`at <= to`: send `to = nextMidnight - 1 millisecond` to both queries and the holdout read, and
`from = firstLocalMidnight`. Keep nextMidnight separately for human date labels and Analytics links;
do not change frozen compiler semantics. Persist selected option in
report component state, not a new saved-view store. Changing period refreshes all sections and
ignores stale results. Explicit Refresh reruns current reads; no timer. Analytics cache remains 60s.
Every successful section displays meta.timeZone/from/to and “Latest event in period: [freshness]”;
null freshness is “Unavailable”, never query time or pipeline health.

Two analytics.query calls, both `{filters:{broadcast:artifactId},from,to}`:

1. Totals `dimensions:[]`, measures `email.sent,email.delivered,email.bounced,email.complained,
   email.opened,email.clicked,email.unsubscribed,email.open_rate,email.click_rate,email.unsubscribe_rate`
   (exactly 10, no extra measures).
2. Series `dimensions:['day']`, measures `email.sent,email.delivered,email.opened,email.clicked,
   email.unsubscribed` (5). Use returned column names to map rows; never depend on array positions.

All-time or run-lifetime totals are out of scope. A send older than range can have new engagement
inside range; do not hide opened/clicked/unsubscribed when sent===0. Current provider tracking from
system.status is a warning about current capability, not a historical coverage ledger. Use caption
“Tracked engagement; coverage may vary. Zero recorded events does not prove no engagement”. Missing
coverage is not proof that tracking was enabled at send time.

## Sections in order

| Section | Exact content / units |
|---|---|
| Four tiles | Sent people=email.sent; Delivered people=email.delivered; Tracked click rate=email.click_rate×100, numerator clicked, denominator delivered; Unsubscribed people=email.unsubscribed, secondary unsubscribe_rate×100 and bases. All use full-period totals. Rates one decimal percent; counts locale integer. Denominator0/null → unavailable, not 0%. |
| Delivery | Horizontal bars from totals: sent, delivered, bounced, complained with numeric labels and a table. Heading “Delivery events · people”. Explain “Event counts can overlap and are not a cohort funnel”. Do not subtract delivered+bounced from sent or force monotonic widths; common scale max(observed values). |
| Tracked engagement over time | Two lines opened/clicked people by day, distinct markers and direct legend; no smoothing. x=local day, y=people from 0. Missing/null → gap, not zero. Available zero row →0. Do not fabricate absent dates as observed0. Expandable accessible day/count table from same result. Caption “Daily people; a person may appear on several days. Period totals are deduplicated separately.” Open rate shown in caption from totals with opened/delivered bases and same unavailable rules, never average daily ratios. |
| Unsubscribes over time | Daily bars email.unsubscribed from series, with day/count table and period count/rate above; no identities or reasons invented. Same gap/zero rules. |
| Link inspection | Explicit B4 cut below; textual unavailable notice and existing authorized Message activity destination only, no table of sampled or suppressed URLs. |
| Campaign holdout | campaigns.of({artifactId}) → campaigns[].id,name,role,goal; artifacts.get for each campaign's **published** content.controlGroup to determine a control. For those with a published control only, campaigns.holdoutResult({campaignId,from,to}). Heading “[Campaign name] · Campaign-wide holdout”, link campaign. Show control/treatment entered, converted, conversionRate, unsubscribed, unsubscribeRate, revenue; absoluteLift×100 in percentage points, relativeLift×100 as percent, ci95 endpoints×100 in percentage points, minSampleSizeMet, verdict and note. No control → “No campaign control group”; no result query. Multiple controlled campaigns → separate sections, no merged lift. Subject test is not a holdout. |

Use frozen KpiTile/chart primitives and existing number/measure labels. 1440 tiles four columns;
delivery/engagement full main width, context retained. 768 tiles2×2, charts stack. 390 tiles one
column, bars full width with wrapped labels, charts min-width 0 with4 visible date ticks, all days
in table. Lines use v2 viz-1/viz-2 plus circle/square; unsubscribes viz-3. No red/green-only verdict.
Tables stack day/measure rows at 390; no sideways page scroll. Tooltips keyboard/focus accessible;
data table provides complete values independently of pointer hover.

## B4 decision: cut ranking for Wave5

Inventory explicitly permits a cut when safe URLs cannot be established. Take that cut in #500.
Existing events store raw personalized `url`, including arbitrary path segments; neither analytics
nor the saved template contract supplies a guaranteed safe non-personal label mapping. Removing
query strings/fragments is insufficient (addresses/tokens may be in paths, userinfo or hostnames).
Hashing/truncating a raw URL is not a safe display label and still reveals rare link identities.
Do not invent an allowlist of “probably public” paths, fetch destinations, or expose raw URLs in
DOM attributes, titles, exports, logs, table data, accessible names or JSON fallbacks.

**No analytics.broadcastLinks endpoint is added in this phase.** Its proposed input/output and
k=5 remain deferred in the inventory; no server registration/catalogue work is necessary. The
mock says “Top links unavailable — safe link labels are not available for this report”. Link to
existing Message activity only if profiles:read permits, and do not imply it is broadcast-filtered
or ranked if the destination cannot accept that filter. It retains its own permissions/redaction.
No N message-page crawl or client-side ranking. No low-volume URLs or “hidden link #N” identities.

Future B4 acceptance would require safe labels established before output and k≥5 distinct people
per returned URL, filtering identities **before** limit/ranking/pagination, safe tenant/test/time
scoping and metadata. A row with null clickers and a raw URL would still violate suppression.
Those are deferred gates, not discretionary choices left to DeepSeek in #500.

## Data states and uplift caution

Loading each section: matching skeleton, aria-busy, no dummy chart. Main totals/series failure:
local Retry, no stale numbers represented as current; one can succeed independently. Campaign
failure does not erase delivery. Known all-zero complete data: “No recorded events in this period”
and keep period control; unsent broadcast: “No send activity yet” only when run evidence supports
it. Null cell: em dash + unavailable reason; suppressed: em dash + “Fewer than 5 people”, retain
meta.k/suppressed/notes. Never identify suppressed groups or convert null to 0. Mixed rows render
available cells and gaps. Restricted: no analytics/campaign reads or hidden data.

Campaign result `minSampleSizeMet=false` says “Insufficient sample”; ci95 includes 0 / returned
inconclusive verdict says “Inconclusive”. Retain server verdict/note and do not manufacture
significance. relativeLift null when control rate 0 stays unavailable. Caption “Campaign-wide;
includes other sending members. This does not isolate the broadcast’s effect.” Campaign periods
must match selected report interval. Do not label revenue as currency without metadata/configured
currency. Revenue is a currency→amount map: show a separate amount per returned currency, never
sum currencies. Arm conversion/unsubscribe rates are fractions: multiply by 100; bases are entered
people (not delivered). With entered 0 display unavailable even though the handler emits a zero
rate. Holdout is an assignment cohort with attributionDays capped at selected to, unlike event-date
e-mail analytics. Display goal.event, attributionDays, controlGroup.percent/minSampleSize,
returned from/to and that distinction. Control configured but goal.event absent: “Set a campaign
goal event to measure uplift”, no result query.

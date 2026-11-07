# Campaigns · #511

Existing campaign Evaluation tab becomes a results roll-up, not a new list dashboard.
Keep CampaignEvaluation and CampaignHoldoutCard compatible; no shared ArtifactDetailPage edits.

## Period and exact reads

artifacts:read for all reads. Reuse host artifacts.get and its published campaign content when
available; if latest differs, one pinned artifacts.get({artifactId:campaignId,version:publishedVersion})
for control/goal configuration. Initial active report1 analytics.campaignSummary({campaignId,from,to}).
No campaigns.members or per-member analytics/status calls: summary.members supplies names/types/roles
and metrics. Summary internally does heavy attribution/revenue/member queries and J journey holdout
computations; one client call is not one SQL scan. With published controlGroup AND goal.event,
1 campaigns.holdoutResult({campaignId,from,to}) =2 report calls total; no control/no goal =1.
Optional pinned host definition adds1, never per-member. Refresh same1/2 reads, no comparison
in this phase. Remove duplicate holdout fetch by host/Card; pass shared period and active state.
No campaign-list N summaries, no new server command.

## Sections and metric rules

not_started branch: readiness.published/membersPublished/sendingMembers/publishedSendingMembers/
sendingMembersScheduled and goal; show “No recorded campaign sends in this period” plus actual
readiness, never a healthy all-zero result chart. Keep period selector. measured: headline tiles
recipients,delivered,clickers,converters,unsubscribers,complaintRate,unsubscribeRate,conversionRate;
use explicit distinct-person attribution units. Conversion denominator=recipients, complaint and
unsubscribe denominator=delivered (different from general analytics complaint/sent). Denominator0
makes rates unavailable. Percentages ×100; no daily data is provided, so no invented trend.

Independent horizontal bars for funnel[].count labelled recipient/delivered/clicked/converted;
shareOfRecipients includes recipient denominator. Returned stepRate divides by previous step;
label the actual previous stage if shown, never imply click-conditioned conversion. Converters
can exceed clickers. Do not force monotonic widths or add member sent counts to headline recipients.
Table below bars includes returned bases/rates, meta period/zone/freshness/k/notes. Summary nulls
remain unavailable; if meta.suppressed>0, withhold the scalar headline/funnel and derived rates
as a section, because the wrapper cell() coerces missing/suppressed cells to0 and loses cell provenance; if a wrapper default cannot distinguish missing from zero, explain unavailable
rather than infer evidence. meta freshness describes summary’s underlying events only, not holdouts.

Members table from summary.members: name,type,role,sent,delivered,clickRate,unsubscribeRate,converters.
Rates use member delivered bases; null unavailable. Rows for content artifacts may have no sending
result; label Not a sending member rather than treating zero as failed performance. Attribution
uses current published sending membership and configured goal attributionDays, not historical
membership snapshots. Explicitly explain conversion attribution window and goal.event.

Revenue and revenuePerRecipient are arrays {currency,amount}. Show one tile/row per returned
currency; never sum them or derive a mixed-currency average. Monetary chart only when meta.currency
is single AND rows agree; otherwise per-currency labelled tiles/table (no combined chart).
targetProgress null → Progress unavailable, not0%; retain goal.target/kind/event/attributionDays.
No cross-channel unified attribution or causal sum of artifacts.

summary.holdouts are journey controls, each titled “[Journey] · Journey holdout”. Campaign control
comes solely from campaigns.holdoutResult, titled Campaign-wide holdout; never double-count or merge
these. Display each arm entered,converted,unsubscribed with entered bases, rates, sample gate,
absoluteLift in pp, relativeLift percent, ci95 in pp, verdict and note. Missing goal → Set a campaign
goal event; no result read. Missing control → No campaign control group. Insufficient sample and
inconclusive remain explicit; zero control conversion makes relative lift unavailable. Campaign
holdout revenue remains separate per currency. No manufactured significance or broadcast-only lift.

1440: tiles4 columns, bars then table full main width, separate holdout sections. 768: tiles2×2,
member fields wrap. 390: tiles1 column, member rows stacked with bases and rates, holdout arms in
labelled vertical pairs, currency labels repeat on each amount; no sideways page scroll.

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

Test not_started vs measured; distinct recipients differ from sum of members; converters>clickers; campaign/journey holdouts separated; mixed EUR/USD and targetProgress null; no control/no goal skip reads; exactly1/2 report calls independent of member count.

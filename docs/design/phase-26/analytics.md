# Analytics · #506

Fixed questions lead the existing Analytics performance tab. Preserve AI usage and deep links.
Chart first, result table immediately below, controls above. No persisted saved views.

## Period and exact reads

artifacts:read gates all reads. Load analytics.metrics.list({}) once per mount (not per chart).
Each preset does exactly 2 analytics.query calls per period: totals dimensions:[],limit:1;
series dimensions:['day'],limit:5000,order:{by:'day',dir:'asc'}. Both use explicit from/to and
identical applicable filters. Compare on by default: 4 query calls + catalogue = 5 initial;
comparison off = 3. Refresh reruns 4 (or 2), never catalogue. One series/table result per period.

| Preset | Exact measures in both reads | Default display |
|---|---|---|
| Newsletter performance | email.sent,email.delivered,email.opened,email.clicked,email.unsubscribed,email.open_rate,email.click_rate,email.unsubscribe_rate (8) | Delivered and tracked clicked people; rates in separate panel |
| Journey conversion | journey.entered,journey.goal_reached,journey.completed,journey.exited,journey.failed (5) | Entered and goal-reaching participants; goal/entry ratio labelled event-period ratio |
| Deliverability | email.sent,email.bounced,email.complained,email.bounce_rate,email.complaint_rate (5) | Bounce and complaint percentages; sent-person bases in table |

Grouped measure picker: Delivery / Tracked engagement / Journey progress / Conversion value.
Plain labels, descriptions and units from catalogue plus labels registry; source changes replace
incompatible selections with the matching group’s defaults, announce it. At most 10 including
ratio bases; no silent truncation or source mixing. Conversion value uses only conversions,revenue
(2, source events) with same 4-query plan, except totals limit:5000 because currency is
an implicit dimension and limit:1 could discard currencies; not mixed into email/journey queries. Ratios always
include numerator and denominator from registry. Click/open/unsubscribe bases=delivered people;
bounce/complaint bases=sent people. Journey ratio=goal reached / entered participants; can exceed
100%, never describe as cohort conversion. Conversions count distinct events, revenue sums values.
No meaningful denominator for a count: caption its counting unit instead.

Filters use existing analyticsParams/deep-link broadcast; broadcast/template on email, journey on
journey source; only SOURCE_FILTERS-supported combinations. No enumeration/fetch per result row.
Change preset resets invalid filters visibly. Current/prior dashed/solid with aligned relative day
labels and actual dates in table; never shift timestamp labels to pretend the periods overlap.

## Revenue gate and cuts

For any currency-unit chart, require non-null, usable currency metadata for that result (UNKNOWN is unavailable). A comparison chart
also requires the SAME non-null currency in both results. Otherwise replace monetary chart with
“Revenue chart unavailable — result contains multiple currencies or no currency information”.
Keep returned currency-labelled table rows; when no explicit row currency exists show Unavailable,
never assign a workspace default. Do not add currencies, draw unlabeled amounts, or compare EUR to
USD. No extra fallback reads: explained state is the chosen single-currency follow-up. Keep other
count charts. No persisted views, arbitrary cohort attribution, retention or policy thresholds on
these distinct-person event-date trends. Tracked engagement coverage can vary historically.

## Sections and layouts

1440: preset strip, summary tiles, full-width line charts separated by unit, table, provenance.
768: controls wrap, tiles2×2, charts stack. 390: picker opens full-width region, one-column tiles,
4 chart ticks, paired current/prior rows per date. Denominator and period stay visible above fold.

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

Currency gate tests: single, mixed, missing and different prior currency; exactly5 initial calls; source switching, ratio bases and zero-prior delta; deep-link filter retained only when valid.

# Deliverability · #508

Answer “Can this stream send safely under current policy?” before DNS configuration.

## Period and exact reads

artifacts:read for all three commands; workspace:admin only for existing policy settings links.
Initial: deliverability.health({}) once, sendingDomains.list({dkimSelectors:[]}) once,
proposed deliverability.trend({from,to,channel:'email',stream:'marketing'}) once =3 calls.
Trend uses last30 complete local days; optional last7. Stream/channel selector loads1 trend,
reuses health’s four streams. Refresh rates reruns health+trend=2; Check DNS reruns only list=1,
with trimmed unique selectors max5 (existing validation), never DNS on every period/stream change.
No per-domain command. B5 is required for comparable threshold lines; see README owner S.

## Sections and exact semantics

Four stream rows (email/sms × marketing/transactional) display health sent,bounced,complained,
bounceRate,complaintRate,status,reason; returned windowDays and thresholds beside each.
Rates denominator=non-test messages currently sent/delivered/bounced/complained and created within
rolling window; sent=sum of those mutually exclusive statuses, not unique people. Show raw sample
“n / minimum minVolume”, bounced/sent and complained/sent. sent0 → No data, rates unavailable;
0<sent<minVolume → Below evaluation volume, withheld rates (em dash) and “Not evaluated”, per DECISIONS D32. At volume:
warn → Warning; ok → Healthy; paused → Sending paused only for marketing AND autoPause=true,
otherwise Above stop threshold. Threshold equality follows server >=. Never infer pause from zero.
No policy rewrite, new pause/resume control or historic pause record.

Trend: two separate rate charts (bounce and complaint), same selected stream. B5 points use
current statuses by rolling creation windows; y=percent, x=window end. Dashed lines at current
bounceStop / complaintWarn / complaintStop with text numeric labels. Low-volume rates are withheld: gaps labelled “Below evaluation volume”; zero-volume rates are gaps. Table columns day,windowFrom,
windowTo,sent,bounced,complained,bounceRate,complaintRate, minimum volume. Caption “Recalculated
under today’s policy; late status updates can revise earlier points. Lines show current thresholds,
not historic pause decisions.” Chart ends at last midnight, not health’s now. Latest event in period
unavailable; computedAt shown separately. Never overlay thresholds on analytics email.* trends.

DNS cards per domain: uses, overall check result qualified by checkedAt, SPF record/ok/advice,
each supplied DKIM selector record/ok, DMARC record/ok/advice/policy. Include fix beside failure:
returned advice, or “Ask your DNS administrator to verify the provider’s record for this selector”.
No invented TXT value. No selector → DKIM not checked, no green pass. Missing record may be lookup
failure; say so. Copy only supplied record, never a generated fix. No DNS history or prior-health
charts. Independent DNS failure leaves health visible; no domains → configure sender-domain link
for authorized admins, explanatory text for viewers. Suppression is not supplied by these reads;
never invent k=5 as an enforcement threshold.

1440: health sample table, wide trend charts/table, DNS cards2 columns. 768: health rows wrap,
charts stack, DNS2 columns if readable. 390: stream cards1 column, explicit thresholds below rates,
DNS1 column; long record text wraps with independent Copy, no clipped fix.

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

Test sent0, minVolume-1, minVolume, equality at each threshold, autoPause off and transactional above-stop; B5 table/threshold parity and late-status caption; no selectors DKIM unknown; DNS retry leaves rates unchanged.

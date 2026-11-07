# People · #510

Paginate the existing list; never label loaded length as population. Keep imports entry/history.

## Exact reads and counts

profiles:read: profiles.list({limit:50}) once per page; next uses before:nextCursor.lastSeen,
beforeId:nextCursor.id unchanged (including microseconds), Back uses cursor stack. Reuse cached
pages; refresh1. Optional purposes.list({}) once per mount if artifacts:read for human purpose
names, not per row. Initial2 calls with both permissions, otherwise1. No profiles.get per row.
Header “50 shown · Page1”, not “50 people”. With nextCursor non-null say More people available;
null says End of list, never infer an exact global total after concurrent changes. No B3 server
addition, full-population scan or consent.summary total. Empty first page says No people yet;
empty subsequent page says List changed, return to first page. Search uses existing exact
profiles.find({type:'email',value})=1 only on submit; null→No match; found→open detail. No substring
search over loaded rows presented as workspace search.

Detail: profiles.get({profileId})=1, then canonical returned id for profiles.events({profileId,
limit:100})=1, messages.list({profileId,limit:50})=1, consent.history({profileId})=1 =4 initial.
Reuse purposes from list or load1 when direct entry and permitted. Topics and segments remain
existing optional tabs, load1 topics.preferences({profileId}) or segments.ofProfile({profileId})
on opening, not on timeline mount. Events next1 with before:timestamp,beforeId:eventId from its
cursor; messages next1 with cursor:nextCursor; consent history unpaged, no invented next cursor.
No per-message template fetch or mergedFrom message fan-out. Explicit refresh repeats4 base reads.

## Identity, consent and timeline

One primary email, secondary visible name; no repeated email column. Use server-redacted email
and name only: profiles:pii absence says Email hidden (not anonymous/no email); permitted null says
No email available. Identifier behind named copy control; accessible labels must not repeat hidden
PII. Do not extract name from hidden personal fields. Display consent per purpose, raw status with
plain label, lawful basis/channel context from permitted purposes. Missing record says No recorded
choice; eligibility follows existing purposeAllowed, never assumes refusal or permission. Purpose
name unavailable → Purpose name unavailable + copy key, not raw key in table title. No “1 allowed”.
Consent mutations stay existing profiles:write controls; export profiles:pii, erase profiles:erase,
with existing confirmations and server checks. No new bulk consent action.

Profile timeline interleaves loaded events (timestamp), message creation and returned message events
(at), consent changes (recordedAt), stable keys prefixed by source and ids. Same underlying message
event may also occur in event lane: label source and do not assert deduplication without common ids.
Show “Loaded history” and per-source Load more, not complete chronology. Consent history includes
merged profiles; messages cover canonical current profile only. Caption this mismatch; no claim of
all merged messages. Messages’ nested events are capped1000 server-side for the page: delivery
history may be incomplete even when message cursor ends. No single global cursor, total timeline
count, invented consent before/after values or new storage. Event/property redaction stays server
owned; do not surface raw personalized message URLs in timeline summaries.

Timeline is all loaded history, not selected-period metrics: dates on every item and source count
“100 events loaded / 50 messages loaded / consent records loaded”. Latest event in period is
Unavailable (no bounded period); latest loaded timestamp may be named as such, never completeness
or pipeline freshness. No chart is necessary; semantic ordered list is the table/text fallback.

1440: list identity/consent/last-seen columns, detail timeline main plus320px identity context.
768: context below, consent wraps. 390: one identity per stacked row, purpose/status pairs and
last-seen; paging buttons always visible, timeline1 column and sources wrap. No clipped last column.

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

Test equal timestamp profiles/events with cursor precision; Back/Next under concurrent changes; zero profiles.get on list; PII-redacted identity; missing consent and basis; independent timeline pagination, merged coverage caption and capped message-event history.

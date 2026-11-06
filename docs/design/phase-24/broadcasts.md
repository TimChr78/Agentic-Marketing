# Broadcast reference pair · task B

Task: compare operational sends, then understand who receives one, when and what to inspect next.
Owned files/baseline `broadcast-*` screenshots: [README](README.md). No Phase 25 compose redesign,
link ranking, standalone pause, automatic recovery or new commands beyond #445.

## Shared pure templates

B creates and exports these named components (ReactNode slots; all data/actions supplied by caller).
They own geometry, semantics and display states, never API calls, permissions, routes or mutations.

```ts
type PageReadState = 'loading' | 'ready' | 'empty' | 'error' | 'restricted';
type PageNotice = { title: string; body?: ReactNode; action?: ReactNode };
interface ListPageProps {
  title: string; description: ReactNode; primaryAction?: ReactNode;
  filters?: ReactNode; countLabel?: string; state: PageReadState;
  notice?: PageNotice; loadingContent: ReactNode;
  desktopTable: ReactNode; mobileList: ReactNode; pagination?: ReactNode;
}
interface DetailPageProps {
  title: string; kind: string; statePill?: ReactNode; metadata: ReactNode;
  primaryAction?: ReactNode; secondaryActions?: ReactNode;
  consequence: ReactNode; tabs: {key:string; label:string; panel:ReactNode}[];
  activeTab: string; onTabChange: (key:string)=>void;
  context?: ReactNode; state: PageReadState; notice?: PageNotice;
  loadingContent: ReactNode;
}
```

ListPage: one PageHeader/h1, actions aligned right at desktop; filters after 24px, count right;
16px to single outer-bordered table. LoadingContent replaces rows; empty/error/restricted shows
notice in body while retaining header/filters when authorised. Pagination only ready nonempty.
At <768 render mobileList **instead of**, not alongside, table; no duplicate accessible content.
Caller supplies native table caption/thead/scope and mobile ul/li/name links. 768 table reflows as
below. Error notice action Retry; restricted notice has no create action/count/data. Templates
must not offer a table/cards switch or client-side sorting unsupported by the read API.

DetailPage: one h1, kind + pill; metadata next; consequence inset before tabs; selected panel then
context. 1440 within expanded shell: 800px primary +24gap +320 context. At <1280 context after
panel; 768 content 720; 390 content 358. Tabs min40px, scroll in labelled region without page
horizontal overflow; active tab aria-selected, panel associated, keyboard arrows/Home/End. Loading
keeps header/consequence space. Root error/restricted replaces content with notice, no hidden
fetches. One selected panel mounted; pending dirty edits still use existing navigation guard.
Do not move existing autosave/version/conflict/approval logic into visual templates.

ArtifactDetailPage adds optional layout/header/consequence/context slots to delegate geometry to
DetailPage for broadcasts only; defaults preserve every other family. B owns this file, S does not.
Shared KpiTile, OperationalPill, DataStatePill, Identifier and stateOfBroadcast stay unchanged.
No global chart API or labels change needed. Template adoption for other families is later work.

## B1 clarification (for #445)

Inventory B1 remains the authority on input, ordering, cursor, count and pinned content. Add
`delivery?: Record<string,number>` to each row, exactly broadcasts.status.delivery: current message
status counts excluding test messages, under workspace RLS, grouped by broadcast id AND status for
**only the visible page ids** in one Postgres query. Return `{}` for known no messages; absence
means counts unavailable, never silently coerce to `{}`. No ClickHouse or per-row status call.
No delivered/click event analytics on the list. `run.queued` is cumulative preparation, whereas
`delivery.queued + delivery.sending` is current provider backlog; never substitute one for the other.
Pass row latestState/publishedVersion/run/stage/**delivery** directly to stateOfBroadcast. A done
run with unavailable delivery remains Queued; no inference of Sent from publication or run.done.
This additive clarification is required by #445 and the Phase 23 state semantics.

## List

Canonical `/marketing/broadcasts`. Title Broadcasts; description “One-off e-mails to a segment,
reviewed before they go out.” Primary New broadcast only artifacts:write; opens current template +
segment create form. S's `?create=broadcast` intent uses that same dialog. Read needs artifacts:read.

One `broadcasts.list({limit:25,cursor?,statuses?})` per page. Returned `total` is the exact filtered
population; `nextCursor` opaque. Ordering updatedAt/id descending, never locally sort by schedule.
Filter order: Status select, Refresh; count right. **No name search** (B1 has no search input).
Status choices/order map exactly: All (omit statuses), Scheduled and sending (`scheduled,running`,
URL `status=active`), Scheduled (`scheduled`), Sending (`running`), Finished preparation (`done`),
Stopped (`stopped`), Failed (`failed`), Cancelled (`cancelled`), Not scheduled (`not_scheduled`).
Other URLs use these raw enum strings as status. Label Finished preparation does not claim delivery.
No Delivered/Draft/In review filter using local page subset. Unknown filter resets All with notice.

Pagination footer “1–25 of 47 broadcasts”; Previous/Next, cursor stack supports Back; no numbered
pages or jump-last. Filter change clears cursor/stack; URL query stores status only, in-memory page
cursor stack resets on reload. Next disabled without nextCursor; Previous disabled on first page.
Changing data may change totals; display latest `asOf` and preserve API ordering/cursors unchanged.
Refresh returns first page, says “As of [workspace-zone time]”. Empty loaded page after deletion has
Previous if stack exists; not a first-use empty. Filter zero says “No broadcasts match this status”
with Clear filter; global total0 All says “No broadcasts yet. Create an e-mail send to a segment.”
Create action only writer; readers “A builder can create your first broadcast”. No fake sample rows.

| Column, width at 1144px | Source and exact meaning |
|---|---|
| Broadcast, 400 | name as detail link; second line latestVersion/publicationLabel; if run.version differs show “Sending v1 · draft v2” or “v2 in review” as applicable, never overwrite runtime state. |
| State, 144 | OperationalPill from stateOfBroadcast; detail text accessible in row/tooltip; stopped reason visible on detail. |
| Audience, 180 | segmentId resolved from a shared paginated artifacts.list(type:segment) name cache, fetched once per workspace and reused, not artifacts.get per row. Fallback “Segment” + Identifier if unresolved/deleted. Run recipients >0 second line “N reached at preparation”; not current eligible size. Not scheduled says “Eligibility checked on review”. |
| Schedule, 232 | run.sendAt in workspace zone; no value “On publication” only if no run and definition has no schedule, otherwise “Not scheduled”. List B1 does not expose draft content sendAt: show “Not scheduled” for not_scheduled, do not fabricate On publication. Running adds startedAt when present, done adds finishedAt. Passed scheduled time says “Waiting to start”, not missed/failed. |
| Result, 188 | For scheduled/not_scheduled: “Not started”. Running: run.queued “N queued during preparation”, run.skipped + windowSkipped separately if nonzero. Done: current delivery accepted (`sent+delivered+bounced+complained`) “N provider-accepted”; pending queued+sending “N awaiting provider”; failed/suppressed counts separately when nonzero. No message-event rates or adding accepted to delivered. Absent delivery: “Delivery unavailable”, cumulative queued may remain labelled. Stopped/failed/cancelled retain cumulative queued and safe reason, never “0 sent” without evidence. |

All numeric counts locale integer and tabular; no rates in list. Column widths include padding.
Header36, rows min64, cell12×16. At768 columns40/24/36%: audience under name, state middle, result
under schedule; at390 semantic summary list min72 with name/state then segment/schedule, detail
link for results. Preserve state detail for assistive tech; long name wraps. Filter/select40px mobile.

Loading: 5 row skeleton, aria-busy; error: “Couldn’t load broadcasts” + Retry, no count0. Failed
refresh preserves previous rows labelled last loaded and error. Restricted: no B1 request and no
create action, role explanation. Per-row missing delivery/names do not fail the entire table; display
qualified fallbacks. No invented stale/paused/healthy badge. Empty and failed mocks are selectable.

## Detail

Canonical `/marketing/broadcasts/:id`. Fetch `artifacts.get({artifactId})`, existing pending
`approvals.list({status:'pending',artifactId,limit:5})` (B7 metadata), and one
`broadcasts.status({artifactId})`; share status response among pill, summary, Sending and context.
No duplicate status hook per slot. Refresh status every10s while run.status running AND visible;
otherwise explicit Refresh, revalidate on focus. Do not poll analytics. Author/versions from existing
artifact reads, no invented ownership field. Publication metadata separate from run.version.

Header name wraps; Broadcast + OperationalPill; version/author/updated time + Identifier. Critical
errors persist above tabs. Consequence summary lines in order:
1. Who: segment name + run.recipients “reached at preparation”, or “Eligibility not checked”.
   Existing preview is explicit-only; if loaded show “wouldSend eligible among checked of audience
   checked”, never extrapolate capped check. Template name and pinned version if known.
2. When: run.sendAt + zone; not scheduled uses saved content.sendAt if present, otherwise “On
   publication”; stale draft unsaved timing clearly labelled “Unsaved draft”, never live schedule.
3. Next: from table below. Stopped/run.error goes here, never only in context.

Exactly one primary action, chosen runtime before latest draft state. Other existing edit/version/
discard/cancel actions remain secondary with current confirmation/gates; do not add mutations.

| State | Primary / next-step copy |
|---|---|
| draft or rejected, no live run | “Submit for review” (or “Publish vN” only current directPublish policy), existing requestPublish flow, artifacts:publish and saved valid draft; while dirty primary “Save draft” artifacts:write. Read-only → “View content” tab link. Never bypass policy, note or validation. |
| in_review, no live run | “Review request” artifacts:approve else “View request”, `/approvals/:id`; no pending request found → View activity. |
| published/not_scheduled | “View sending”; “Waiting for the scheduled run”; never a new Send now button. |
| scheduled | “View sending”; “Starts [time zone]”; overdue “Send time passed; waiting to start”. |
| sending / queued / delivering | “View sending”; current backlog if available, no all-delivered promise. |
| stopped | “Inspect canary” → Sending; summary includes stage.stopReason, “Review the canary before sending the rest”. Existing Send the rest stays secondary inside Sending only stage stopped + run stopped + artifacts:publish, same confirmation. |
| blocked / failed | “Inspect failure” → Sending; safe run.error or failure detail, “Inspect the failure before making changes”. No retry action. |
| sent / nothing sent / nobody to send to / cancelled | “View report” → Report; outcome detail from stateOfBroadcast, cancellation says no further messages, already sent cannot be recalled. |
| status unavailable | “Retry status”; retain saved content but state unavailable, never publication-derived operational success. |

Tabs exact order Content, Preview, Sending, Report, Versions, Activity; URL `?tab=content|preview|
sending|report|versions|activity`; default Content for draft/rejected/in_review with no active run,
Sending for scheduled/running/stopped/failed, Report for done/cancelled; explicit tab always wins.
Content reuses BroadcastEditor; Preview existing recipient preview (640px white e-mail, labels Saved
vN/Published vN/Unsaved draft). Sending reuses run, delivery, subject test and canary panels with
current confirmations and permission gates. Cancel sending secondary only scheduled/running with
messages:send; never arbitrary resume. Versions/diff/activity unchanged. Request error keeps draft
and note; conflict/dirty guard from ArtifactDetailPage unchanged.

Report in Phase24 is a minimal existing-read summary, not Phase25 link ranking: on selecting tab,
`analytics.query` broadcast filter, dimensions [], measures email.sent/delivered/clicked/click_rate,
last7 complete local days (same Home period). Show four existing KpiTile primitives with explicit
people units, metadata, suppression and denominator rules from home.md; no trend or comparisons
required. Link Analytics with broadcast/from/to retained. Sending's message event counts stay
labelled messages and separate from Report's people counts. No tracked-open claim or daily sums.

Context panel order: Published and latest versions; Changed by (actual version author, no fabricated
owner); Segment; Template; Schedule+zone; Preparation counts recipients/queued/skipped/windowSkipped;
Campaign membership from existing campaigns.of; references/dependencies links from artifacts.get.
No current-user owner fallback. Missing reference “Unavailable reference” + Identifier; forbidden
references do not fetch. Mobile context below selected content; critical blockers remain summary.

Root loading skeleton header+summary+panel; missing404 “Broadcast not found” + Back to broadcasts;
restricted no fetch, role explanation; artifact error Retry; status failure inline Retry with saved
content still inspectable and operational state unavailable. Empty Report “No sends in this period”
with change-period Analytics link; error/suppressed/unavailable use existing data-state primitives.
Pending approvals failure never offers Publish optimistically. Preserve API errors and server policy
as authority. Empty Sending “No run yet”; no success badges. Tests should exercise done+pending
messages, cancelled, stopped, pinned old run/new draft, forbidden roles, failure/empty and redirects.

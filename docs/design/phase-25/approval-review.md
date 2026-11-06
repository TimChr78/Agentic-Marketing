# Approval review · #498

Retain /approvals/:id, the queue, drawer lifecycle and exact-version commands. Default Review
content order is (1) consequences, (2) requester note and rendered artifact, (3) published-to-reviewed
diff. Content JSON and History remain secondary tabs. Replace the old Preview/Changes split with
Review / Content / History; Review contains a visible “Changes · N” heading and an initially open
diff section after the artifact. Mark this version viewed only when its rendered Review is loaded,
not merely when a loading drawer opens. No new keyboard approval shortcut.

## Common read and presentation contract

`approvals.get({approvalId})` is authoritative for id, artifactId, artifactName, artifactType,
version, content, publishedVersion, artifactLatestVersion, publishedContent, status, requestedBy,
requester, note, createdAt, holdUntil, diff.{from,to,changes}, history, bundle. Never replace its
content with artifacts.get latest. Heading: “[name]”; metadata “[Type] · Reviewing Saved vN ·
Published vM / Nothing live yet”. Consequence heading **“If approved”** (decided requests: “Decision
context”). Common rows: “Publishes” name/type/version and whether replacing Published vM; “When”
on approval unless the type supplies a schedule; “Dependencies” every direct referenced artifact,
name/id, required version and live status. Resolve ids from reviewed content using existing artifact
reference extraction; artifacts.get reads provide names/publication pointers only, never overwrite
reviewed definitions. Bundle version overrides take priority; otherwise dependencies use their
published pointer. Missing refs show id + “Unavailable”, never “No dependencies”.

Fetch once per unique id/version per open review, cache dependency names, and cancel/ignore stale
requests on navigation. Expensive audience checks run once on opening the relevant member and on
explicit Refresh; no fan-out previews across queue rows. Summary remains first even if its extra
reads fail. Read failure shows “Unavailable — Retry”; retain known exact reviewed fields.

## Exact consequence rows by type

Every field below is from `approvals.get.content` unless another read is named. Show absent
optional values as “Not set” or the explicit semantic default below, never invent an outcome.
Use human labels plus values; JSON is supplementary. No eligible count for non-sending types.

| Type | Rows after common Publishes / When; source and interpretation |
|---|---|
| Broadcast | Template `template`; Segment `segment`; Purpose/topic from selected exact template version plus `content.topic` override via purposes.list; scheduled `sendAt` in workspace zone or “On publication”; `sendWindow.start,end,days,maxDelay` with reader-zone/fallback explanation from composer contract; `subjectTest.subjects,samplePercent,metric,decideAfter`; `stagedSend.canaryPercent,wait,maxBounceRate,maxComplaintRate,maxUnsubscribeRate,minCanary`; `archive.publish,slug,summary`. “Eligible in current check” from broadcasts.preview({artifactId,version:reviewed,templateVersion:bundle template version if present}), with wouldSend, checked, audience, all wouldSkip counts and client completion as-of. Capped → Estimate, never full-audience reach. Bundle segment changes are not simulated: state “Check uses current membership; this bundle may change it”. Provider/domain evidence uses the composer detection rules and existing reads, no policy promise. |
| E-mail template | `purpose,topic,subject,preheader`; “Used when a sending artifact references it; publishing alone sends nothing”. Dependencies: reusable block ids referenced in mjml; resolve bundle versions or published versions. templates.preview({artifactId,version}) gives rendered subject/html/text; templates.check({artifactId,version}) findings, summary, checkedAt below metadata. Raw subject and rendered subject are distinguished if Liquid differs. templates.preview/check do not accept a block-version bundle map: an unpublished bundled block cannot be simulated here. Show “Bundled block render unavailable before publication”, retain exact reviewed MJML/parameters and each block preview separately; do not show an old live block render as the future bundle message. `utm.source,medium,campaign,domains` in a compact “Link tagging” row when set. No audience count. |
| SMS / push template | purpose/topic; SMS body, push title/body/url/icon/image/ttlHours/urgency from reviewed content; “Publishing alone sends nothing”. Existing channel preview/read if supported by the current renderer; otherwise labelled structured content. Do not show e-mail provider/DNS checks on these channels. |
| Journey | `purpose,goal,controlGroup` (all configured fields), `nodes`: trigger node `kind` and its complete `config` object (labelled configuration, no guessed field aliases), node count, each message template dependency and channel. “Enrollment uses the published journey; publishing does not guarantee a send.” Render existing read-only graph from reviewed nodes, no live node counts merged from another topology. No inferred eligible audience or completion ETA. |
| Segment | `mode` default dynamic, `description`; dynamic `condition` rendered by existing ConditionView; static “Explicit membership list”; snapshot `sourceSegment,snapshotVersion,snapshotAt`. Optional segments.preview({artifactId,version}) → count labelled “Estimated members now”, only with profiles:read. No profiles permission → “Membership count restricted”. Membership is not consent; never label it eligible recipients. Publishing changes membership selection, does not itself send. |
| Form | `purposes[]` resolved against purposes.list; `doubleOptIn`; `confirmationTemplate`; `consentText`; `traits`; `successUrl,confirmedUrl,errorUrl`; `allowedOrigins` (empty = any); `turnstile`; hostedPages override fields when set. “New submissions use this form; confirmation e-mail follows its double opt-in settings.” Dependencies: confirmation template exact bundle/live version. Existing FormPreview next, full consent copy visible; no claim of existing subscriber migration. |
| Experience | `placement,priority,targeting` (absent = all eligible visitors), variants `id,name,weight`, `holdoutPercent`, `rollout.steps,stepHours,guardrail`, `goal.event`, configured `analysis` object. “Served when the SDK evaluates this placement; visitor consent still applies.” Structured variant HTML/JSON from reviewed content, no new SDK simulation or audience estimate. List variants in definition order with name/weight; sandbox HTML without scripts, label JSON content when no HTML. |
| Workspace proposal | Separate workspace.proposals({status:'pending',limit:50}).proposals row, **not approvals.get** and not a versioned artifact. Fields id, changes.name.{from,to}, changes.timeZone.{from,to}, requester, note, createdAt, status, decidedBy/At/decisionNote. Common wording “Applies workspace settings immediately on approval”; list only changed setting names and proposed values, then requester note, then stored from→to diff. Time-zone explanation “Changes display time zone; stored send instants stay the same”. No Saved/Published vN label, audience, dependencies or four-eyes inference. Keep current admin-only approve/reject and workspace.approveProposal/rejectProposal commands. Superseded proposals are not actionable; absent from bounded list ≠ nonexistent, retain existing unavailable state. |
| Bundle | `bundle.id,members[]` in returned publish order: numbered artifactName, type, version and approvalId link. “Approve publishes all N changes in order in one step; Reject rejects all.” Read each member approvals.get for its exact content and summary; no merge of counts, no total audience sum (overlap unknown). Overall member summary first; selected member detail follows. Every member shows version/live/stale state; missing member read shows “Member summary unavailable” and retry, never silently drops a member. Broadcast templateVersion is exact bundle override. Note that pre-publication audience checks do not simulate future bundled segment membership. No read calls to internal publishImpact/checkBundlePublishable or speculative publish mutations. |

Other approval artifact families (blocks, brand, campaign, purpose/policy, brief, mandate, prompt,
tracking/conversion definitions) retain full support: common Publishes/When/Dependencies plus
structured reviewed content, existing BlockUsage for blocks and existing renderer/fallback. Label
“This definition becomes live on approval; no recipient estimate applies.” Do not force arbitrary
policy artifacts into a sending consequence model or hide them from the queue.

## Version, policy and review flow

Stale if artifactLatestVersion>version: before the summary show “A newer draft (vX) exists.
Approving publishes vN shown here; the newer draft stays a draft.” Stale alone must **not** disable
approval: current exact-version semantics intentionally allow it. Display Published vM separately
from Saved vN under review even if content happens to be identical. Hold countdown remains pending
until server resolution; retain Run now / Veto and existing bundle labels, never approve from clock.

Keep own-request/all_publishes four-eyes notice and server enforcement unchanged. No client bypass,
new ownership test, extra confirmation or acknowledgement checkbox. Existing approve/reject commands
receive approvalId; do not add an unsupported version input. Server errors stay visible in footer;
conflict refreshes current request rather than silently moving to another version. Reject requires
nonempty note; Send me a test keeps exact reviewed version and bundle templateVersion. No success
message until mutation succeeds. Nonpending read remains inspectable without decision controls.

Keyboard: focus drawer heading on open, trap within, Escape closes and returns focus to invoking
row (deep link falls back to queue heading). Tab: close/open artifact → summary links/refresh →
member links → Review/Content/History tabs → message controls → diff disclosure → Send me a test →
Reject → Approve. Tabs use arrows/Home/End. Reject reveals labelled reason and moves focus there;
Cancel returns to Reject. After success retain current next-in-queue selection; focus next heading,
or queue heading if none. No “A” shortcut that can accidentally publish. All icon buttons have names.

1440: existing review drawer width, summary full width, compact definition list 140 px label +
remaining value, then artifact and diff. 768: same sequence, no split panes. 390: full-width drawer,
16 px inner padding; summary label above value; member list stacked, long names/URLs wrap. Footer
in normal sticky drawer region with scroll body bottom padding, test full row then Reject/Approve
wrapping; primary “Approve all N and publish” can wrap and stays ≥40 px. No fixed-width preview;
iframe max100%. Diff uses stacked Before/After, never forces sideways page scroll. Loading skeleton
follows sequence. Main-read failure replaces content and removes actions. Restricted role receives
read-only review or existing route denial; no forbidden extra reads. No skipped error states in bundle.

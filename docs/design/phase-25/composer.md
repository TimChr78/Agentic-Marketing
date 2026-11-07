# Broadcast composer · #497

Canonical broadcast detail Content tab; keep DetailPage, URL tabs, run-state precedence, context,
Sending and History. Content remains inspectable while the published run is active; editing and
header actions retain current ArtifactDetailPage restrictions. The composer never modifies a run.

## Layout and fields

At 1440 the Content panel has settings left, preview right; both remain in document flow. All
three numbered fieldsets are expanded, in order, with anchor links What / Who / When. They are
sections, not a wizard and do not require intermediate saves. At 768 and 390 place all settings,
then audience/checklist, then preview; a “Jump to preview” anchor follows the step links. No sticky
preview on mobile. Keep title and Save draft in the existing header, no duplicate send button.

| Step | Controls and stored fields, in order |
|---|---|
| 1 · What | Template `template` (existing ArtifactSelect, required); resolved purpose read-only; Topic `topic` (optional, from purposes.list under selected template purpose); Description `description` (team-only, 500 chars). Template changes clear topic as today. Subject/body are edited in the linked template, never copied into a broadcast. |
| 2 · Who | Segment `segment` (required, existing selector); audience check below. Explain “Membership is not consent. Eligibility is checked again at send time.” |
| 3 · When | “On publication” / “Schedule” radio controlling absence/presence of `sendAt`; workspace-zone DateTimeInput storing ISO instant; existing past-date warning. “Only send inside a local-time window” toggles `sendWindow`: start/end, days, maxDelay. |

Following When, three closed native details sections retain **all** existing fields:
“Subject test” (`subjects` 2–4, samplePercent 10–50, metric click/open, decideAfter PT1H–P2D),
“Staged send” (canaryPercent 5–50, wait PT30M–PT24H, maxBounceRate, maxComplaintRate,
maxUnsubscribeRate as percent inputs converted to fractions, minCanary ≥1), and “Newsletter
archive” (`archive.publish`, slug max41, summary max500). Open a details section automatically
when enabled or containing a validation error. Subject test and staged send remain mutually
exclusive with visible reason. Preserve schema duration validation and existing defaults, including
window 09:00–17:00/P1D, test 20%/click/PT4H, canary 10%/PT2H/.05/.003/.02/50.
Never discard advanced content on editing/saving an unrelated field.

## Live unsaved preview and audience boundary

Broadcasts carry no per-send data. Immediately reflect unsaved template, segment, topic, schedule,
window and test selections in the preview metadata. Top label **Unsaved draft · based on vN**.
The nested message independently says **Published vN · template** (published pointer resolved via
artifacts.get), or **Saved vN · template · not live** if no live version. Render that exact template
through existing templates.preview → EmailPreview, using sample data. Reuse BroadcastPreview's
content-driven message selection; no temporary artifact writes and no invented draft-input API.
A subject test shows the draft subject variants separately; do not imply the template subject was
changed. SMS/push selection keeps existing channel render/fallback, never attempts e-mail rendering.

`broadcasts.preview` only accepts saved `artifactId,version,templateVersion?`. Therefore do not
pretend it checks unsaved content. Dirty composer: “Save draft to refresh the audience estimate”;
show previous result only in muted text labelled “Previous check · Saved vN · as of [time]”, never
as current reach. A new draft with missing refs shows no number and “Choose a template and segment”.
After a successful save, call `broadcasts.preview({artifactId,version:newVersion})` once. Also call
once on opening a clean composer and on explicit “Refresh estimate”. No keystroke, focus or timer
polling of this expensive command. Disable Refresh while dirty/busy, with the save reason. Key
responses by broadcast id, version and templateVersion; ignore obsolete completions.

Result wording: **“1,842 eligible in current check”**, “Estimate · 2,000 of 12,480 members checked ·
as of 6 Nov 2026, 10:32 UTC”. wouldSend is never extrapolated. When checked===audience say
“Current check · all N members checked”; future sends remain estimates. Display every wouldSkip
reason and count (known human label; fallback replace underscores), even when count is zero.
`as of` is client completion time in workspace zone, not a server snapshot timestamp. Empty checked0
shows “No members checked”; wouldSend0 with checked>0 shows “No eligible recipients in this check”.
Read error shows no current estimate and local Retry. Save remains available.

Schedule: `sendAt` is an absolute instant shown in the workspace display zone from existing time
utilities, not the viewer browser zone. No population of recipient zones exists in preview output:
do not show made-up Copenhagen/New York/Tokyo counts or exact arrival times. With sendWindow show
“09:00–17:00 in each reader’s time zone · every day · maximum wait 1 day”. Execution uses valid
profile `traits.timezone`, falling back to delivery policy `timezone`; this fallback is not necessarily
the workspace display zone. Explicit helper: “Readers without a valid zone use the delivery-policy
zone.” Without a window: “Scheduled time shown in [workspace zone]; arrival time varies.”

## Pre-send checklist: four evidence rows

Use text statuses Ready / Needs attention / Not checked / Not applicable, with icon and tone.
These rows describe evidence; existing server validation and publish policy remain authoritative.
Never block Save on diagnostics. No extra policy gate based on DNS or a sampled audience count.
Run selected-template/purpose reads when refs change; provider and DNS once on entry and explicit
“Refresh checks”. Cache those results while editing; show completion time (DNS uses checkedAt).

| Row | Detection and exact interpretation |
|---|---|
| Template live | artifacts.get({artifactId:content.template}) → publishedVersion. If non-null, fetch that exact version for purpose and preview; “Live vN”. No pointer: “Not live — publish the template first or submit together in an existing bundle”. Never use latestState as evidence of live. Draft checklist does not invent bundle submission UI. Missing ref or failed read is Not checked. |
| Provider | system.status.emailProvider; map selected template purpose via purposes.list basis: contract/legal_obligation → transactional, others → marketing (existing gateway stream rule). Check the corresponding boolean, **not** configured (which requires both streams). Show “Marketing provider configured” or “No marketing provider configured”; adapter log means “Log adapter — no external delivery”, Needs attention. SMS/push: Not applicable — e-mail provider check. |
| Sending domain | sendingDomains.list({}) → domains filtered by uses including the required stream; show each domain, spf.ok, dmarc.ok and checkedAt. Empty matching list: Needs attention. Any failed SPF/DMARC: Needs attention. dkim.length===0 means “DKIM not checked — selectors required”, so overall Not checked even if domain.ok is true (empty every() is not proof). Nonempty dkim requires every ok; failures Needs attention. Multiple domains are individually listed; never claim which one routing will choose. Non-email: Not applicable. No provider settings/credentials are fetched. |
| Consent purpose | Exact preview template content.purpose plus effective topic (`broadcast.topic ?? template.topic`) against purposes.list.{source,purposes[key,basis,channels,requiresDoubleOptIn,topics]}. Key absent, channel mismatch or topic outside purpose: Needs attention. Valid: “Purpose configured · [name] · [basis]” and DOI requirement when true. This says nothing about universal consent; show “Per-person consent, topic preferences and suppression are checked at send time”. No consent totals or green “Audience consented”. |

Read failure/403 never becomes Ready; show local retry or “Your role cannot check this”. Link to
existing authorized template/settings destinations only; non-admin readers get explanatory text
instead of a Providers admin link. templates.check findings remain in the message preview with
severity/category/location/fix and checkedAt; they are not a fifth vague readiness guarantee.

## Save, submit, publish and states

Keep ArtifactDetailPage save/conflict guard, validation, pending approval read and Publish dialog.
Dirty: primary Save draft; save creates a version via the existing command, resets provenance to
Saved vN only on success, then rechecks. Save failure preserves inputs and Unsaved draft. Discard
restores saved content/label. Submission is unavailable while dirty, pending-state loading/failed,
or existing run/policy disallows it. No implicit save+send shortcut.

`workspace.approvalPolicy`: none → direct; agent_changes → direct only when latest version author
is user; all_publishes → review. Existing artifacts.requestPublish path and dialog note are retained:
clean eligible draft says Publish or Submit for review accordingly. Publishing is not a promise of
immediate delivery. In review links to exact pending review. Four-eyes/holds stay server-enforced.
Run scheduled/running/stopped/done/failed/cancelled and canary continuation use current header
precedence from detailView; do not replace Sending/Report actions with a new Send now.

Loading: skeleton metadata, preview and checklist independently; no fake ticks or zeros. Empty:
selectors plus preview prompt. Error: local failures, preserved draft, disabled unsafe dependent
actions. Read-only: fields disabled with role reason, no Save; preview remains inspectable. Stale
saved base/conflict: preserve draft and existing reload/discard resolution; never silently merge.
No artifacts:read: existing restricted page, no auxiliary fetches. At390 inputs100%, step links wrap,
long template names and ISO durations wrap, checklist values below labels; no page horizontal scroll.

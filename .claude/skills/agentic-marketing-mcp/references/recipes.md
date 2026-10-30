# Recipes

Each step is one tool call: `tool {input}`. Replace `…` ids with real ones from earlier calls. Under the approval policy "agent changes need a person", `artifacts.requestPublish` creates an approval request. Anything that references an artifact (a broadcast's template, a journey's templates) can be published only after that artifact is, so get the dependencies approved first.

## Contents
- Weekly newsletter
- Segments for the newsletter
- Welcome journey after double opt-in
- Signup form with double opt-in
- AI-chosen branch with a tested prompt
- Promoting changes from staging
- Campaign with a control group
- Weekly issue from reusable blocks
- Send the weekly issue under a mandate
- Topics, preference centre and the archive
- Subject test and a recipient-local send window
- Static and CSV audiences
- Journey waits and business entry keys
- Reporting the week

## Weekly newsletter

1. Find the audience segment:
   `artifacts.list {"type":"segment"}` and look for "Newsletter subscribers". If it is missing, see the next recipe.
2. Draft the issue (MJML; keep the unsubscribe link):
   ```json
   artifacts.create {"type":"email_template","name":"Signal #43","content":{
     "purpose":"marketing_email",
     "subject":"Signal #43: {{ 'the week agents ate the stack' }}",
     "preheader":"Three tools worth your Friday",
     "mjml":"<mjml><mj-body><mj-section><mj-column><mj-text>Hi {{ profile.firstName | default: \"there\" }},</mj-text><mj-text>This week…</mj-text><mj-text font-size=\"12px\"><a href=\"{{ unsubscribe_url | raw }}\">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>",
     "sampleData":{"profile":{"firstName":"Ada"}}}}
   ```
3. Check it: `templates.preview {"artifactId":"eml_…"}`. Read the text output and look for broken Liquid or missing sections.
4. Request publishing of the template: `artifacts.requestPublish {"artifactId":"eml_…","note":"Signal #43 for Friday"}`.
5. Draft the broadcast (Friday 07:00 UTC):
   ```json
   artifacts.create {"type":"broadcast","name":"Signal #43","content":{
     "template":"eml_…","segment":"seg_…","sendAt":"2026-10-30T07:00:00Z","description":"Weekly issue"}}
   ```
6. Check the audience: `broadcasts.preview {"artifactId":"bct_…"}` returns `audience`, `wouldSend` and `wouldSkip` by reason.
7. Once the template is approved: `artifacts.requestPublish {"artifactId":"bct_…","note":"Send Signal #43 Friday 07:00 UTC to N subscribers"}`.
8. Afterwards: `broadcasts.status {"artifactId":"bct_…"}` gives the run (scheduled, running or done; queued; skipped) and the message counts. A broadcast sends once; to stop it, `broadcasts.cancel` (needs `messages:send`).

## Segments for the newsletter

- **Subscribers:**
  ```json
  artifacts.create {"type":"segment","name":"Newsletter subscribers","content":{"condition":{"consent":"marketing_email"}}}
  ```
- **New subscribers** (last 30 days):
  ```json
  {"condition":{"all":[{"consent":"marketing_email"},{"event":"Subscription Confirmed","within":"P30D"}]}}
  ```
- **Try a condition before saving it:** `segments.preview {"condition":{…}}` returns a count and sample ids.

## Welcome journey after double opt-in

```json
artifacts.create {"type":"journey","name":"Welcome","content":{"purpose":"marketing_email","nodes":[
  {"id":"start","kind":"trigger","label":"Confirmed","config":{"event":"Subscription Confirmed","reentry":"once"}},
  {"id":"welcome","kind":"email","label":"Welcome","config":{"template":"eml_welcome…"}},
  {"id":"wait","kind":"wait","label":"3 days","config":{"duration":"P3D"}},
  {"id":"start_here","kind":"email","label":"Start here","config":{"template":"eml_starthere…"}},
  {"id":"done","kind":"exit","label":"Done","config":{}}]}}
```
Then `journeys.simulate {"artifactId":"jrn_…"}`; the steps should read trigger → welcome → wait → start_here → done. With `"profileId"` it shows whether the gateway would send to that person. Request publishing once both templates are published.

## Signup form with double opt-in

The confirmation template uses purpose `onboarding` and `{{ confirm_url | raw }}`. Then:
```json
artifacts.create {"type":"form","name":"Newsletter","content":{
  "purposes":["marketing_email"],"doubleOptIn":true,"confirmationTemplate":"eml_confirm…",
  "consentText":"Send me the weekly newsletter. Unsubscribe any time.",
  "successUrl":"https://example.com/subscribe/check-your-inbox/","confirmedUrl":"https://example.com/subscribe/welcome/",
  "errorUrl":"https://example.com/subscribe/oops/","allowedOrigins":["https://example.com"]}}
```
`confirmedUrl` is optional: without it, confirming shows the branded confirmed page (the `brand` artifact's copy) on the links host. After publishing, the site posts to `<links URL>/f/frm_…`. Signups show as `Form Submitted` and `Subscription Confirmed` events (`profiles.events`), and as consent in `consent.history`.

## AI-chosen branch with a tested prompt

1. Prompt with test cases:
   ```json
   artifacts.create {"type":"prompt","name":"Reader interest","content":{"kind":"decide",
     "instructions":"Pick the follow-up that fits the reader's interests.",
     "options":[{"key":"seo","description":"Reads SEO and GEO content"},{"key":"automation","description":"Reads marketing automation content"}],
     "tests":[{"name":"SEO reader","events":[{"name":"page","properties":{"path":"/categories/seo/"}}],"expect":{"options":["seo"]}}]}}
   ```
2. `prompts.test {"artifactId":"prm_…"}`, then `prompts.testRun {"runId":"run_…"}` until `status` is `done` and every case passes; then request publishing.
3. In the journey, add a node `{"id":"pick","kind":"aiDecide","label":"Pick","config":{"prompt":"prm_…","options":["seo","automation"],"fallback":"automation"},"next":[{"to":"seo_mail"},{"to":"auto_mail"}]}`.
4. Decisions, with their rationale and fallback reasons, are in `ai.calls {"journeyId":"jrn_…"}`.

## Promoting changes from staging

1. In the staging workspace: `config.export` (published versions; `includeDrafts: true` for work in progress).
2. In production: `config.import` with the bundle. The default is a dry run: report the creates and updates to the person.
3. With their go-ahead: `config.import` with `dryRun: false, publish: true`. Ids are kept, so a journey still points at its template and segments. Under the production approval policy, agent changes land in review (`publish: "in_review"`); tell the person which approvals wait.

Nothing is deleted by an import. In git, `scripts/am-config.mjs pull|push` does the same with one file per artifact.

## Campaign with a control group

1. Draft the campaign, grouping the sending members under one goal and one UTM campaign:
   ```json
   artifacts.create {"type":"campaign","name":"Signal Q4","content":{
     "goal":{"kind":"conversion","event":"Subscription Confirmed","attributionDays":7},
     "utmCampaign":"signal-q4","controlGroup":{"percent":10,"minSampleSize":200},
     "members":[{"artifactId":"bct_…","role":"primary"},{"artifactId":"jrn_…","role":"follow_up"}]}}
   ```
2. Submit the campaign with its new members in one review:
   `artifacts.requestPublishBundle {"artifactIds":["cmp_…","bct_…","jrn_…"],"note":"Signal Q4 campaign"}`. A broadcast or journey that sends can belong to only one published campaign, and a journey member cannot define its own `controlGroup` when the campaign has one.
3. Check membership: `campaigns.of {"artifactId":"bct_…"}` lists the published campaigns a member belongs to; `campaigns.members {"campaignId":"cmp_…"}` shows its members and their last send.
4. Read the result after sending: `campaigns.holdoutResult {"campaignId":"cmp_…"}` returns control and treatment `entered`, `converted`, `conversionRate`, `revenue`, `absoluteLift`, `relativeLift`, `ci95`, `minSampleSizeMet` and a `verdict`. Report `not_enough_data` as such, never as "no effect".
5. `campaigns.archive {"campaignId":"cmp_…"}` stops treating it as live without changing its members; it no longer answers `campaigns.of` or supplies its shared UTM campaign.

## Weekly issue from reusable blocks

1. Draft the repeated part as an e-mail block (an MJML fragment with typed parameters):
   ```json
   artifacts.create {"type":"email_block","name":"Signal header","content":{
     "category":"header","mjml":"<mj-section><mj-column><mj-text>{{ block.title }}</mj-text></mj-column></mj-section>",
     "params":[{"key":"title","label":"Title","type":"text","required":true}]}}
   ```
2. Preview it: `blocks.preview {"artifactId":"blk_…","params":{"title":"This week"}}`.
3. Draft this issue's own template (template-per-issue; copy the previous issue as a starting point) and include the block:
   ```json
   artifacts.create {"type":"email_template","name":"Signal #44","content":{
     "purpose":"marketing_email","subject":"Signal #44","preheader":"Three tools worth your Friday",
     "mjml":"<mjml><mj-body>{% block 'blk_…', title: 'This week' %}<mj-section><mj-column><mj-text>This week…</mj-text></mj-column></mj-section></mj-body></mjml>",
     "sampleData":{"profile":{"firstName":"Ada"}}}}
   ```
4. Run `templates.check {"artifactId":"eml_…"}` and fix the blocking findings. `blocks.usage {"artifactId":"blk_…"}` shows which templates use the block.
5. Draft the broadcast that references the template and segment, then submit the new block, template and broadcast together:
   `artifacts.requestPublishBundle {"artifactIds":["blk_…","eml_…","bct_…"],"note":"Signal #44 for Friday"}`. A template can be published only with the published version of its blocks.

## Send the weekly issue under a mandate

Your mandate may let this one send run without a person (level 3 for `send.broadcast`), inside a scope and limits. Work through the result instead of assuming it.

1. **Check your limits first.** `workspace.autonomy {}` gives the switch (`on`, `propose_only`, `off`), the audience threshold and the ceiling per class; `agents.get {}` (no id) gives your status and `last24h.changes`/`denied`. If you are `paused`, stop and ask the sponsor. If the switch is `off`, read only; if it is `propose_only`, everything you publish waits for a person.
2. **Draft the issue.** Build or copy the template for this issue, then the broadcast to the mandated segment. `broadcasts.preview {"artifactId":"bct_…"}` gives `wouldSend`; compare it with your previous send: a `recipientGrowth` of 1.2 means this send may reach at most 1.2× that. If it is larger, split it over two sends or ask a person.
3. **Submit both together.** `artifacts.requestPublishBundle {"artifactIds":["eml_…","bct_…"],"note":"Signal #46 to the Newsletter segment: 4,812 expected recipients (last issue 4,610); goal click rate 6%."}`. The `note` is stored as the action's intent; say what it is, why, and what you expect.
4. **Read the outcome.**
   - `status: "published"` — it is live. Confirm with `artifacts.get {"artifactId":"bct_…"}` (`publishedVersion`) and later `broadcasts.status {"artifactId":"bct_…"}`.
   - `status: "on_hold"` with `runsAt` — it runs at that time unless a person vetoes it (a limit, working hours or level 2 held it). Do not resubmit; `heldBecause` says why.
   - `status: "in_review"` with `heldBecause` — a person decides at `reviewUrl`; send the link on with a one-line summary.
   - `403` with `details.reasons` — refused before it ran (scope, limit, level 0, propose-only or switch off). Change the plan to fit the reason, or ask a person; retrying does not help.
5. **Report afterwards.** `analytics.emailPerformance {"from":"…","to":"…","by":"broadcast"}` gives sent, delivered, clicks and unsubscribes. If your mandate's guardrails were breached, the next send is capped at propose, with the reason in `heldBecause`.

## Topics, preference centre and the archive

1. Add the topic under the purpose in the `purposes` artifact (one per workspace):
   ```json
   {"purposes":[{"key":"marketing_email","name":"Marketing e-mail","basis":"consent","channels":["email"],
     "topics":[{"key":"newsletter","name":"Weekly newsletter","description":"The Friday issue","default":"subscribed"}]}]}
   ```
   Create or update it with `artifacts.create {"type":"purposes",…}` or `artifacts.updateDraft`.
2. Put the topic on the template, or on the broadcast to override the template's topic:
   `artifacts.updateDraft {"artifactId":"eml_…","content":{…,"topic":"newsletter"}}`.
3. In the template, link the preference centre and the web version:
   `<a href="{{ preferences_url | raw }}">Manage preferences</a>` and `<a href="{{ web_url | raw }}">View in browser</a>`. With a topic, `{{ topic_unsubscribe_url | raw }}` refuses only that topic.
4. Read a person's choices with `topics.preferences {"profileId":"prf_…"}`. `topics.set {"profileId":"prf_…","topic":"newsletter","status":"unsubscribed","note":"asked by e-mail on 2026-10-27"}` records it; agents may only unsubscribe, never subscribe. Purpose consent is separate and unchanged.
5. Archive: enable it on the brand, then mark each issue to publish after it is sent. Update the brand draft with:
   `{"archive":{"enabled":true,"title":"Signal archive","description":"Every issue","slug":"signal","subscribeUrl":"https://example.com/subscribe/"}}`
   and add to the broadcast content:
   `{"archive":{"publish":true,"slug":"signal-44","summary":"Three tools worth your Friday"}}`.
   `archive.issues {}` returns the live index, feed and each issue's `url`.

## Subject test and a recipient-local send window

```json
artifacts.create {"type":"broadcast","name":"Signal #45","content":{
  "template":"eml_…","segment":"seg_…","sendAt":"2026-11-06T07:00:00Z",
  "subjectTest":{"subjects":["Signal #45: the week in agents","Signal #45: what we learned"],"samplePercent":20,"metric":"click","decideAfter":"PT4H"},
  "sendWindow":{"start":"08:00","end":"18:00","days":["mon","tue","wed","thu","fri"],"maxDelay":"P1D"}}}
```

`subjectTest` takes 2–4 `subjects` (variant A first), sends them to `samplePercent` of the audience, then the winner to the rest after `decideAfter` (PT1H–P2D); `broadcasts.status` shows the result and each message's variant. `sendWindow` holds each message until `start`–`end` in the reader's `timezone` trait (else the delivery policy's time zone), on `days`, and skips it with `outside_send_window` after `maxDelay`.

## Static and CSV audiences

1. Draft a static segment (no condition):
   `artifacts.create {"type":"segment","name":"Launch list","content":{"mode":"static","description":"One-off launch"}}`
2. Add people by profile id, e-mail or user id (up to 1,000):
   `audiences.add {"segmentId":"seg_…","emails":["ada@example.com"],"source":"manual"}`
3. Or import a CSV (up to 5 MB and 50,000 rows); dry run first:
   `audiences.import {"segmentId":"seg_…","csv":"email\nalex@example.com\n","column":"email","idType":"email","dryRun":true}`
   Repeat with `"dryRun":false`. `audiences.imports {"segmentId":"seg_…"}` lists imports, counts and unmatched row numbers.
4. Freeze a dynamic segment when the audience must not move between review and send:
   `audiences.snapshot {"sourceSegmentId":"seg_…","name":"Launch list (frozen)","note":"Send on 2026-11-06"}`. Re-copy its source only on purpose with `audiences.refreshSnapshot {"segmentId":"seg_…"}`.
5. Membership is not consent: sends still check consent, suppression and delivery policy.

## Journey waits and business entry keys

```json
artifacts.create {"type":"journey","name":"Trial follow-up","content":{"purpose":"onboarding","nodes":[
  {"id":"start","kind":"trigger","label":"Order placed","config":{"event":"Order Placed","reentry":"once","entryKey":{"source":"event_property","property":"order_id","onMissing":"skip"}}},
  {"id":"wait","kind":"waitUntil","label":"Until first login","config":{"condition":{"event":"Logged In","count":{"gte":1},"within":"P30D"},"timeout":"P30D","recheck":"PT1H"},"next":[{"to":"nudge"},{"to":"done"}]},
  {"id":"nudge","kind":"email","label":"Nudge","config":{"template":"eml_…"}},
  {"id":"done","kind":"exit","label":"Done","config":{}}]}}
```

`waitUntil` holds the person until `condition` matches and continues on `[matched, timeout]`; `timeout` is at most P90D and `recheck` at least PT5M. `entryKey {source:"event_property", property:"order_id"}` makes the business key, not the ingestion message id, decide re-entry and duplicate suppression; `onMissing` is `skip` or `message_id`.

## Reporting the week

- `analytics.query {"measures":["email.sent","email.delivered","email.click_rate","email.unsubscribe_rate"],"dimensions":["day"],"from":"2026-10-24T00:00:00Z","to":"2026-10-30T23:59:59Z","order":{"by":"day","dir":"asc"}}` returns `columns`, `rows` and `meta`. Ratios are computed from their base measures after aggregation; `analytics.metrics.list` has the measure ids and allowed dimensions.
- `analytics.emailPerformance {"from":"2026-10-24T00:00:00Z","to":"2026-10-30T23:59:59Z","by":"broadcast"}`: sent, delivered, clicked, unsubscribed and the rates, per template, broadcast, journey or day.
- `analytics.journeyFunnel {"journeyId":"jrn_…","from":"…","to":"…"}`: entered → each step → goal → completed or exited, with drop-off.
- `analytics.campaignSummary {"campaignId":"cmp_…"}`: one campaign's goal, funnel, per-member rows and holdout result; `state:"not_started"` means nothing has sent yet.
- `segments.preview {"artifactId":"seg_…"}` for today's subscriber count and `ai.usage {"days":7}` for AI calls.

Breakdowns other than a time dimension hide groups smaller than k=5; read `meta.suppressed` and do not add up per-day ratios by hand. Report numbers with their denominators and compare them with last week, not with assumptions.

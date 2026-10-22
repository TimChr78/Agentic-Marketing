# Recipes

Each step is one tool call: `tool {input}`. Replace `…` ids with real ones from earlier calls. Under the approval policy "agent changes need a person", `artifacts.requestPublish` creates an approval request. Anything that references an artifact (a broadcast's template, a journey's templates) can be published only after that artifact is, so get the dependencies approved first.

## Contents
- Weekly newsletter
- Segments for the newsletter
- Welcome journey after double opt-in
- Signup form with double opt-in
- AI-chosen branch with a tested prompt
- Promoting changes from staging
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
After publishing, the site posts to `<links URL>/f/frm_…`. Signups show as `Form Submitted` and `Subscription Confirmed` events (`profiles.events`), and as consent in `consent.history`.

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

## Reporting the week

- `broadcasts.status {"artifactId":"bct_…"}`: sent, delivered, bounced, clicked, unsubscribed.
- `messages.stats {"days":7}`: all e-mail, with rates relative to sent.
- `journeys.stats {"artifactId":"jrn_…"}`: where people are, and how many reached each step.
- `segments.preview {"artifactId":"seg_…"}`: the subscriber count today.
- `ai.usage {"days":7}`: AI calls, fallbacks and tokens.

Report numbers with their denominators and compare them with last week, not with assumptions.

---
name: agentic-marketing-mcp
description: Operate an Agentic Marketing workspace through its MCP server (or the identical REST commands). Covers connecting with OAuth or an API token, the draft → validate/simulate → request-publish workflow, segments, e-mail templates, broadcasts (newsletters), journeys, signup forms, web experiences, AI prompts, webhooks and reporting, within consent and approval guardrails. Use when an agent should build or run marketing in the platform, e.g. drafting the weekly newsletter, creating a segment or journey, or reporting results.
---

# Using the Agentic Marketing MCP server

Every capability is a **command**, and every command is an MCP tool with the same name (`segments.preview`, `artifacts.create`…). It is also available as `POST /v1/<command>` over REST. The input and output JSON schemas are in each tool's definition. Errors are written to be fixed: read the message, correct the input, retry.

## Connect

- **Interactive agents** (Claude, IDEs): add the server URL `https://<platform>/mcp`. The client discovers OAuth. The person signs in and chooses which permissions (scopes) to grant; read-only is the default.
- **Scripts and automation** (cron agents, n8n): a person creates an API token in the UI (Integrations → API tokens) with the scopes needed. Send it as `Authorization: Bearer amk_…` to `/mcp` or `/v1/<command>`.

You act as an **agent principal**: the person's role permissions, limited to the granted scopes. Some tools are never available to agents, whatever the scopes:
- approving;
- managing members, providers, sources, connections and webhooks;
- secrets;
- importing consent, exporting or erasing people.

Ask a person to do those in the UI.

## The workflow for any change

1. **Look first.**
   - `artifacts.types` gives the content schema of every type; read it before writing content.
   - `artifacts.list` (filter by `type`) and `artifacts.get` show what exists.
   - `purposes.list` shows the lawful bases.
2. **Draft.** `artifacts.create {type, name, content}` makes version 1 as a draft. `artifacts.updateDraft {artifactId, content}` changes it. Content is validated on every save (MJML compiles, references are well formed, journeys have one trigger…).
3. **Check:**
   - templates: `templates.preview {artifactId, profileId?}` renders HTML and text;
   - segments: `segments.preview {condition}` or `{artifactId}` gives a count and sample;
   - journeys: `journeys.simulate {artifactId, profileId?, events?, ai?, actions?}`;
   - broadcasts: `broadcasts.preview {artifactId}` gives the audience, would-send count and skip reasons;
   - prompts: `prompts.test {artifactId}`.
4. **Request publishing.** `artifacts.requestPublish {artifactId, note}`. Under the usual policy ("agent changes need a person") this creates an approval request: tell the person what to approve and why (the note shows in Approvals). Publishing also runs publish checks, e.g. that referenced templates and segments are published.
5. **Report.** Give the ids you created and the results of your checks (counts, simulation outcome). Do not claim something was sent or published until `artifacts.get` shows `publishedVersion` or `broadcasts.status` says so.

## Guardrails (built in, do not try to work around them)

- **The send gateway decides every e-mail.** It checks the purpose's lawful basis and consent per person, suppressions and unsubscribes. "Skipped: no_lawful_basis" is correct behaviour, not a bug to fix.
- **Agents cannot record a consent**; they can only record restrictions (`consent.record` with `denied`, `withdrawn` or `objected`). Consent comes from forms, double opt-in, the SDK or a person's import.
- **Personal data is masked.** Agents see only traits the tracking plan marks `agentVisible`, and only with `profiles:pii`.
- **Writes are drafts.** Nothing reaches customers until a person approves, when the policy requires it.

## Tool catalog (by area)

Read [references/tools.md](references/tools.md) for the full list with effects and who may call each tool. The ones used most:

| Area | Tools |
|---|---|
| Artifacts | `artifacts.types`, `.list`, `.get`, `.create`, `.updateDraft`, `.history`, `.diff`, `.requestPublish`; `approvals.list` |
| People | `profiles.find {type:"email", value}`, `profiles.get`, `profiles.events`, `profiles.list`, `consent.history`, `segments.ofProfile` |
| Segments | `segments.preview`, `segments.members`, `segments.refresh` |
| E-mail | `templates.preview`, `messages.list`, `messages.stats`; `messages.sendEmail` (needs `messages:send`) |
| Newsletter | `broadcasts.preview`, `broadcasts.status`, `broadcasts.cancel` |
| Journeys | `journeys.simulate`, `journeys.stats`, `journeys.enroll` (needs `messages:send`) |
| Web | `experiences.results` |
| AI | `prompts.test`, `ai.calls`, `ai.usage`, `aiProviders.list` |
| Integrations | `connectors.list`, `connections.list`, `connections.runAction`, `webhooks.list`, `deliveries.list` |
| Workspace | `workspace.get`, `purposes.list`, `audit.list` |

## Recipes

Worked examples with full payloads are in [references/recipes.md](references/recipes.md):
- the weekly newsletter (template + broadcast, scheduled for Friday);
- a segment of engaged readers;
- a welcome journey after double opt-in;
- a signup form with double opt-in;
- an AI-chosen branch with a tested prompt;
- reporting the week.

## Content rules that save round trips

- **Ids** look like `eml_` (template), `seg_` (segment), `jrn_` (journey), `bct_` (broadcast), `frm_` (form), `prm_` (prompt), `exp_` (experience), each followed by 32 hex characters.
- **Durations** are ISO 8601: `PT6H`, `P2D`, `P1W`. **Timestamps** are ISO in UTC: `2026-10-30T07:00:00Z`.
- **E-mail templates:** MJML with Liquid.
  - Variables: `{{ profile.firstName | default: "there" }}`, `{{ content.<slot> }}` (AI-generated text), and journey context.
  - Use `{{ unsubscribe_url | raw }}` in marketing footers and `{{ confirm_url | raw }}` in double opt-in confirmations.
  - Template purposes: `marketing_email` for newsletters, `onboarding` for transactional or confirmation mail.
- **Segment conditions:** `{"trait":"plan","op":"eq","value":"pro"}`, `{"event":"Product Viewed","where":{"category":"tents"},"count":{"gte":2},"within":"P7D"}`, `{"consent":"marketing_email"}`, `{"segment":"seg_…"}`. Combine them with `{"all":[…]}`, `{"any":[…]}` and `{"not":…}`.
- **Journey nodes:**
  - kinds: `trigger`, `wait`, `waitEvent`, `goal`, `branch`, `split`, `email`, `updateProfile`, `webhook`, `action`, `transform`, `aiDecide`, `aiGenerate`, `exit`;
  - give `next` edges explicitly when a node has several outcomes (branch: `[yes, no]`; waitEvent and goal: `[matched, timeout]`; action: `[ok, error]`; split: one per weight; aiDecide: one per option).

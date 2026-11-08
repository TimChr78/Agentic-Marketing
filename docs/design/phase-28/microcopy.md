# Binding microcopy contract

Applies to real shell, fixture demo, editors, previews, hosted recipient text and all states. Owners are
screen areas in [README](README.md); shared copy belongs to I. Preserve editable tenant content and technical
code views. Translate presentation, never change command values or persisted keys.

## Voice, casing and vocabulary

Calm, direct, specific. Describe state and consequence before implementation. Speak to “you”; name the
object. One short sentence per idea. No congratulations, blame, “Oops”, “Something went wrong”, “successfully”,
“simply”, “please wait”, or promises about delivery/safety not supported by data. Use sentence case for
headings, tabs, buttons and statuses, including third-party chrome. Keep proper names and acronyms:
API, SMS, UTC, MJML, Liquid. Use “e-mail” as in the product, “sign in” as a verb, “sign-in” as an adjective.
Agent is an identity, never a status. “Published” describes a version, never implies sent or running.

| Action type | Binding verb / example | Distinction |
|---|---|---|
| New draft object | New broadcast / New form (launch); Create broadcast (confirm) | Do not alternate Add/Create/New for the same step |
| Existing item in a collection | Add step; Add provider; Upload asset | Upload only when choosing a local file |
| Persist explicit changes | Save changes | Journey keeps existing autosave: “Saving changes…” then “Changes saved” |
| Approval lifecycle | Submit for review; Review the request; Approve and publish; Reject | Keep consequence and exact version; never shorten approval to “OK” |
| Send | Send me a test; Send broadcast | Keep recipient/schedule summary and role distinctions |
| Operational state | Pause agent; Resume agent; Revoke token | Name object in accessible label, even when context permits shorter visible label |
| Destructive | Delete secret; Erase person | Retain existing confirmation and semantics; no generic “Remove” for irreversible erasure |
| Read / navigate | View report; Show data table; Open template | “Edit” only where edits are allowed |
| Recover | Retry; Clear filters; Change period | Retry repeats only the failed read unless explicitly a safe existing mutation retry |
| Clipboard | Copy ID; Copy link | “Copied” only after clipboard resolves; failure says “Couldn't copy. Select and copy the value.” |

## Empty, error and loading states

Empty = **what is absent + why/scope + next existing action**. Creation empty: “No forms yet. Create a form
to collect signups.” → New form. Filter empty: “No broadcasts match these filters.” → Clear filters.
Period empty: existing “No sends in this period.” → Change period. No-data rates show em dash, not 0%.
Read-only roles get an allowed destination or “Ask a workspace admin to create a form”; never a forbidden CTA.
Every list empty state names its next action, even if no action button is permitted.
Home “No active agents” becomes “No active agents in this sample. View agents to check their status.”
Do not turn a sample into an exhaustive count.

Error = **failed object/action + known effect + recovery**. “Couldn't load providers. Saved settings are
unchanged. Retry.” Partial reads say which channels failed and retain successful results. Do not echo raw
server exceptions, stack traces, command keys or credentials. Map known errors to existing user labels;
unknown errors say “Couldn't load the report. Retry.” Technical diagnostics remain in existing developer views.
Mutation errors must not claim nothing changed when outcome is unknown: “Couldn't confirm the save.
Refresh to check the current version.” Preserve typed input and existing conflict handling.

Loading = **present participle + object**: “Loading performance”, “Loading invitations”, “Saving changes…”.
`UsersPage.tsx` currently says “Loading people” for workspace members: use “Loading members”. No unlabelled
ellipsis, generic “Working”, false percent progress or shifting button text. See reserved-state timing in
[skeleton rules](skeletons-and-budgets.md). Announce once per region, not every skeleton bar.

## Labels, numbers and dates

- Use existing friendly-name registries. Consent currently shows `web_personalization`; say “Personalization”.
  Template and segment selectors show “Marketing e-mail (marketing_email)”; say “Marketing e-mail”. Preserve
  the technical value invisibly. Missing referenced name: “Unavailable purpose”, with existing copy/details
  affordance; never silently choose another purpose. Editable key fields and MJML/Liquid/code remain intact.
- Format counts with locale grouping (`1,240` in English), integer people/sends. Rates include denominator;
  compare rates in percentage points (`0.2 pp higher`), counts in relative percent. Keep source precision;
  no new rounding thresholds. Use existing common formatters. Don't mix unavailable, suppressed and zero.
- Period, denominator and freshness remain visible on every metric. Suppression must not leak through text,
  tables, tooltips or export. No “healthy” judgement on absent data, no infinity delta from zero baseline.
- Dates use the workspace time zone and locale via existing formatters: e.g. “8 Nov 2026, 14:30 UTC”. Short chart
  ticks “8 Nov” retain full date/zone in table or detail. “Updated 4 h ago” has an absolute accessible timestamp.
  Missing date = “Not available”, never epoch/1970. Existing date inputs and UTC storage stay unchanged.
- Unknown-count lists say “50 loaded”, not “50 people” as total. Singular/plural follows count. Buttons keep
  object context in accessible names. Text and icons accompany every status colour.

## Demo and banned patterns

Keep the Phase 27 demo boundary. Banner wording: “Demo · sample data”. Hint: “Explore with sample data.
Sending and AI execution are unavailable in the demo.” Disabled actions explain this truth, never pretend to
send/save remotely. Preserve existing allowed local interactions; no new demo capabilities. Do not call
production fixtures “live”. Legacy walkthrough retirement wording stays explicit.

Ban raw prefixed IDs in ordinary headings/toasts, `email.sent` as a metric label, raw purpose keys in selectors,
raw enum casing, “No data” without scope or next action, “Loading…” without an object, generic “Error”, green
healthy zero-volume verdicts and unqualified “it's safe” claims. Product examples: replace “Select an element
before using Style Manager” with “Select an element to edit its styles”; replace strict-input safety guidance
with the bounded seven-day observation in audit S2. Technical setup may show `STRICT_INPUTS=true`, scope names,
API paths and Liquid expressions in explicitly labelled code; identifiers belong in the existing copy control.

I supplies a rendered-DOM lint with narrow allowlists (Identifier, code editor, technical setup, user-authored
content). Detect seeded `prf_`, `agt_`, `tok_`, `jm_`, known purpose/metric keys in ordinary text and options.
Do not regex-rewrite source values or ban arbitrary underscores. Each exception records selector and reason;
area tests assert friendly labels for known and unresolved references. Human review covers grammar/meaning.

# Open questions

## Decided (2026-10-21)

| # | Question | Decision | Recorded in |
|---|---|---|---|
| 1 | Build fresh vs. fork Dittofeed | **Build fresh**, Dittofeed as reference | [ADR-0001](adr/0001-build-vs-fork.md) |
| 2 | Project license | **AGPL-3.0 core, MIT SDKs, CLA** | [ADR-0009](adr/0009-project-license.md) |
| 3 | System of record | **Own profile store**, warehouse sync later | [data-platform.md](data-platform.md) §7 |
| 6 | Email tracking defaults | **Click tracking on, open pixel off**, configurable | [channels-and-personalization.md](channels-and-personalization.md) §2 |
| 7 | First-party integrations | **Not a v1 priority**; Shopify and Salesforce first when built | [roadmap.md](roadmap.md) Phase 5 |
| 8 | Product name | Keep `agentic-marketing` placeholder until first public release | — |
| 9 | First install | **Local / homelab**, outbound email via **SMTP relay** | [deployment-and-scaling.md](deployment-and-scaling.md) §1 |

## Still open — to verify while building

| # | Question | Default assumed | Affects |
|---|---|---|---|
| 4 | **OpenAI OAuth**: does OpenAI offer an OAuth flow usable by third-party apps for API access (and under which terms)? | Credential abstraction supports OAuth; API keys work regardless | [agents-and-mcp.md](agents-and-mcp.md) §4 |
| 5 | **Email editor**: GrapesJS + MJML vs. Easy Email — confirm in spike | GrapesJS | [ADR-0006](adr/0006-email-format-and-editor.md) |
| 10 | **Legal review** of legitimate-interest policy templates and default retention periods | Templates marked "review required" | [security-and-privacy.md](security-and-privacy.md) |

# Web app — Phase −1 interactive demo

A clickable demo of the product with a **mocked backend that runs in the browser**. It is built in the target UI stack (React, Vite, Tailwind, React Flow, GrapesJS + MJML, ECharts) so it can grow into the real UI.

## Run it

```bash
pnpm install          # from the repo root
pnpm dev              # http://localhost:5173
pnpm build:demo       # single-file build → apps/web/dist-single/
```

`build:demo` writes `dist-single/index.html` (one self-contained file) and `dist-single/artifact.html` (the same page without the document wrapper, for publishing as a claude.ai Artifact).

## What is in it

| Screen | Shows |
|---|---|
| Overview | KPIs, guided demo tour, journeys, pending approvals, agent activity |
| Live site demo | A fake shop. Cookie consent gates tracking; three shoe views put the visitor in a real-time segment and switch the hero **in-session**; sign-up stitches the anonymous history into a profile; leaving with a full cart triggers the abandoned-cart journey and the send gateway (try `anna.jensen@example.com`, who has objected to marketing e-mail) |
| Journeys | Journey list and a React Flow builder: palette, inspector, versions, live stats, **simulation with a virtual clock**, publish / request approval |
| E-mail templates | GrapesJS with the MJML preset, MJML + Liquid code view, preview rendered per profile and A/B variant |
| Profiles | Traits, identities, consent & lawful basis ledger, “Can we e-mail?”, access export, erasure |
| Analytics | E-mail engagement, journey funnel with holdout uplift, A/B result, personalization uplift |
| Approvals | Configurable policy (none / agent changes / all publishes), structural diffs, approve & publish |
| Channels & MCP | SMTP relay, Umami destination, BYOK LLM providers, the MCP tool catalogue generated from the command registry, audit log |
| Copilot | Agent principal using the same commands. **Scripted** scenarios always work; **Live** mode calls an Anthropic- or OpenAI-compatible endpoint with your key (local dev only — the published single file cannot make outside network calls) |

## How the mock is structured

- `src/api/commands.ts` — the mock **command registry** (`defineCommand`-style list). The UI, the copilot and the MCP catalogue all use it; every call is written to the audit log with its principal.
- `src/mock/store.ts` — in-memory “database” (zustand) seeded from `src/mock/seed.ts`.
- `src/mock/live.ts` — mock of the ingest → session state → decide hot path and the journey trigger matcher, compressed in time.
- `src/copilot/` — scripted scenarios and the live LLM loop (`@anthropic-ai/sdk` for Anthropic-compatible endpoints, `fetch` for OpenAI-compatible ones).

Replacing the mock later means swapping `exec()` for a typed client of the real API; screen code stays the same.

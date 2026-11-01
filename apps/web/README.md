# Admin UI

The production admin UI of Agentic Marketing. The server serves it at `/`; every screen calls the
same commands as REST clients and AI agents, under the same permissions, approvals and audit log.

It is built with React, Vite, Tailwind CSS, React Flow, GrapesJS with the MJML preset, ECharts and
TypeScript. The typed API client is inferred from the command registry, so a command change breaks
the build.

## Run it

Requirements: Node 22+ and pnpm 10. From the repo root:

```bash
pnpm install
pnpm dev                # the API on http://localhost:3000 (migrates on start)
pnpm dev:web            # the UI on http://localhost:5173
```

The Vite dev server proxies `/api`, `/v1`, `/mcp`, `/openapi.json` and the public link paths to the
API at `API_URL` (default `http://localhost:3000`), so the session cookie works without CORS.

A seeded workspace is easier for UI work: it starts a fresh `am_e2e` database, the API and the built
UI on port 3100.

```bash
npx tsx apps/server/test/e2e/server.ts        # API + built UI on http://localhost:3100
API_URL=http://localhost:3100 pnpm dev:web    # the dev UI against it on :5173
```

People: `alex@example.com` (owner), `sam@example.com` (builder), `jo@example.com` (approver),
`vic@example.com` (viewer); password `correct-horse-battery-staple`. Set `TRUSTED_ORIGINS` if you
use another origin.

## Builds

```bash
pnpm --filter @agentic-marketing/web build:live   # the admin UI → apps/web/dist
pnpm build:demo                                   # the demo as one file → apps/web/dist-single
```

`build:live` is the production build: the Docker image runs it and copies `apps/web/dist` into
place, so the server serves the admin UI at `/`. When the directory exists the server serves real
assets and falls back to `index.html` for extension-less paths; set `WEB_DIST` to serve a different
build. Without it the server runs API-only.

`build:demo` (the `build:single` script) writes `dist-single/index.html`, one self-contained file,
and `dist-single/artifact.html`, the same page without the document wrapper for publishing as a
claude.ai Artifact. The demo is also a lazy chunk at `/demo` in the production build.

## `src/` layout

```
src/
  app/        shell, router, navigation, session, theme, search palette and the typed API client
  ui/         design system: buttons, fields, drawers, modals, toasts, tables, tabs, menus, code and diff views
  features/   larger parts: agents, approvals, previews, the journey builder, artifacts, assets, brand, campaigns,
              topics and content, templates and blocks, providers, tokens, integrations, insights, settings, copilot
  pages/      one file per route, grouped by area (approvals, build, design, audience, insights, settings, artifacts)
  lib/        small shared helpers (layout, theme, CSV import)
  mock/       in-memory backend for the demo
  copilot/    scripted and live LLM loop for the demo
  screens/    demo screens
  components/ demo UI pieces
  api/        the demo's mock command registry and types
```

The UI follows [docs/design/DESIGN.md](../../docs/design/DESIGN.md) (tokens, components, layout,
accessibility); calls made while building it are in
[docs/design/DECISIONS.md](../../docs/design/DECISIONS.md). Hide actions a role cannot use with
`can('<permission>')`; the router does the same for pages.

## Tests and e2e

```bash
pnpm vitest run --project web                     # unit and component tests (jsdom)
pnpm e2e                                          # Playwright: builds the UI, starts the seeded server, runs e2e/*.spec.ts
E2E_BASE=http://localhost:5173 pnpm e2e:dev       # against a running dev UI and seeded server instead
CHROMIUM=/usr/bin/chromium pnpm e2e               # use a system Chromium instead of Playwright's download
node e2e/screenshots.mjs docs/design/screenshots  # screenshots of every screen, light and dark, 1440 and 768 px
```

The web tests live in `apps/web/test`; the Playwright specs in `e2e/`. See
[docs/development.md](../../docs/development.md) for the rest of the development setup.

## Demo

`/demo` is a clickable demo with sample data and a mocked backend that runs in the browser. It is a
lazy chunk in the production build, linked only from the sign-in page. The mock still lives in
`src/mock` (in-memory store, seed and the ingest → session → decide hot path), `src/api/commands.ts`
(the mock command registry) and `src/copilot` (scripted scenarios and the live LLM loop). The demo
screens are in `src/screens` and `src/App.tsx`; the single-file build is the demo alone.

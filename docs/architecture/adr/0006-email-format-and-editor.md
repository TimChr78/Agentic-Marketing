# ADR-0006: MJML + Liquid as canonical email format, GrapesJS editor

- Status: Accepted (confirmed by spike 2)
- Date: 2026-10-21

## Context
Emails are edited by humans in a visual editor and by agents as text; both must work on the same source, and output must render in all email clients.

## Decision
Store templates as **MJML with Liquid** placeholders. Visual editing with **GrapesJS + grapesjs-mjml** (BSD-3), which imports/exports MJML so agent-authored templates remain visually editable. Code view in Monaco. Rendering: LiquidJS → MJML → HTML + text.

## Alternatives
- **Easy Email (MIT)** — React-native, MJML-based, but uses its own JSON block model (round-trip from arbitrary MJML uncertain) and maintenance cadence is uncertain; evaluate in the spike.
- **Unlayer / Beefree** — proprietary.
- **React Email** — great for developers, not for a marketer visual editor or LLM-authored source.

## Consequences
Editor is swappable because the storage format is the open MJML standard. GrapesJS needs a React wrapper and custom blocks for our content slots and snippets.

## Validation (spike 2, 2026-10-22)
[`spikes/email-editor/FINDINGS.md`](../../../spikes/email-editor/FINDINGS.md): five LLM-style templates round-tripped through both editors. GrapesJS needs two normalisation steps (expand self-closing `mj-*` tags; unescape entities inside Liquid tags) and `mj-table` locked as code; with those, 4/5 templates were pixel-identical with all Liquid intact. Easy Email drops `mj-preview`/`mj-title` and overrides template styles (1.6–5.6 % pixel drift), so it is rejected.


# ADR-0006: MJML + Liquid as canonical email format, GrapesJS editor

- Status: Proposed (confirm after spike)
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

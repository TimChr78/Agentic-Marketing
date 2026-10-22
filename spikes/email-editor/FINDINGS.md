# Spike 2 — Can the visual e-mail editor round-trip MJML written by an agent?

**Question:** agents write templates as MJML + Liquid; people edit them visually. Does a template survive *import → (edit) → export* in GrapesJS (`grapesjs-mjml`) and in Easy Email, with Liquid intact and the rendered e-mail unchanged? ([ADR-0006](../../docs/architecture/adr/0006-email-format-and-editor.md))

**Answer: GrapesJS, with two small normalisation steps around the editor.** With those, 4 of 5 templates came back pixel-identical with every Liquid tag intact, and the 5th lost only an `mj-table`'s inner rows. Easy Email kept Liquid in the body but always drops `mj-preview` / `mj-title` and injects its own default styles, so agent-written e-mails change appearance just by being opened.

## Method

Five templates written the way an LLM writes them (`templates/`): `mj-head` with `mj-attributes`, `mj-class`, `mj-style`, `mj-font`; Liquid variables with filters, `{% if/elsif %}` with comparison operators, `{% for %}` loops in `mj-raw`, a hero, navbar, social, three-column grid, `mj-wrapper`/`mj-group`, accordion and `mj-table`.

`src/roundtrip.ts` bundles both editors with esbuild, loads them in headless Chromium, imports each template, exports it (once untouched, once after a typical edit: a sentence appended to the first text block) and compares:
- **Liquid**: every `{{ … }}` / `{% … %}` token, as a multiset, input vs output;
- **validity**: MJML validation errors of the output;
- **rendered text** and **pixels** (mjml → HTML → screenshot at 700 px, pixelmatch).

Outputs are written to `out/` for inspection.

## Results (untouched round-trip; the edited round-trip gave the same Liquid/validity results)

| Template | GrapesJS as-is | GrapesJS + normalisation | Easy Email |
|---|---|---|---|
| 01 welcome (head attributes, styles) | Liquid 6/6 · 0 errors · **8.0 % pixels differ** | **identical** (0 %) | Liquid 5/6 (preview text lost) · 5.6 % pixels |
| 02 cart loop (`{% for %}` in `mj-raw`) | identical | **identical** | Liquid 11/12 (preview lost) · 3.2 % |
| 03 newsletter (hero, navbar, social, images) | **8 MJML errors**, text differs | **identical** | Liquid n/a · 3.8 % |
| 04 win-back (`{% if a > 3 %}`, `mj-table`) | **2 Liquid tags corrupted** (`>` → `&gt;`) | Liquid 9/9 · table rows lost · 1.9 % | Liquid 9/9 · 4.2 % |
| 05 receipt (`mj-wrapper`, `mj-group`, accordion, `mj-font`) | **6 MJML errors** | **identical** | Liquid 8/8 · 1.6 % |

## What goes wrong, and the fixes

**GrapesJS (`grapesjs-mjml` 1.0.8)**
1. **Self-closing tags are parsed as open tags.** `<mj-image … />`, `<mj-divider />`, `<mj-all />` etc. go through an HTML parser, so the following siblings get nested inside them, producing invalid MJML and broken head attributes. **Fix:** expand self-closing `mj-*` tags to explicit pairs before import (one regex).
2. **Liquid operators get HTML-escaped.** Inside text blocks `{% if x > 3 %}` comes out as `{% if x &gt; 3 %}`, which breaks the template. **Fix:** unescape entities *inside* Liquid delimiters on export (one regex).
3. **`mj-table` content is flattened** (rows and cells become plain text). **Fix:** treat `mj-table` (and `mj-raw` with markup) as a locked block that is edited as code, or have agents use columns instead of tables.
4. Attributes equal to MJML defaults are omitted on export (e.g. a white button text). Harmless; rendering is identical.

**Easy Email (4.17.1)**
- `mj-preview` and `mj-title` are dropped: the inbox preview text, often personalised, disappears.
- Its own defaults (font stack, 14 px, black text, line-height 1.7) are appended **after** the template's `mj-attributes`, so they win. Every agent-written template changes look on first open.
- It converts MJML into its own JSON block model; MJML features without a block equivalent are at risk. Fixing these means forking its converter.

## Decision input

- Keep **GrapesJS + grapesjs-mjml** (ADR-0006 confirmed), wrapped in a small adapter with the two normalisation steps and `mj-table` locking.
- Turn this spike's checks into **save-time guards** in the product: on every save from the visual editor, compare Liquid tokens with the previous version and validate the MJML. A save that would drop or alter Liquid is blocked with a clear message. This also protects agent-written templates edited by people, and vice versa.
- Easy Email stays out: the visual drift and the lost preview text are inherent to its JSON model.

## Run it

```bash
pnpm install
pnpm --filter @agentic-marketing/spike-email-editor roundtrip   # writes out/*.mjml and out/results.json
```

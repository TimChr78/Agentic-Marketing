# Preview provenance and e-mail editor · #499

## Shared label contract

E owns PreviewLabel and previewSource.ts, plus the renderer wrappers. C wires ArtifactDetailPage;
A wires review. Source is a discriminated union in README. Always place a text label **above** the
rendered output, not a hover hint, iframe decoration or only a publication status pill.

- **Unsaved draft**; secondary “Based on Saved vN”. Only when the rendered metadata/body is actually
  derived from local inputs. Never silently show a saved body under this label.
- **Saved vN**; secondary “Under review” in approvals, or “Not published” when appropriate.
- **Published vN** only when the render is explicitly pinned to the published pointer. A new draft
  beside a published version displays both sources separately, never one ambiguous “Preview”.

| Artifact / surface | Label location and render source |
|---|---|
| Broadcast Content composer | Outer Unsaved draft/Saved vN above local configuration; inner Published vM/Saved vM immediately above template subject/frame. Configuration is local, template body remains version-pinned. Dirty eligibility reads disabled; save-required explanation per composer. |
| Broadcast review | Saved vN · Under review above consequence/artifact; nested template Published vM or Saved vM · In this bundle. Never substitute latest draft for a bundle pin. |
| E-mail template Content/Preview | Content draft beside editor says Unsaved draft while dirty; local render rules below. Clean preview uses templates.preview({artifactId,version}) and returned version. Publish pointer selection renders Published vN. Subject/preheader and text belong to the same source. |
| Email block | Above BlockPreview; saved uses blocks.preview at explicit version. Dirty block render not supported by that command: show Unsaved draft above local structured editor and “Save draft to render this block”; no saved frame under Unsaved. Parameter sample values remain visibly samples. |
| Journey | Above read-only graph. Local nodes render Unsaved draft; review exact content Saved vN; explicitly selected live definition Published vN. Stats are not draft content. |
| Form | Above FormPreview, directly from supplied local or exact saved content. Preview is illustrative and cannot submit or create consent. |
| Segment | Above ConditionView/mode summary. Local condition Unsaved draft; count separately says “Save draft to estimate membership”. Saved segments.preview count gets Saved vN and as-of completion time; requires profiles:read. |
| Experience | Above structured variant content; dirty content Unsaved draft, exact review Saved vN, explicitly selected live Published vN. Sandboxed variant HTML without SDK visitor simulation; JSON remains JSON. |
| SMS/push and remaining artifact types | Above the existing renderer or JSON fallback for supplied exact content. Channel server renders, if used, must be version-pinned; while dirty and no local renderer exists say “Save draft to render”; local structured content may still say Unsaved draft. |
| Brand hosted previews | hostedPages.preview accepts inline `brand` and returns html only (no version). With local brand input label Unsaved draft and pass that content. For a saved/published brand resolve artifacts.get at the chosen exact version and pass its content as brand, then label Saved/Published vN from that read. If formId is supplied its override is always the published form: label that separately Published vM after resolving its pointer. No unsaved form override claim. No brand artifact means “Default hosted-page theme”, not v0. |
| Workspace proposal | “Proposed settings · not applied”; no invented artifact versions. |

C owns host routing of dirty/source props for all ArtifactDetailPage families; E owns wrappers and
features/brand/HostedPreview.tsx for the hosted-label adjustment (exclusive extension of E ownership).
A owns approval header. No unrelated list, route or frozen foundation edits. In a diff, explicitly
label Before Published vM and After Saved vN; empty base “Nothing published”. Reuse same metadata
when changing width/theme; these are view modes, not new content versions.

## Unsaved e-mail rendering boundary

Current templates.preview accepts artifactId, version, data, profileId, **not content**. Reuse the
existing local Liquid + mjml-browser render pipeline in screens/EmailEditor.tsx as a factored local
helper for the active features/templates editor; do not call a saved server render and label it
unsaved. Use only template.sampleData, existing placeholder URLs for unsubscribe/preferences/web
as in packages/email/src/render.ts, and same preheader insertion convention. Debounce local render
300 ms; sequence requests so old completions cannot replace new input. Show “Rendering draft…”
while pending; failure replaces frame with “Couldn't render this draft” and the parser error.
No hidden save and no new endpoint. No real profile read or personalization claim.

The local helper does not have the server's custom Liquid block resolver or full server parity.
For drafts containing `{% block ... %}` or unsupported server-only tags, do not strip/flatten them
or execute a fake renderer: show “Save draft to render reusable blocks” above a collapsed, separately
labelled **Saved vN · previous saved preview** if available. The Unsaved label remains on local
structured content, not that saved frame. This is a deliberate limitation within existing read paths.
For the Text view while dirty, render an explicit draft.text with the same local Liquid scope.
If draft.text is absent, show “Save draft to generate the text version”; the local helper does
not invent a browser HTML-to-text substitute. Only saved server previews are authoritative for checks/test mail. templates.check stays pinned to
saved version and says so while dirty. No new pass/fail validation semantics in browser renderer.

## Editor chrome and palette

The production editor is features/templates/TemplateEditor.tsx + VisualMjml.tsx, not the legacy
mock-store screen. Preserve subject/preheader/purpose/topic fields, Visual / MJML and Liquid modes,
Liquid-loss warning, raw code path, image assets, sample data, text part, UTM, undo/redo and dirty
navigation guards. Do not migrate GrapesJS or install dependencies. Header primary action remains
Save draft/Publish/Submit for review from the existing host.

One toolbar, ordered: Visual / MJML and Liquid; Insert; Undo; Redo; Outlines; Preview. Styles,
Settings and Layers remain named inspector tabs. Remove duplicate GrapesJS Code, Import, Blocks,
Full screen and Preview controls; code mode and app preview already provide these paths. Supported
MJML is preserved on load/save even if its insertion tile is hidden.

Insert opens an anchored, keyboard-operable dialog (320 px desktop, full-width sheet below 768),
with two tabs **Elements** / **Reusable blocks**, search input, and textual results. Elements order:
Text, Image, Button, Divider, Spacer, Columns. Columns offers One / Two (no third-level library).
Map to the existing plugin's MJML text/image/button/divider/spacer/section+column components;
no social/hero/navbar/carousel/raw-html tiles in the basic palette. Insert selected element into
selected compatible column, else first column; Columns adds a section after selected section.
If no body/column exists, insert a valid section/column wrapper. Click/Enter is sufficient; drag
is optional. Focus returns to Insert, selection moves to inserted component.

Reusable blocks reuses BlockPicker list/loading/error and blockTagSnippet typed parameter
placeholders. Show name plus Published vN / Not published. Insert uses the current code-mode tag
path (switch to MJML and Liquid and insert at caret or append), with helper “Fill parameter values;
the published block expands on saved preview”. Do not flatten into MJML or enable lossy visual
round-tripping of block tags. No block creation/publication within this palette. Empty: “No reusable
blocks yet. Create one in Design → Blocks”; failure Retry; search no-results distinct from no data.
Image opens existing AssetPicker; no duplicated URL/upload flow.

Scope editor.css under .am-gjs. Restyle GrapesJS panels, tabs, property labels/inputs/selects,
layer tree, traits, block tiles, tooltips, selection labels, RTE toolbar and dialogs. Use surface,
surface-2/3, fg/fg-2/muted, control, accent, accent-soft tokens from v2; active states text +
selected marker. Keep neutral chrome separate from e-mail body colours; app theme cannot recolour
the message by accident. Use system font13/20 and labelled ≥40 px controls on touch. Remove inline
legacy greys and opacity-based disabled states, including .gjs-four-color variants. Contrast ≥4.5:1
for ordinary text and ≥3:1 controls/focus in both themes. No global CSS affecting other editors.

Preview toolbar: width Desktop (640 px message within max1024 frame) / Mobile (375 px), plus
**Dark mail** toggle independent of app theme. Frame width min(preset, available); 390 content358
constrains both. Dark mail is labelled “Approximation — mail clients vary”, applied only inside
preview document using a deterministic scoped dark-mail stylesheet (background #111512, text
#edf0e9, links #8baafa, preserve images). Do not invert images, mutate saved MJML, or claim actual
Gmail/Outlook emulation. HTML / Text switch persists; text ignores width/dark-mail controls.
Frames are sandboxed with no scripts; no live form submissions. App light/dark remains independent.

1440: editor canvas minmax(0,1fr), 280 px inspector; palette is transient. 768: canvas full width,
inspector below, one open panel. 390: same, min-width 0; controls wrap in ordered rows, canvas fits
available width; inspector disclosure below. Remove current min560/overflow-x-auto combination
that forces horizontal editor chrome scroll; canvas itself may have a labelled focusable viewport
when a real document cannot fit. Code view remains fully usable on mobile, not a forced fallback.

## Fix and remove both axe exceptions

1. `color-contrast` on template: replace the old #888686/#2c2e35 GrapesJS chrome with scoped token
   pairs above, including hover/selected/disabled/tooltips/property labels. Verify actual computed
   colours after plugin injection in **both** themes; a stylesheet that loses specificity is no fix.
2. `scrollable-region-focusable`: the views/palette/layer/property scroll containers must either
   contain keyboard-focusable controls or have tabIndex=0, role=region and an accessible label.
   Keep arrow/PageUp/PageDown scrolling, visible focus, and an exit with Tab; no focus trap outside
   the Insert dialog. Removing overflow without making content reachable is not a fix.

Remove exactly the two template entries from e2e/axe-known-issues.json only after current axe
matrix passes without them (retain comment and issues:[]). Verify keyboard insertion/return,
scrolling, dark/light selected states, Liquid/block preservation and draft-render failure. No
new allowlist and no blanket exclusion of GrapesJS. Read-only users get preview and disabled
editing reason; never instantiate a writable GrapesJS canvas for them.

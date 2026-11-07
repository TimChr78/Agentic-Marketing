# Phase 25 · screen contracts

Design handoff for #496, tracker #501, implementation #497–#500 (0.11.0).
Read with [DESIGN v2](../DESIGN.md), [inventory](../wave-5-data-inventory.md),
[Phase 24](../phase-24/broadcasts.md) and [wave plan](../../architecture/roadmap-wave-5.md).
Checked against the current handlers and 0.10.1 UI, including the visual snapshot matrix.
These are proposed contracts for review, not a claim of human approval. Application code is unchanged.

- [Composer](composer.md) — #497.
- [Approval review](approval-review.md) — #498.
- [Preview and editor](preview-and-editor.md) — #499.
- [Report](report.md) — #500; explicit inventory-permitted B4 cut.
- Offline mock-ups: [composer](mock/composer.html), [approval and bundle](mock/approval-review.html),
  [editor](mock/editor.html), [report](mock/report.html). Each embeds independent 1440 and 390 px
  frames, v2 tokens, theme and scenario controls. No assets, fonts, fetches or external requests.
  The 1440 frame scrolls inside its labelled container on a small host window; the 390 frame
  represents the mobile application. Frames use responsive CSS at their actual width.
  Mock controls demonstrate layout/state only; they never save, approve or send.

## Exclusive ownership

Paths below are relative to `apps/web/src` unless prefixed otherwise. A row owns every named file,
including its imports. No task edits a file owned by another task. New directories are explicit
namespaces, not permission to edit similarly named existing files.

| Task | Exclusive existing files | New files / tests |
|---|---|---|
| C · #497 composer | `pages/build/BroadcastPage.tsx`, `features/artifacts/BroadcastEditor.tsx`, `features/artifacts/ArtifactDetailPage.tsx`, `features/broadcasts/BroadcastConsequence.tsx` | `features/broadcasts/composer/*`, `features/broadcasts/composer/composer.test.tsx` |
| A · #498 review | `pages/approvals/ApprovalsPage.tsx`, `features/approvals/ApprovalDrawer.tsx`, `features/approvals/viewed.ts` | `features/approvals/ConsequenceSummary.tsx`, `features/approvals/consequences.ts`, `features/approvals/consequences.test.tsx` |
| E · #499 previews/editor | `features/previews/*` (all current renderer wrappers), `features/templates/*`, `features/blocks/BlockPicker.tsx`, `features/blocks/model.ts`, `features/brand/HostedPreview.tsx`, `screens/EmailEditor.tsx` (legacy renderer only if factoring its local render helper), `e2e/axe-known-issues.json` | `features/previews/PreviewLabel.tsx`, `features/templates/editor.css`, `features/templates/InsertPalette.tsx`, `features/previews/previewSource.ts`, `features/previews/previewSource.test.ts`, `e2e/phase25-editor.spec.ts` |
| R · #500 report | `features/broadcasts/BroadcastReport.tsx`, `features/broadcasts/period.ts` | `features/broadcasts/report/*`, `features/broadcasts/report/report.test.tsx` |

C owns ArtifactDetailPage because it wires draft state into preview renderers. E exports renderers;
E does not edit that host. R keeps `BroadcastReport({artifactId,active})` unchanged: C retains the
existing Report tab import. A consumes E's interfaces in its own drawer. E owns removal of the two
axe exceptions after passing verification. `e2e/visual.spec.ts`, its snapshots, package manifests,
lockfiles, generated command types/catalogues and shared test config are integration-owned;
parallel tasks must not update them. Final integrator alone regenerates the affected visual
baselines and runs the existing matrix. No B4 server/schema/registry change is authorized by this
contract, since its safe-display gate is not met.

Frozen inputs: DESIGN.md, showcase, shell/nav/routes, `ui/ListPage.tsx`, `ui/DetailPage.tsx`,
`ui/charts.tsx`, `ui/state.tsx`, `ui/layout.ts`, `lib/state.ts`, `lib/labels.ts`, index.css and
existing operational state/approval policy helpers. No token changes, global GrapesJS overrides,
new route, new publish policy, general pause/resume or new data lifecycle. Local scoped CSS only.

## Shared interfaces and sequencing

E lands these additive exports first; C/A can work against these signatures without editing E files:

```ts
type PreviewSource =
  | { kind: 'unsaved'; baseVersion: number }
  | { kind: 'saved'; version: number }
  | { kind: 'published'; version: number };
// PreviewLabel({source: PreviewSource, suffix?: string})
// ArtifactPreview existing props plus source?: PreviewSource
// EmailPreview existing props plus source?: PreviewSource
//   and draftContent?: TemplateContent (local render only; never passed to server)
// BroadcastPreview existing props plus source?: PreviewSource
//   and eligibility?: 'load' | 'save-required' (default 'load')
```

`source` is presentation provenance; it cannot change which version is fetched. Default source
for old callers: explicit version is Saved vN; without a version, resolve the returned version
and publication pointer before choosing a label. Never infer Published from a caller omission.
ArtifactPreview passes its supplied e-mail content as EmailPreview.draftContent only when
source.kind is unsaved; saved renders ignore draftContent and use explicit version.
C supplies draft `content` and `source` to ArtifactPreview via its existing editor/preview host;
for unsaved broadcasts `eligibility='save-required'` prevents a saved-version audience fetch.
E's BroadcastPreview derives message selection from supplied content, not a second broadcast read.
C may wrap it beside the composer, A may use it compactly below consequences.

1. E defines the exports above and the saved-versus-local render boundary. No new command input.
2. C and A adopt the interfaces; C alone adds the optional host wiring in ArtifactDetailPage.
   Preserve default behaviour of all other artifact hosts. A creates its own summary data adapter,
   never imports composer hooks with mutations or editor state.
3. R works independently within the existing Report tab boundary; period utilities remain R-owned.
4. Integrator runs typecheck, relevant unit tests, existing approval/version/bundle tests, both-theme
   axe (including template), and screenshots at 1440/390. Manually verify 768, keyboard/focus,
   200% zoom, and stale response handling. No baseline update can excuse a permission/version leak.

## Common geometry and states

Use the existing expanded shell, DetailPage headers, tabs, consequence and context slots.
1440: page cap and 800/24/320 main/context geometry from Phase 24. Inside the composer Content
panel only, use two equal minmax(0,1fr) columns with 24 px gap; do not add another 320 px context.
768: 720 px main area, context below; composer and review content stack. 390: 16 px gutters,
358 px content, one column, 40 px controls, wrapping labels and values. Drawers become full width.
Local tab/tool strips can scroll in a labelled focusable region; the page never scrolls sideways.
No hover-only information. Loading preserves section dimensions; errors stay local when other
reads succeed. Restricted reads are skipped entirely. Null/suppressed/unknown never become zero.

## Verification of this handoff

All four standalone documents were rendered with the configured authenticated Crawl4AI browser
at 1440 light and 390 dark; the approval example included its bundle. Those eight renders succeeded
with no captured console messages. Desktop/mobile screenshots were inspected; mobile field widths
and chart tick sizes were corrected. A Node VM construction check exercised all 28 scenarios ×
2 themes × 2 frame slots, including parsing every inner script and checking for external resource
references. This is design-artifact verification, not application axe or implementation acceptance.
T3's local HTML preview could not run because its host browser libraries are missing; no host setup
or application dependencies were changed. Production screenshot/axe acceptance remains the final
integrator's responsibility after implementation.

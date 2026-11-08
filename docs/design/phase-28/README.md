# Phase 28 · polish and verification

Contract #551 · tracker #553 · Wave 5 epic #439 · release **0.14.0**.
Docs only. This is the last phase of Wave 5, not a new redesign. Implementation and human visual approval remain outstanding.

## Binding inputs and scope

Read [wave plan](../../architecture/roadmap-wave-5.md), especially Phase 28, Done criteria and How we work;
[DESIGN v2](../DESIGN.md), [decisions](../DECISIONS.md), and [Phase 27 ownership precedent](../phase-27/README.md).
This contract binds [audit](audit.md), [microcopy](microcopy.md), [motion](motion.md),
[skeletons and budgets](skeletons-and-budgets.md), [verification](verification.md) and the
[offline polish mock](mock/polish.html). The mock illustrates states, not a replacement page template.
Area data fields, tabs, controls, preview provenance and responsive destinations remain those of Phases 24–27.

Evidence: supplied read-only `/mnt/user/appdata/t3code/tools/p28-audit/shots/` (258 masked captures,
43 route/scenario names × 1440/768/390 × light/dark), `build-live.txt`, main v0.13.0 seeded fixture.
Source checkout for this contract: `f3bd8681b87ca49ac6181762907d9496c7baaf38` on `origin/feat/phase-28`.
These are different evidence baselines; no claim of a newly measured integrated build. Audit screenshot names
resolve in that external directory. Do not modify it or commit the 258 images. I captures fresh release images.
User reports phase axe: zero violations / 43 checks; current visual subset: 12 routes. Neither proves the wave done.

## Exclusive ownership and task split

**I lands first**, supplying shared primitives and enforcement seams before area branches start.
Five area tasks, each sized for one delegate, split by screen area. Every area task owns **all** microcopy,
motion use, dark/mobile fixes and skeleton adoption in its files. No separate cross-cutting copy or CSS task.
I returns for final integration after all five land; this is the same owner, not a sixth area delegate.

Paths in the exact file lists below are repository-relative. Existing colocated tests belong to the same row.
New files are permitted only in the listed namespace; importing a shared module grants no edit rights.
No task edits another row. Shared fixes go to I once, even when several areas need them.

| Task | Issue title (proposed implementation issue; numbers not allocated here) | Exclusive existing files | New files / tests | Observable acceptance |
|---|---|---|---|---|
| I | Phase 28: shared polish foundations and release verification | Exact I list below; shared UI, shell, navigation, tokens; bundle test; shared e2e; DESIGN and README images | `ui/Skeleton.tsx`; `apps/web/test/phase28-{bundle,microcopy}.test.ts`; `e2e/phase28-{mobile,states,roles}.spec.ts`; `docs/design/phase-28/release-evidence.md` | Motion bounded 120–180 ms and static under reduced motion; reserved loading slots; budgets fail CI; all routes axe and 390 checks; human-approved baselines |
| W | Phase 28: Home, approvals and agents polish | Exact W list below | `features/phase28/work/*`; `e2e/phase28-work.spec.ts` | Home empty blocks name next action; agent Pause and approval footer usable at 390; stale/grouped review and role gates unchanged |
| M | Phase 28: marketing and journey polish | Exact M list below | `features/phase28/marketing/*`; `e2e/phase28-marketing.spec.ts` | Name-only purpose selectors; 390 broadcast actions reachable; journey summary readable without zoom; no animated chart/canvas layout |
| A | Phase 28: audience and consent polish | Exact A list below | `features/phase28/audience/*`; `e2e/phase28-audience.spec.ts` | Consent counts and next action visible at 390; no purpose keys in ordinary labels/toasts; lookup, import and consent permission tests pass |
| C | Phase 28: content and recipient polish | Exact C list below | `features/phase28/content/*`; `e2e/phase28-content.spec.ts`; `packages/artifacts/test/phase28-presentation.test.ts` | Name-only selectors; editor reserves height; dark chrome follows tokens while recipient colours stay exact; empty lists name create/upload action; hosted POST/security behavior unchanged |
| S | Phase 28: insights and settings polish | Exact S list below | `features/phase28/settings-insights/*`; `e2e/phase28-settings-insights.spec.ts` | Token status visible at 390; no unqualified safety claim; errors identify failed scope; reports retain period/denominator/freshness and accessible data tables |

New feature namespaces above are relative to `apps/web/src`. Each task also owns its own
`changelog.d/<assigned-issue>-polish.md`; do not edit CHANGELOG.md. I alone edits e2e matrix, axe/visual
specifications, snapshot directory, shared configuration and final documentation. Area e2e files are separate.
The exhaustive source partition below assigns presentation edit responsibility, **not permission to rewrite
transport, models or execution**. Unneeded files stay untouched. All files not listed are frozen.

## Frozen inputs and interfaces

Freeze Phase 24–27 page templates and IA (groups, destinations, redirects and tabs), chart/data-state contracts,
token **values**, role gates, command names/schemas, consent eligibility, counts, thresholds, journey model/checks/
ops/canvas semantics, exact-version reviews, preview provenance, recipient renderer security/CSP/nonce/path rules,
shared cache/read budgets and demo fixture/read-only execution boundary. I may finish documentation, introduce
motion variables and add loading slots without changing template geometry or token palette. If contrast fails,
first replace a misused colour with its existing semantic token; palette changes require an explicit decision.
No dependencies, lockfiles, migrations, persistence, permissions or product features. No Deferred items:
saved analytics views, segment history/overlap, recipient-zone estimates, new visual diffs, view toggles,
tenant-coloured chrome or demo engine. Preserve developer code views and editable technical keys where required.

## Sequence and review gates

1. Human reviews this contract and mock. I lands shared duration/reduced-motion rules, reserved-state API,
   copy lint and budget harness. Skeleton accepts geometry/label/busy from callers; no data fetching in it.
2. W/M/A/C/S branch from that integrated head. Each fixes audit IDs in its area and runs the same state/copy/
   dark/mobile checklist on every owned screen, including hidden tabs and demo rendering. Findings require evidence;
   report shared needs to I. No speculative redesign or removal of a control to meet budgets.
3. I integrates, captures all 43 scenarios plus missing routes/tabs, runs the full verification matrix,
   finalises DESIGN.md v2 and README/docs screenshots against 0.14.0. Record exact SHA and evidence.
4. Human reviewer approves visual baselines; independent review and CI precede release. No baseline approval by
   implementing model. Follow [delegate process](../../process/delegates.md): local commits, integrator opens
   draft task PRs into feat/phase-28. Use shared test services, distinct TEST_PORT_OFFSET, test:affected,
   smoke plus area functional/axe, lint/typecheck. Full suite in CI. This contract commit is not pushed.

## Human decisions

No scope decision blocks writing or implementing this contract. Before release, the owner must approve the
mock/before-after review and baselines, arrange five unfamiliar participants for the six fixed findability tasks,
and sign off manual accessibility evidence. Budgets are explicit release ceilings, not measurements of route
closures: I must publish manifest-derived actuals before accepting them. A failure calls for splitting existing
lazy loading or removing accidental eager imports; raising a ceiling requires recorded human approval.

## Exact existing file lists

The lists are disjoint. Presentation-only restriction applies throughout. This contract does not execute these tasks.

### I

- `apps/web/src/app/AuthShell.tsx`
- `apps/web/src/app/ForgotPassword.tsx`
- `apps/web/src/app/NewMenu.tsx`
- `apps/web/src/app/ResetPassword.tsx`
- `apps/web/src/app/Root.tsx`
- `apps/web/src/app/SearchPalette.tsx`
- `apps/web/src/app/Shell.tsx`
- `apps/web/src/app/SignIn.tsx`
- `apps/web/src/app/ThemeMenu.tsx`
- `apps/web/src/app/api.ts`
- `apps/web/src/app/artifactRoutes.ts`
- `apps/web/src/app/capabilities.tsx`
- `apps/web/src/app/createIntent.ts`
- `apps/web/src/app/links.tsx`
- `apps/web/src/app/nav.ts`
- `apps/web/src/app/page.tsx`
- `apps/web/src/app/prefs.ts`
- `apps/web/src/app/recents.ts`
- `apps/web/src/app/redirects.ts`
- `apps/web/src/app/router.tsx`
- `apps/web/src/app/routes.tsx`
- `apps/web/src/app/session.tsx`
- `apps/web/src/app/theme.ts`
- `apps/web/src/app/useApi.ts`
- `apps/web/src/app/useTab.ts`
- `apps/web/src/components/Chart.tsx`
- `apps/web/src/components/ChartImpl.tsx`
- `apps/web/src/features/artifactCache.ts`
- `apps/web/src/features/artifacts/ActivityPanel.tsx`
- `apps/web/src/features/artifacts/ArtifactDetailPage.tsx`
- `apps/web/src/features/artifacts/ArtifactListPage.tsx`
- `apps/web/src/features/artifacts/ArtifactSelect.tsx`
- `apps/web/src/features/artifacts/JsonEditor.tsx`
- `apps/web/src/features/artifacts/VersionsPanel.tsx`
- `apps/web/src/features/artifacts/artifactList.ts`
- `apps/web/src/features/artifacts/draftSync.ts`
- `apps/web/src/features/artifacts/jsonDraft.ts`
- `apps/web/src/features/artifacts/pickerIndex.ts`
- `apps/web/src/features/copilot/CopilotDrawer.tsx`
- `apps/web/src/features/phase27/demo/capabilities.test.tsx`
- `apps/web/src/features/phase27/demo/demoBoundary.test.tsx`
- `apps/web/src/features/phase27/demo/demoIsolation.test.tsx`
- `apps/web/src/features/phase27/demo/demoParity.test.tsx`
- `apps/web/src/features/phase27/demo/demoRestrictions.test.tsx`
- `apps/web/src/features/phase27/demo/entry.ts`
- `apps/web/src/features/phase27/demo/fixtures.ts`
- `apps/web/src/features/phase27/demo/mutationSweep.test.ts`
- `apps/web/src/features/phase27/demo/reads.ts`
- `apps/web/src/features/phase27/demo/runtime.ts`
- `apps/web/src/features/phase27/integration/demo/DemoRoot.tsx`
- `apps/web/src/features/phase27/integration/demo/fixtures.ts`
- `apps/web/src/features/phase27/integration/demo/index.ts`
- `apps/web/src/features/phase27/integration/demo/session.ts`
- `apps/web/src/features/phase27/integration/demo/transport.ts`
- `apps/web/src/features/previews/ArtifactPreview.tsx`
- `apps/web/src/features/previews/BlockPreview.tsx`
- `apps/web/src/features/previews/BroadcastPreview.tsx`
- `apps/web/src/features/previews/BundledBlocks.tsx`
- `apps/web/src/features/previews/ChecksPanel.tsx`
- `apps/web/src/features/previews/ConditionView.tsx`
- `apps/web/src/features/previews/EmailPreview.tsx`
- `apps/web/src/features/previews/FormPreview.tsx`
- `apps/web/src/features/previews/PreviewLabel.tsx`
- `apps/web/src/features/previews/SegmentPreview.tsx`
- `apps/web/src/features/previews/previewRead.tsx`
- `apps/web/src/features/previews/previewSource.ts`
- `apps/web/src/features/previews/previewStatus.tsx`
- `apps/web/src/index.css`
- `apps/web/src/lib/agentLabels.ts`
- `apps/web/src/lib/breakdown.ts`
- `apps/web/src/lib/csvImport.ts`
- `apps/web/src/lib/dataState.ts`
- `apps/web/src/lib/labels.ts`
- `apps/web/src/lib/state.ts`
- `apps/web/src/lib/theme.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/mjml-browser.d.ts`
- `apps/web/src/pages/CreatePage.tsx`
- `apps/web/src/pages/artifacts/ArtifactPage.tsx`
- `apps/web/src/ui/Button.tsx`
- `apps/web/src/ui/DateTimeInput.tsx`
- `apps/web/src/ui/DetailPage.tsx`
- `apps/web/src/ui/Identifier.tsx`
- `apps/web/src/ui/ListPage.tsx`
- `apps/web/src/ui/SettingsLayout.tsx`
- `apps/web/src/ui/charts.tsx`
- `apps/web/src/ui/code.tsx`
- `apps/web/src/ui/cx.ts`
- `apps/web/src/ui/diff.tsx`
- `apps/web/src/ui/display.tsx`
- `apps/web/src/ui/focus.ts`
- `apps/web/src/ui/form.tsx`
- `apps/web/src/ui/index.ts`
- `apps/web/src/ui/layout.ts`
- `apps/web/src/ui/menu.tsx`
- `apps/web/src/ui/overlay.tsx`
- `apps/web/src/ui/state.tsx`
- `apps/web/src/ui/table.tsx`
- `apps/web/src/ui/tabs.tsx`
- `apps/web/src/ui/time.ts`
- `apps/web/src/ui/toast.tsx`
- `apps/web/test/bundle.test.ts`
- `docs/design/DESIGN.md`
- `docs/design/DECISIONS.md`
- `docs/design/showcase/tokens.json`
- `README.md`
- `e2e/agents.spec.ts`
- `e2e/alerts.spec.ts`
- `e2e/approvals.spec.ts`
- `e2e/axe-known-issues.json`
- `e2e/axe.spec.ts`
- `e2e/brands.spec.ts`
- `e2e/demo-smoke.spec.ts`
- `e2e/editors.spec.ts`
- `e2e/helpers.ts`
- `e2e/hosted-pages.spec.ts`
- `e2e/journey.spec.ts`
- `e2e/mandates.spec.ts`
- `e2e/matrix.mjs`
- `e2e/navigation.spec.ts`
- `e2e/people.spec.ts`
- `e2e/phase25-approval.spec.ts`
- `e2e/phase25-composer.spec.ts`
- `e2e/phase25-editor.spec.ts`
- `e2e/ports.ts`
- `e2e/providers.spec.ts`
- `e2e/restart-server.sh`
- `e2e/screenshots.mjs`
- `e2e/shot.mjs`
- `e2e/tokens.spec.ts`
- `e2e/visual.spec.ts`
- `e2e/visual.spec.ts-snapshots/agent-1440-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/agent-1440-light-linux.png`
- `e2e/visual.spec.ts-snapshots/agent-390-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/agent-390-light-linux.png`
- `e2e/visual.spec.ts-snapshots/agents-1440-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/agents-1440-light-linux.png`
- `e2e/visual.spec.ts-snapshots/agents-390-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/agents-390-light-linux.png`
- `e2e/visual.spec.ts-snapshots/analytics-1440-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/analytics-1440-light-linux.png`
- `e2e/visual.spec.ts-snapshots/analytics-390-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/analytics-390-light-linux.png`
- `e2e/visual.spec.ts-snapshots/approval-broadcast-1440-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/approval-broadcast-1440-light-linux.png`
- `e2e/visual.spec.ts-snapshots/approval-broadcast-390-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/approval-broadcast-390-light-linux.png`
- `e2e/visual.spec.ts-snapshots/approvals-1440-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/approvals-1440-light-linux.png`
- `e2e/visual.spec.ts-snapshots/approvals-390-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/approvals-390-light-linux.png`
- `e2e/visual.spec.ts-snapshots/broadcast-1440-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/broadcast-1440-light-linux.png`
- `e2e/visual.spec.ts-snapshots/broadcast-390-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/broadcast-390-light-linux.png`
- `e2e/visual.spec.ts-snapshots/journey-builder-1440-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/journey-builder-1440-light-linux.png`
- `e2e/visual.spec.ts-snapshots/journey-builder-390-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/journey-builder-390-light-linux.png`
- `e2e/visual.spec.ts-snapshots/journeys-1440-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/journeys-1440-light-linux.png`
- `e2e/visual.spec.ts-snapshots/journeys-390-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/journeys-390-light-linux.png`
- `e2e/visual.spec.ts-snapshots/people-1440-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/people-1440-light-linux.png`
- `e2e/visual.spec.ts-snapshots/people-390-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/people-390-light-linux.png`
- `e2e/visual.spec.ts-snapshots/signin-1440-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/signin-1440-light-linux.png`
- `e2e/visual.spec.ts-snapshots/signin-390-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/signin-390-light-linux.png`
- `e2e/visual.spec.ts-snapshots/template-1440-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/template-1440-light-linux.png`
- `e2e/visual.spec.ts-snapshots/template-390-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/template-390-light-linux.png`
- `e2e/visual.spec.ts-snapshots/workspace-1440-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/workspace-1440-light-linux.png`
- `e2e/visual.spec.ts-snapshots/workspace-390-dark-linux.png`
- `e2e/visual.spec.ts-snapshots/workspace-390-light-linux.png`

### W

- `apps/web/src/features/agents/AgentControls.tsx`
- `apps/web/src/features/agents/AgentStatus.tsx`
- `apps/web/src/features/agents/AutonomyCard.tsx`
- `apps/web/src/features/agents/AutonomyProvider.tsx`
- `apps/web/src/features/agents/GuardianCard.tsx`
- `apps/web/src/features/agents/HostedAgentCard.tsx`
- `apps/web/src/features/agents/HostedAgentDialog.tsx`
- `apps/web/src/features/agents/MandateCard.tsx`
- `apps/web/src/features/agents/ShadowCard.tsx`
- `apps/web/src/features/agents/createMandate.ts`
- `apps/web/src/features/agents/labels.ts`
- `apps/web/src/features/agents/phase26/ActivityTab.tsx`
- `apps/web/src/features/agents/phase26/ComparisonSection.tsx`
- `apps/web/src/features/agents/phase26/CredentialsTab.tsx`
- `apps/web/src/features/agents/phase26/MandateTab.tsx`
- `apps/web/src/features/agents/phase26/OverviewTab.tsx`
- `apps/web/src/features/agents/phase26/agents.test.tsx`
- `apps/web/src/features/agents/phase26/model.ts`
- `apps/web/src/features/agents/phase26/useFetchedAt.ts`
- `apps/web/src/features/approvals/ApprovalDrawer.tsx`
- `apps/web/src/features/approvals/ConsequenceSummary.tsx`
- `apps/web/src/features/approvals/HoldBadge.tsx`
- `apps/web/src/features/approvals/bundleSummary.ts`
- `apps/web/src/features/approvals/consequences.ts`
- `apps/web/src/features/approvals/decisions.ts`
- `apps/web/src/features/approvals/holds.ts`
- `apps/web/src/features/approvals/requester.tsx`
- `apps/web/src/features/approvals/viewed.ts`
- `apps/web/src/features/artifacts/MandateEditor.tsx`
- `apps/web/src/features/artifacts/PromptEditor.tsx`
- `apps/web/src/features/artifacts/PromptTests.tsx`
- `apps/web/src/features/home/HomeAttention.tsx`
- `apps/web/src/features/home/HomeKpis.tsx`
- `apps/web/src/features/home/HomeRunning.tsx`
- `apps/web/src/features/home/HomeSection.tsx`
- `apps/web/src/features/home/OnboardingChecklist.tsx`
- `apps/web/src/features/home/checklist.ts`
- `apps/web/src/features/home/period.ts`
- `apps/web/src/features/home/useHomeData.ts`
- `apps/web/src/pages/HomePage.tsx`
- `apps/web/src/pages/approvals/ApprovalsPage.tsx`
- `apps/web/src/pages/build/PromptPage.tsx`
- `apps/web/src/pages/build/PromptsPage.tsx`
- `apps/web/src/pages/settings/AgentPage.tsx`
- `apps/web/src/pages/settings/AgentsPage.tsx`

### M

- `apps/web/src/features/artifacts/BroadcastEditor.tsx`
- `apps/web/src/features/artifacts/BroadcastState.tsx`
- `apps/web/src/features/artifacts/BroadcastStatus.tsx`
- `apps/web/src/features/artifacts/CampaignEditor.tsx`
- `apps/web/src/features/artifacts/CampaignEvaluation.tsx`
- `apps/web/src/features/artifacts/CampaignMembership.tsx`
- `apps/web/src/features/artifacts/ExperienceEditor.tsx`
- `apps/web/src/features/artifacts/ExperienceResults.tsx`
- `apps/web/src/features/broadcasts/BroadcastConsequence.tsx`
- `apps/web/src/features/broadcasts/BroadcastContext.tsx`
- `apps/web/src/features/broadcasts/BroadcastReport.tsx`
- `apps/web/src/features/broadcasts/CreateBroadcastDialog.tsx`
- `apps/web/src/features/broadcasts/composer/AudienceEstimate.tsx`
- `apps/web/src/features/broadcasts/composer/Checklist.tsx`
- `apps/web/src/features/broadcasts/composer/ComposerPreview.tsx`
- `apps/web/src/features/broadcasts/composer/model.ts`
- `apps/web/src/features/broadcasts/composer/useComposerData.ts`
- `apps/web/src/features/broadcasts/detailView.ts`
- `apps/web/src/features/broadcasts/listView.ts`
- `apps/web/src/features/broadcasts/names.ts`
- `apps/web/src/features/broadcasts/period.ts`
- `apps/web/src/features/broadcasts/report/CampaignHoldout.tsx`
- `apps/web/src/features/broadcasts/report/ReportEntry.tsx`
- `apps/web/src/features/broadcasts/report/ReportSections.tsx`
- `apps/web/src/features/broadcasts/report/model.ts`
- `apps/web/src/features/broadcasts/report/report.test.tsx`
- `apps/web/src/features/campaigns/CampaignHoldoutCard.tsx`
- `apps/web/src/features/campaigns/phase26/CampaignEvaluationTab.tsx`
- `apps/web/src/features/campaigns/phase26/CampaignEvaluationView.tsx`
- `apps/web/src/features/campaigns/phase26/CampaignHoldoutView.tsx`
- `apps/web/src/features/campaigns/phase26/HoldoutPanel.tsx`
- `apps/web/src/features/campaigns/phase26/campaigns.test.tsx`
- `apps/web/src/features/campaigns/phase26/model.ts`
- `apps/web/src/features/journey/Builder.tsx`
- `apps/web/src/features/journey/Inspector.tsx`
- `apps/web/src/features/journey/JourneyGraph.tsx`
- `apps/web/src/features/journey/Legend.tsx`
- `apps/web/src/features/journey/NodeView.tsx`
- `apps/web/src/features/journey/Palette.tsx`
- `apps/web/src/features/journey/SimulatePanel.tsx`
- `apps/web/src/features/journey/canvas.ts`
- `apps/web/src/features/journey/checks.ts`
- `apps/web/src/features/journey/layout.ts`
- `apps/web/src/features/journey/model.ts`
- `apps/web/src/features/journey/ops.ts`
- `apps/web/src/features/journey/report/JourneyReport.tsx`
- `apps/web/src/features/journey/report/counts.ts`
- `apps/web/src/features/journey/report/model.ts`
- `apps/web/src/features/journey/report/report.test.tsx`
- `apps/web/src/features/phase27/journey/autoLayout.ts`
- `apps/web/src/features/phase27/journey/journey-builder.test.tsx`
- `apps/web/src/features/phase27/journey/journey-inspector.test.tsx`
- `apps/web/src/features/phase27/journey/journey-layout.test.ts`
- `apps/web/src/features/phase27/journey/journey-palette.test.tsx`
- `apps/web/src/features/phase27/journey/names.ts`
- `apps/web/src/features/phase27/journey/reads.ts`
- `apps/web/src/features/phase27/journey/validation.ts`
- `apps/web/src/pages/build/BroadcastPage.tsx`
- `apps/web/src/pages/build/BroadcastsPage.tsx`
- `apps/web/src/pages/build/CampaignPage.tsx`
- `apps/web/src/pages/build/CampaignsPage.tsx`
- `apps/web/src/pages/build/ExperiencePage.tsx`
- `apps/web/src/pages/build/ExperiencesPage.tsx`
- `apps/web/src/pages/build/JourneyPage.tsx`
- `apps/web/src/pages/build/JourneysPage.tsx`
- `apps/web/src/pages/insights/JourneyStatsPage.tsx`

### A

- `apps/web/src/features/artifacts/FormEditor.tsx`
- `apps/web/src/features/artifacts/ListAudiencePanel.tsx`
- `apps/web/src/features/artifacts/PurposesEditor.tsx`
- `apps/web/src/features/artifacts/SegmentEditor.tsx`
- `apps/web/src/features/audience/consent.tsx`
- `apps/web/src/features/audience/phase26/CopyControl.tsx`
- `apps/web/src/features/audience/phase26/ProfileTimeline.tsx`
- `apps/web/src/features/audience/phase26/PurposeConsent.tsx`
- `apps/web/src/features/audience/phase26/model.ts`
- `apps/web/src/features/audience/phase26/people.test.tsx`
- `apps/web/src/features/audience/phase26/peopleData.ts`
- `apps/web/src/features/audience/phase26/usePurposes.ts`
- `apps/web/src/features/audience/profile.ts`
- `apps/web/src/features/content/TopicsTable.tsx`
- `apps/web/src/features/phase27/audience/EditorSection.tsx`
- `apps/web/src/features/phase27/audience/audience.test.tsx`
- `apps/web/src/features/phase27/audience/detail.tsx`
- `apps/web/src/features/phase27/audience/listRows.tsx`
- `apps/web/src/features/phase27/audience/pickerFollowups.test.tsx`
- `apps/web/src/features/phase27/audience/pickerPrefixes.test.ts`
- `apps/web/src/features/phase27/audience/pickerRace.test.tsx`
- `apps/web/src/features/phase27/audience/segmentPreviewCopy.test.tsx`
- `apps/web/src/pages/audience/ConsentPage.tsx`
- `apps/web/src/pages/audience/ImportsPage.tsx`
- `apps/web/src/pages/audience/PeoplePage.tsx`
- `apps/web/src/pages/audience/PersonPage.tsx`
- `apps/web/src/pages/build/FormPage.tsx`
- `apps/web/src/pages/build/FormsPage.tsx`
- `apps/web/src/pages/build/SegmentPage.tsx`
- `apps/web/src/pages/build/SegmentsPage.tsx`
- `apps/web/src/pages/build/TopicsPage.tsx`
- `apps/web/src/pages/settings/PurposesPage.tsx`

### C

- `apps/web/src/features/assets/AssetGrid.tsx`
- `apps/web/src/features/assets/AssetPicker.tsx`
- `apps/web/src/features/assets/upload.ts`
- `apps/web/src/features/blocks/BlockEditor.tsx`
- `apps/web/src/features/blocks/BlockPicker.tsx`
- `apps/web/src/features/blocks/BlockUsage.tsx`
- `apps/web/src/features/blocks/model.ts`
- `apps/web/src/features/brand/BrandEditor.tsx`
- `apps/web/src/features/brand/HostedPreview.tsx`
- `apps/web/src/features/brand/NewBrandDrawer.tsx`
- `apps/web/src/features/brand/defaults.ts`
- `apps/web/src/features/phase27/content/AssetsPage.test.tsx`
- `apps/web/src/features/phase27/content/BlockEditor.test.tsx`
- `apps/web/src/features/phase27/content/BrandEditor.test.tsx`
- `apps/web/src/features/phase27/content/ContentList.test.tsx`
- `apps/web/src/features/phase27/content/ContentList.tsx`
- `apps/web/src/features/phase27/content/ContentSurfaces.test.tsx`
- `apps/web/src/features/phase27/content/Starters.test.tsx`
- `apps/web/src/features/phase27/content/SubscriberPages.test.tsx`
- `apps/web/src/features/phase27/content/TemplateEditor.test.tsx`
- `apps/web/src/features/templates/EditorPreview.tsx`
- `apps/web/src/features/templates/InsertPalette.tsx`
- `apps/web/src/features/templates/TemplateEditor.tsx`
- `apps/web/src/features/templates/VisualMjml.tsx`
- `apps/web/src/features/templates/editor.css`
- `apps/web/src/features/templates/liquid.ts`
- `apps/web/src/features/templates/localRender.ts`
- `apps/web/src/pages/build/RecipesPage.tsx`
- `apps/web/src/pages/design/AssetsPage.tsx`
- `apps/web/src/pages/design/BlockPage.tsx`
- `apps/web/src/pages/design/BlocksPage.tsx`
- `apps/web/src/pages/design/BrandPage.tsx`
- `apps/web/src/pages/design/HostedPagesPage.tsx`
- `apps/web/src/pages/design/TemplatePage.tsx`
- `apps/web/src/pages/design/TemplatesPage.tsx`
- `packages/artifacts/src/hostedPages.ts`
- `packages/audience/src/archive.ts`
- `packages/artifacts/recipes/lead-magnet-drip.json`
- `packages/artifacts/recipes/weekly-newsletter.json`
- `packages/artifacts/recipes/welcome-doi.json`
- `packages/artifacts/recipes/win-back.json`

### S

- `apps/web/src/features/analytics/phase26/AnalyticsPerformance.tsx`
- `apps/web/src/features/analytics/phase26/analytics.test.tsx`
- `apps/web/src/features/analytics/phase26/definitions.ts`
- `apps/web/src/features/analytics/phase26/model.ts`
- `apps/web/src/features/analytics/phase26/period.ts`
- `apps/web/src/features/analytics/phase26/queries.ts`
- `apps/web/src/features/deliverability/CopyRecord.tsx`
- `apps/web/src/features/deliverability/DeliverabilityView.tsx`
- `apps/web/src/features/deliverability/DnsCards.tsx`
- `apps/web/src/features/deliverability/StreamHealth.tsx`
- `apps/web/src/features/deliverability/ThresholdChart.tsx`
- `apps/web/src/features/deliverability/TrendSection.tsx`
- `apps/web/src/features/deliverability/deliverability.test.tsx`
- `apps/web/src/features/deliverability/model.ts`
- `apps/web/src/features/insights/HoldoutCard.tsx`
- `apps/web/src/features/insights/Stats.tsx`
- `apps/web/src/features/integrations/ConnectAgentCard.tsx`
- `apps/web/src/features/integrations/ConnectionsCard.tsx`
- `apps/web/src/features/integrations/JsonSchemaFields.tsx`
- `apps/web/src/features/integrations/SourcesCard.tsx`
- `apps/web/src/features/integrations/WebhooksCard.tsx`
- `apps/web/src/features/phase27/settings/channels.tsx`
- `apps/web/src/features/providers/EmailProviders.tsx`
- `apps/web/src/features/providers/OtherProviders.tsx`
- `apps/web/src/features/providers/SchemaForm.tsx`
- `apps/web/src/features/settings/roles.ts`
- `apps/web/src/features/tokens/CreateTokenDrawer.tsx`
- `apps/web/src/features/tokens/ScopePicker.tsx`
- `apps/web/src/features/tokens/TokenDrawer.tsx`
- `apps/web/src/features/tokens/TokenStatus.tsx`
- `apps/web/src/features/tokens/TokensCard.tsx`
- `apps/web/src/features/tokens/scopes.ts`
- `apps/web/src/pages/PreferencesPage.tsx`
- `apps/web/src/pages/insights/AiUsagePage.tsx`
- `apps/web/src/pages/insights/AlertsPage.tsx`
- `apps/web/src/pages/insights/AnalyticsPage.tsx`
- `apps/web/src/pages/insights/DeliverabilityPage.tsx`
- `apps/web/src/pages/insights/MessagesPage.tsx`
- `apps/web/src/pages/insights/alertTestFeedback.ts`
- `apps/web/src/pages/insights/analyticsParams.ts`
- `apps/web/src/pages/settings/ApprovalPolicyPage.tsx`
- `apps/web/src/pages/settings/IntegrationsPage.tsx`
- `apps/web/src/pages/settings/PreferencesPage.tsx`
- `apps/web/src/pages/settings/ProvidersPage.tsx`
- `apps/web/src/pages/settings/SecretsPage.tsx`
- `apps/web/src/pages/settings/SettingsPage.tsx`
- `apps/web/src/pages/settings/UsersPage.tsx`
- `apps/web/src/pages/settings/WorkspacePage.tsx`

I also exclusively owns future files under `docs/design/phase-28/`, `docs/design/screenshots/` and existing README-linked documentation screenshots; area tasks report documentation changes to I.

## Contract validation

Local Markdown links resolve. Exact ownership lists contain 411 existing files, no duplicate assignment;
unlisted files remain frozen. Outer mock JavaScript passes `node --check`; generated 1440/390 light/dark
frames each contain all four states, busy semantics and no external resource tags. `git diff --check` passes.
These are static checks, not application tests. No product code or evidence directory was modified.

T3 `html_preview` could not execute because the host lacks browser libraries (including libglib-2.0.so.0,
libnss3.so and libX11.so.6). The mock was presented with `html_render`; browser layout/interaction verification
remains outstanding. No browser dependencies were installed. Release checklists remain unchecked on purpose.

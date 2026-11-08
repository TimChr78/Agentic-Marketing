# Phase 28 · evidence backlog

Evidence is the supplied main v0.13.0 seeded matrix, not fresh captures. Screenshot basenames below are under
`/mnt/user/appdata/t3code/tools/p28-audit/shots/`. All 43 scenarios were inspected in light/dark at 1440/390
and the 768 matrix in contact sheets; named findings were checked at native resolution. Magenta rectangles
are volatile masks, **not colour defects**. They hide text we cannot audit. Source paths below are relative
to `apps/web/src`; line numbers refer to the contract checkout. P1 blocks a core task; P2 violates a wave
contract or materially impedes comprehension; P3 is a minor consistency fix. No P1 confirmed by this evidence.

## I · shared states and motion

| ID | Priority | Evidence and source | Observable defect / bounded remedy |
|---|---|---|---|
| I1 | P2 | `agent-1440-dark.png` and `analytics-390-light.png` establish metric destinations; `ui/display.tsx:174`, `ui/table.tsx:44` | Source-confirmed: LoadingBlock reserves only line count; five generic table placeholder rows do not reserve the final card/KPI geometry. Risk of shift, not measured CLS. Add geometry variants; area owners supply exact slots. |
| I2 | P2 | `token-390-dark.png` is the mutation destination; `ui/Button.tsx:68`, `index.css:355` | Source-confirmed spinner is animated SVG with generic reduced-duration override, not the specified static progress icon plus status text. Replace under reduced motion; preserve button width and name. Still screenshot does not show a spinning defect. |
| I3 | P2 | `journey-builder-1440-light.png` is the simulation destination; `index.css:374,385` | Source defines 1.2 s flash and infinite 1 s pulse, beyond 180 ms feedback contract. Verify reachability before deleting legacy selectors; stop use in real/demo shell, use one short feedback cue. No claim these ran during capture. |

## W · Home, approvals and agents

| ID | Priority | Evidence and source | Observable defect / bounded remedy |
|---|---|---|---|
| W1 | P3 | `home-390-light.png`, `features/home/HomeRunning.tsx:48,183` | “No scheduled or sending broadcasts” / “No active agents” name absence without a next action. Add existing-destination link or read-only explanation according to role; do not imply the limited sample is exhaustive. |

Approval footer buttons and agent Pause are visible in the supplied 390 captures. No obscured-action P1
is asserted. Keyboard/focus return, stale/grouped review and unseen empty/error tabs need live verification.

## M · marketing and journeys

| ID | Priority | Evidence and source | Observable defect / bounded remedy |
|---|---|---|---|
| M1 | P2 | `journey-builder-768-light.png`, `features/journey/Builder.tsx:859`; `journey-builder-390-light.png`, `features/journey/NodeView.tsx:69` | Journey purpose selector appends technical key (same pattern as A1/C1). Use name-only selection, unknown reference via existing copy affordance. At 390 fit-to-canvas labels are extremely small; retain desktop-first authoring but expose the existing text/summary view prominently with readable labels. No request for a new mobile builder. |

## A · audience and consent

| ID | Priority | Evidence and source | Observable defect / bounded remedy |
|---|---|---|---|
| A1 | P2 | `consent-390-dark.png`, `pages/audience/ConsentPage.tsx:155`; `segment-390-light.png`, `features/artifacts/SegmentEditor.tsx:561` | “necessary”, “web_personalization” and “Marketing e-mail (marketing_email)” appear as ordinary labels. Use purpose names; technical key available only in existing identifier/developer affordance. Apply to consent success toast too (`ConsentPage.tsx:344`). |
| A2 | P2 | `consent-390-light.png`, `consent-390-dark.png`, `pages/audience/ConsentPage.tsx:132–175` | People counts and double-opt-in are outside the initial horizontal table viewport, with no visible cue. This is local table scrolling, not proof of page overflow. Stack the existing row fields at mobile or give an explicit accessible scroll cue; counts must be readable without page panning. |

## C · content and recipient surfaces

| ID | Priority | Evidence and source | Observable defect / bounded remedy |
|---|---|---|---|
| C1 | P2 | `template-1440-light.png`, `template-390-dark.png`, `features/templates/TemplateEditor.tsx:142` | Purpose option includes raw key and truncates the meaningful label on desktop. Show name alone; preserve selected value and consent semantics. |
| C2 | P3 | `template-1440-light.png`, `features/templates/VisualMjml.tsx` (GrapesJS inspector setup), `features/templates/editor.css:71` | Inspector says “Select an element before using Style Manager”; internal tool name and title casing differ from app copy. Use “Select an element to edit its styles.” Verify third-party override stays scoped. |

White message canvas/brand preview in dark mode is intended recipient content, not a dark-mode defect.
Dark editor chrome in `template-1440-dark.png` uses tonal surfaces. No measured contrast failure is claimed;
source token and selected/disabled/focus-state checks remain release work. Public recipient routes are not
represented by these admin screenshots; test them separately rather than inventing defects.

## S · insights and settings

| ID | Priority | Evidence and source | Observable defect / bounded remedy |
|---|---|---|---|
| S1 | P2 | `integrations-390-light.png`, `features/tokens/TokensCard.tsx:61–74` | Token Status is clipped off to the right in initial view. Put status with the name on mobile while retaining owner/brand/last use in the existing row detail. No new detail capability. |
| S2 | P2 | `integrations-390-light.png`, `features/tokens/TokensCard.tsx:39` | “it's safe to set STRICT_INPUTS=true” is unqualified reassurance based only on a seven-day observation. Say “No unknown input keys recorded in the last 7 days. Review your clients before enabling strict input validation.” Keep config identifier in technical setup details. No behavior change. |
| S3 | P3 | `providers-390-dark.png`, `pages/settings/ProvidersPage.tsx` (channel state summary), `features/phase27/settings/channels.tsx` | Global “Couldn't load providers” sits above a successfully loaded e-mail provider and “1 of 4 channels configured”. Specify “Some provider channels couldn't load”; identify failed channels from existing per-channel errors. Don't label successful data failed. |

## Coverage limits and closure

Microcopy, mobile and colour layering were inspected; masks hide timestamps and many ids. No reliable
contrast ratio, motion timing, spinner timing, CLS, off-screen action reachability or error behavior can
be inferred from a still capture. Loading/motion findings above are explicitly source-confirmed risks.
Do not manufacture an empty/error screenshot citation. [Verification](verification.md) supplies those tests.
Every backlog ID needs a before/after image or state recording, exact commit, test result and reviewer.
P2s close before release; P3s are small wording fixes in the same pass. New P1s block release and receive
an evidenced entry here. This is a bounded polish backlog, not clearance of every state.

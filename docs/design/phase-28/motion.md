# Binding motion contract

I owns definitions; each area owns use. No animation dependency. This phase tightens DESIGN v2's loading
exception: **static skeletons and static progress icons**, not repeating shimmer/spin. I records this refinement
in final DESIGN.md. All remaining transitions are 120–180 ms, orientation or feedback only.

| Token | Value | Permitted use |
|---|---|---|
| `--duration-fast` | 120ms | Hover/press/focus colour, switch thumb, disclosure chevron |
| `--duration-enter` | 180ms | Drawer/menu/toast enter and exit; feedback appears once |
| `--ease` | `cubic-bezier(.2,.8,.2,1)` | Orientation; opacity and translate only |
| `--ease-feedback` | `cubic-bezier(0,0,.2,1)` | Feedback colour or opacity |

Menu/toast travel ≤8px Y; drawer ≤16px X. Shell rail collapse may retain existing 180ms width/padding
orientation only on explicit user toggle; no animation on initial route mount or viewport resize.
Use explicit transitioned properties, never `transition: all`. No delay, spring, bounce or overshoot.
No transition longer than 180ms, including third-party editor and canvas defaults. Use the tokens rather
than Tailwind's implicit duration. Feedback success stays visible long enough to read according to existing
toast lifetime; lifetime is not an animation duration. Do not dismiss errors on a timer.

Allowed: entering/exiting an invoked overlay, expanding a disclosure indicator, changing an intentional control
state and one confirmation cue. Never animate chart series, counters/KPIs, skeletons, progress icons, automatic
canvas layout/fit, report refresh, list reordering, page content, recipient message text, tab body height or focus
rings. No ambient pulses/demo flash loops, parallax, looping gradient, smooth auto-scroll or whole-page fade.
Move focus immediately; do not wait for animation to enable or remove controls. Do not animate layout as data loads.

Under `prefers-reduced-motion: reduce`, set durations and delays to `0ms`, animation to `none`, transforms
for enter effects to `none` and scroll behavior to `auto`. Static loading icon + visible object-specific status
text remains. Do not rely only on a 0.01ms global override: third-party JS animation/React Flow must also receive
its reduced-motion/off setting. Chart animation already disabled in `components/ChartImpl.tsx`; retain that.

Verification: I checks computed styles after hover, disclosure, overlay open/close and reduced-motion emulation.
Area e2e exercises those uses, including demo. Assert no infinite animation and no nonzero duration under
reduced motion; inspect CSS and JS animation options too. Screenshot evidence cannot demonstrate duration.
Manual check: no repeated announcements, flashing, lost focus, animation-gated actions or moving target.

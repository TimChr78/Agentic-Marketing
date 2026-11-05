# Design v2 showcase

Open [index.html](index.html) directly in a browser. It is the **reference for implementation** of
[DESIGN.md v2](../DESIGN.md), issue #436: tokens, type, controls, operational states, KPI/data states,
charts, and MartechSignal list/detail mock-ups at native 1440px and 390px widths. Scroll each desktop
frame horizontally on narrow displays. The light/dark switch changes all admin chrome; recipient
content stays light. Data is illustrative; product actions are static specimens. No external requests,
fonts, build step or server are needed.

Run `python3 docs/design/showcase/verify_palette.py` from the repository root to regenerate
[contrast-report.md](contrast-report.md). The dependency-free audit reads [tokens.json](tokens.json),
checks HTML token parity, text/control/chart contrast and ramp luminance order, and reports simulated
protanopia, deuteranopia and tritanopia collisions. Unique marks/dashes, direct labels and a table are
required; colours alone are not guaranteed distinguishable. The normative contracts are in DESIGN.md.

Application tokens/components are intentionally unchanged. This reference does not claim completion
of issue #436's later implementation or regression checks.

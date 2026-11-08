---
section: Changed
issues: [555]
---
- Loading screens now reserve the space their content will use, so lists, details, charts and the sign-in screen no longer jump when data arrives; skeletons stay static and appear only after 150 ms.
- Transitions use the shared 120 ms and 180 ms duration tokens, reduced motion removes them entirely, and the button progress glyph no longer spins or pulses.
- Sign-in, password reset and shared empty/error copy now state what failed and what to try next instead of showing raw server text.

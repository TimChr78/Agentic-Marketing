---
section: Security
issues: [1132]
---
- Personalization HTML is now cleaned with an allowlist of inert tags and attributes instead of a list of known-bad ones. SVG SMIL (`<set>`/`<animate>`), `<style>`, `<math>`, `<foreignObject>` and every other unlisted element are removed; every `srcset` candidate is checked on its own; and an inline `style` may not use an external `url()`, `@import` or a backslash escape. Content the previous sanitizer removed stays removed.

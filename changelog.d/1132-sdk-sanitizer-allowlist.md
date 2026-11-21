---
section: Security
issues: [1132]
---
- Personalization HTML is now cleaned with an allowlist of inert tags and attributes instead of a list of known-bad ones. SVG SMIL (`<set>`/`<animate>`), `<style>`, `<math>`, `<foreignObject>` and every other unlisted element are removed; every `srcset` candidate is checked on its own; and an inline `style` may not use an external `url()`, `@import` or a backslash escape. Content the previous sanitizer removed stays removed.
- **Check your experiences before upgrading the SDK:** elements outside the allowlist are now removed together with everything inside them. Experience HTML that used `<video>`, `<audio>`, `<picture>` and `<source>` (including the fallback `<img>` inside a `<picture>`), form controls such as `<button>`, `<input>`, `<select>` and `<label>`, or custom elements no longer renders those parts, and `mailto:`/`tel:` links lose their link. Rewrite them with plain `<img>`, `<a href="https://…">` and text before you publish the new SDK.

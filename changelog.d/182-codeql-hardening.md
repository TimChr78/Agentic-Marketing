---
section: Security
issues: [182]
---
- The public newsletter archive and web version now use one linear, quote-aware scanner that removes scripts, embedded frames, `meta refresh`, event handlers and obfuscated `javascript:` links from e-mail HTML without crashing on hostile entities, while benign markup keeps its exact bytes. Slug, tag-stripping, SVG attribute and duration parsing stay fast on hostile input, and long ISO durations are no longer rejected.

---
section: Added
issues: [872]
---
- `templates.check` and the e-mail template editor now warn, without blocking save or publish, when the unsubscribe link's visibility depends on CSS the static check cannot evaluate — an at-rule such as `@media`, a combinator, attribute selector or pseudo-class, `hsl()` or another colour format, a gradient or image background, a transform, a relative offset, `clip`/`clip-path`, a rule past the check's cap, or an inline style on the link or an ancestor. The warning names the construct and points to a client preview; CSS that cannot reach the link stays silent.

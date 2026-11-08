---
section: Fixed
---

- Demo destinations are normalized with the browser's URL rules, including percent-encoded dot segments and backslashes, so a crafted link cannot be resolved outside `/demo`.
- External and protocol-relative URLs pass through unchanged, and the demo history patch leaves cross-origin destinations to the native SecurityError instead of substituting the current query or hash.
- Demo switches, menu actions and icon buttons now use the same `mutation` capability as buttons, with the seeded Hermes webhook switch and Delete action disabled with the demo reason.
- The demo runtime restores the previous workspace time zone when it unmounts.

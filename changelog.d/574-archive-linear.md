---
section: Security
issues: [574, 577, 578, 579]
---
- The public newsletter archive and web version now extract styles, body content and tracking pixels in linear time, memoise the rendered parts in a bounded 256-entry / 32 MB cache so a repeat request does not re-parse the issue, refuse pathologically nested e-mail HTML (parse5 itself aborts the tree past the depth cap, template content included, with a conservative pre-scan failing closed early), fail closed on tags with more than 512 attributes or any parser error, and strip SVG animation elements that could turn links into `javascript:` URLs, so one crafted issue can no longer stall or weaken the public site.

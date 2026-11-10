---
section: Security
issues: [574, 577, 578, 579]
---
- The public newsletter archive and web version now extract styles, body content and tracking pixels in linear time, refuse pathologically nested e-mail HTML (parse5 itself aborts the tree past the depth cap, with a conservative pre-scan failing closed early), and strip SVG animation elements that could turn links into `javascript:` URLs, so one crafted issue can no longer stall or weaken the public site.

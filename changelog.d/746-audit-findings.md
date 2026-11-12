---
section: Fixed
issues: [746, 747, 748]
---
- The visible unsubscribe-link check now applies simple `<style>` rules that set `opacity`, `font-size` or `color`, using the same tag/class/id cascade and limits as `display`, `visibility` and `background`, so a stylesheet rule can no longer hide the link from the save and publish gates.
- A campaign summary request whose `to` falls before a campaign that has sent later returns its readiness instead of rejecting the default window as reversed; an explicit `from` after `to` is still refused.
- Archive and web-version extraction finds `<style>` and `<body>` tags in the original document with an ASCII-only case fold, so a character such as `İ` no longer shifts the body and stylesheet slices.

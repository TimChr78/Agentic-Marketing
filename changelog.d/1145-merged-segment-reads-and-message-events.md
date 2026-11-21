---
section: Fixed
issues: [1145]
---
- `segments.ofProfile` and the e-mail lifecycle customer events (`Email Sent`, `Email Delivered`, `Email Link Clicked`, `Email Unsubscribed`, `Email Bounced`, `Email Complained`) now follow a profile merge, so an old profile id still reports the person's segments and no message event is dropped when a merge lands before the outbox dispatcher runs.

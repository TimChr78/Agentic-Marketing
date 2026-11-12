---
section: Fixed
issues: [597, 598]
---
- An allowed site on a signup form is now compared case-insensitively, so typing `https://MySite.com` no longer publishes a form that refuses every real submission; the origin is saved with the scheme and host lowercased, and the editor shows the stored value when the field loses focus.
- Switching a form's hosted-page override off no longer deletes its colours and wording when the draft is saved; the values stay in the form and come back when the override is switched on, while the hosted pages use the workspace brand until then.

---
section: Fixed
---

- The demo URL namespace is now enforced: destinations are normalized (`.`/`..`/duplicate slashes) and confined to `/demo`, the history patch rewrites an outside destination instead of stamping it as demo, and only a `/demo` URL enables demo mode.
- The demo runtime installs and uninstalls replay-safely, so a StrictMode effect replay keeps the fixture transport and router base installed.
- The demo mutation sweep now marks create, save, publish, delete, archive, rename, approve, reject, send, invite, import, connect and revoke controls, with a guard test that fails when a new submit or mutating button is unmarked.

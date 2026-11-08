---
section: Fixed
---

- An abandoned segment estimate no longer leaves a permanently loading result: editing the rules settles the pending request, returning to those rules leaves “Estimate again” usable, and a discarded response never fills the count. A `usePickerIndex(..., { skip: true })` hook no longer subscribes, so a create on a legacy list page does not start an index read nobody asked for. Invalidating an artifact now also drops a pending index of that artifact’s type, so a response from before a rename or discard cannot fill the cache.

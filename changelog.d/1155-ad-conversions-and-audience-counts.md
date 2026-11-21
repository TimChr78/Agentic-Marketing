---
section: Fixed
issues: [1155]
---
- Two ad conversion rules on the same event and ad connection each queue their own delivery instead of the second being silently dropped, conversions follow a merged profile before consent is checked, and an audience sync's unresolved count no longer counts an orphaned write intent twice.

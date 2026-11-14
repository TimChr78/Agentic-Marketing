---
section: Changed
issues: [904]
---
- The inbound webhook documentation and the code comment now state the second replay limit plainly: a mapping that reads or copies the whole headers object (`headers`, `*`, `**`, `$spread`, `$string(headers)`, embedding `headers` in its output) puts every per-attempt header a proxy or sender changes (`date`, `cf-ray`, `x-forwarded-for`, `x-request-id`, signatures) into the replay identity, so it does not deduplicate retries behind a proxy and can publish once per retry. It never loses an event. Read the specific headers you need by name, or use Standard Webhooks.

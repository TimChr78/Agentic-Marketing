---
section: Security
issues: [947]
---
- A `TRUSTED_ORIGINS` wildcard entry can no longer make `/api/auth/*` hang. Better Auth compiles every entry it is given into a backtracking regular expression and runs it against the `Origin` (or `Referer`) header of every cookie-bearing write, with no length limit, so a four-wildcard entry such as `https://*.*.*:*` and a few kilobytes of dots kept the event loop busy for minutes per request. It now receives only exact origins, and a wildcard is resolved per request by the bounded matcher the CSRF check uses. An `Origin` or `Referer` longer than 2048 characters is refused with `403` before the auth handler runs.

---
section: Fixed
issues: [929]
---
- The SSO-registration `curl` example in `docs/identity.md` now sends `Origin: https://marketing.example.com` and says why: a cookie-authenticated write on the command line is refused with `403 MISSING_OR_NULL_ORIGIN` unless its `Origin` matches `PUBLIC_URL` or `TRUSTED_ORIGINS`. Bearer-token examples need no `Origin`.

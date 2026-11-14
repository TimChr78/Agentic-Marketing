---
section: Security
issues: [902]
---
- The CSRF origin matcher now follows Better Auth's own rules for `TRUSTED_ORIGINS`, so a request Better Auth refuses at `/api/auth/*` cannot be accepted by a cookie-authenticated write. An IP wildcard such as `https://192.168.*.*` matches only a literal IPv4 address, never a host name like `192.168.evil.com`; a wildcard cannot run past the host (it stops at `:`, `@`, `/` and `\`); and `https://*.example.com` still covers `a.example.com` and `a.b.example.com`, as it does for Better Auth.
- Entries are normalised the way this check always normalised them — case, a trailing slash and an explicit default port name the same origin — and matching is bounded: the browser's `Origin` length is capped, and a `TRUSTED_ORIGINS` entry that is longer than 512 characters or has more than four wildcards is refused at start-up with an error that names it. This is a breaking change only for an entry that relied on a wildcard crossing a port: name the port in the pattern (for example `https://192.168.*.*:*`).

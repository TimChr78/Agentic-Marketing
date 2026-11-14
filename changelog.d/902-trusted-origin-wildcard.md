---
section: Security
issues: [902]
---
- A `TRUSTED_ORIGINS` wildcard now matches exactly like Better Auth's own origin check, so a pattern that names an address range (`https://192.168.*.*`) admits only a literal IPv4 address and no longer matches a hostname such as `192.168.evil.com`. A domain wildcard keeps matching subdomains (`https://*.example.com` also covers `a.b.example.com`, as it does for Better Auth) and still never matches another scheme, a different port or a look-alike suffix. This is a breaking change for a wildcard that was written to cross a dot boundary: such an entry stops matching with this release.

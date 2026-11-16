---
section: Fixed
issues: [943]
---
- A `TRUSTED_ORIGINS` wildcard entry that names the default port now matches the browsers it is meant to authorize. A browser never writes `:443` for an `https` origin (or `:80` for an `http` one), so `https://*.example.com:443` matched nothing and every cookie-authenticated write was refused with `403`. The default port is now dropped from a wildcard entry the same way it always was from an exact one; any other port, and the wildcard port `:*`, still has to match.

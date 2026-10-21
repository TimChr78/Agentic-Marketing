# ADR-0009: Project license

- Status: Accepted (owner decision 2026-10-21)
- Date: 2026-10-21

## Context
The core must be free and open source and self-hostable; a hosted multi-tenant offering may follow. Dependencies are kept permissive regardless of the project's own license.

## Options
| Option | Pros | Cons |
|---|---|---|
| **AGPL-3.0 core + MIT SDKs/adapters SDK + CLA** | Others can't offer a closed hosted fork; SDKs embeddable anywhere; CLA lets you dual-license or add commercial cloud features later | Some companies avoid AGPL; CLA adds contributor friction |
| Apache-2.0 / MIT core + separately licensed `ee/` directory (PostHog / Dittofeed style) | Maximum adoption & contributions | Anyone can host it as a competing service |
| Fair-code (e.g. Sustainable Use, BSL) | Strong commercial protection | Not OSI open source — conflicts with the stated goal |

## Decision
AGPL-3.0 for the server, MIT for `sdk-js`, connector/adapter SDKs and schemas, with a lightweight CLA so dual-licensing for a future hosted offering stays possible.

---
section: Security
issues: [931]
---
- The MCP-disabled startup warning logs `PUBLIC_URL` as its origin and path only, so basic-auth userinfo and a token in its query string no longer reach the logs. The same guard is checked for every server and package log line that passes a configured URL.

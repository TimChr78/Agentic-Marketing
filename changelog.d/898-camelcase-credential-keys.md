---
section: Security
issues: [898]
---
- Credential redaction now recognises a key by its last word, split on camelCase/PascalCase boundaries and on `_`, `-` and `.`: `authToken`, `apiSecret`, `secretKey`, `signingKey`, `oauthToken`, `sessionKey`, `X-Auth-Token`, `"accessToken"` and a `?apiSecret=` query parameter are redacted like `access_token` already was, while `monkey`, `keyboard`, `author`, `authority`, `tokenizer` and `sessions_count` are left alone. A credential pair nested in another value (`access token: access_token=…`) is still redacted field by field, and a message with nothing to redact is unchanged.

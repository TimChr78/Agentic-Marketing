---
section: Security
issues: [898]
---
- Credential redaction now recognises a key by its last word, split on camelCase/PascalCase boundaries and on `_`, `-` and `.`: `authToken`, `apiSecret`, `secretKey`, `signingKey`, `oauthToken`, `sessionKey`, `X-Auth-Token`, `"accessToken"` and a `?apiSecret=` query parameter are redacted like `access_token` already was, while `monkey`, `keyboard`, `author`, `authority`, `tokenizer` and `sessions_count` are left alone. A credential pair nested in another value (`access token: access_token=…`) is still redacted field by field, and a message with nothing to redact is unchanged.
- The value of a credential key is now taken as a whole whatever shape it has: a JSON array or object is replaced in one step (`{"apiSecret":["shortpw","morepw"]}` becomes `{"apiSecret":[redacted]}`), a `Bearer`/`Basic` value of any length under a credential key keeps its scheme word, and a multi-line PEM block is replaced in one go. An unbalanced structure is cut at the end of its line rather than left readable. Redaction is idempotent, so a message that is redacted twice reads exactly as it did after the first pass.

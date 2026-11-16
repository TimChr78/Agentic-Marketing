---
section: Security
issues: [946]
---
- A run of leading separators no longer hides a camelCase or PascalCase credential key: `_secretKey`, `_userPassword`, `_authToken`, `_oauthToken`, `_sessionKey`, `_SIGNINGKEY`, `__secretKey`, `$$authToken` and their dotted or hyphenated forms have their value replaced, as `secretKey` already did. Ordinary fields after a separator (`_id=123`, `_type=user`, `__proto__`, `_keyboard=on`, `_entryKey`) keep their text, and a second pass still changes nothing.

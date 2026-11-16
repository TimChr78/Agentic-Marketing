---
section: Security
issues: [937]
---
- Credential redaction now replaces the value in shapes the rules left behind: a JSON array or object under a credential key (`{"token":["shortpw"]}`, `{"secret":{"v":"x"}}`), a short Authorization value (`authToken=Bearer abc`, `password: Basic xyz`), a typographic-quoted value (`token: “short pw”`, `‘…’`, `«…»`), a value after `=>` (`'password' => 'x'`), a whole PEM private-key block, escaped JSON inside a string (`{\"password\":\"x\"}`), URL-encoded pairs (`password%3Dsecret`, `token%22%3A%22abc`, `api%5Fkey=`), a `Pwd`/`Pass` camel ending (`userPwd`, `dbPwd`, `dbPass`) and a credential pair nested in another pair (`SIGNINGKEY=AZUREOPENAIKEY='x'`). Text glued to an existing marker (`token=[redacted]shortpw`) goes too. Ordinary JSON, counters such as `"tokens": 1234`, prose with quotes or `=>`, and public `BEGIN CERTIFICATE` blocks keep their text, and a second pass still changes nothing.

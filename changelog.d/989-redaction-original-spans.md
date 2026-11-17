---
section: Security
issues: [989]
---
- Credential redaction now decides four value shapes from the original text, so a value the rules could only see in part is replaced whole: a PEM private-key block (standalone or under a credential key, header at the start of a line, footer label matching the header), a typographic-quoted value (`token: “short pw”`), a value after an arrow (`'password' => 'x'`, `apiSecret => secret`), and a field appended to a marker the caller sent (`token=[redacted]"status":"ok"`, whose field text now stays). The released rules and passes still run first, on the whole message, and only the planted value is taken away: an unterminated PEM block is redacted as far as its base64 body reaches, a quoted value ends at its own closing quote, prose with an apostrophe or a mid-line mention keeps its text, and a second pass changes nothing.

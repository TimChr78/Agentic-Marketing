---
section: Security
issues: [920]
---
- Redaction now also replaces the password in URL userinfo, for any scheme: `postgres://am:secret@db` becomes `postgres://am:[redacted]@db`, and so do `http`, `redis`, `nats`, `amqp` and `mongodb+srv` connection strings, with a short password or one containing percent-escapes. A URL without a password (`https://user@host`, `mailto:a@b.c`, `https://host/path?x=a:b@c`) is unchanged, so a host is never turned into a redaction.
- A password that itself contains `@` is redacted whole: the last `@` of the authority delimits the userinfo, so `http://u:pa@ss@host` becomes `http://u:[redacted]@host`, and IPv6 hosts (`[::1]:5432`), an empty user (`redis://:pw@host`) and several connection strings in one message are handled the same way.

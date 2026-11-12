---
section: Fixed
issues: [769, 782, 789]
---
- `templates.check` with `checkLinks: true` no longer fails with `invalid_input` on a template whose footer is a reusable block: the link-personalisation probe renders with the same block resolver as the main render, and a probe that still cannot render treats every link as personalised instead of failing the check (#782).
- E-mail link rewriting decodes an href's character references once before it becomes a URL, so `&#38;`, `&#x26;` and `&amp;` all keep the query parameters after them instead of turning into a `#38;` fragment; tagging and click tracking write the value back with `&amp;` and sign the same decoded URL the unsubscribe check sees (#789).
- A form's allowed origin drops the scheme's default port (`:443` for https, `:80` for http) on save and on comparison, so `https://MySite.com:443` accepts the `https://mysite.com` Origin a browser sends; a non-default port such as `:8443` is kept (#769). IDN hosts are not involved: the origin schema already rejects non-ASCII hosts.

---
section: Security
issues: [914]
---
- The outbound egress guard now decodes Teredo addresses (`2001:0000::/32`): the client IPv4 in the last 32 bits is complemented, so it was invisible to the block list, and the Teredo server address in the middle of the address is checked too. Either one naming a private target now refuses the connection, while an allow-listed private range still covers the Teredo form the way it covers 6to4. Other `2001:` addresses are unaffected.

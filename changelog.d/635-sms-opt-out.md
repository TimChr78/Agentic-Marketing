---
section: Security
issues: [635, 636]
---
- Marketing SMS always ends with " Reply STOP to opt out." unless the body already ends with a real opt-out instruction — an instruction verb, a stop keyword and an opt-out purpose, optionally followed by carrier boilerplate such as "Msg & data rates may apply." — so a text that merely mentions "stop" ("Don't stop reading", "Stop & Shop", "Stop by before the deals end!") can no longer ship without one, and a real instruction no longer gets a duplicate.
- Inbound SMS replies are normalised before keyword matching: trailing punctuation, mixed case, fullwidth characters, surrounding emoji and a short phrase such as "Please STOP" now withdraw marketing consent and suppress the number, where only an exact first word did before. STOP, STOPALL and UNSUBSCRIBE opt out anywhere in a reply, however long ("Please stop sending me these messages right now"), while weaker words such as CANCEL keep the whole-message, first-word or short-message rule; START and HELP match as before.

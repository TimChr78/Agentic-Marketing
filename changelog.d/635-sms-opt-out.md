---
section: Security
issues: [635, 636]
---
- Marketing SMS always ends with " Reply STOP to opt out." unless the body already ends with a real opt-out instruction — an instruction verb, a stop keyword and an opt-out purpose, optionally followed by carrier boilerplate such as "Msg & data rates may apply." — so a text that merely mentions "stop" ("Don't stop reading", "Stop & Shop", "Stop by before the deals end!") can no longer ship without one, and a real instruction no longer gets a duplicate.
- Inbound SMS replies are normalised before keyword matching and split on every run of non-letters/non-digits, so trailing punctuation, mixed case, fullwidth characters, surrounding emoji, "STOP,please", "Please STOP/UNSUBSCRIBE" and "Please stop—sending these messages" all contain the keyword. Any opt-out keyword anywhere in the reply now withdraws marketing consent and suppresses the number, however long the sentence ("I want to cancel my order", "Kan ni avsluta dessa utskick till mig tack"); a false opt-out is the accepted, recoverable failure. START and HELP still require the whole message, and STOP wins when both appear.

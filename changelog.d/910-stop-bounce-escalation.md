---
section: Fixed
issues: [910]
---
- When a hard bounce or complaint escalates an SMS STOP suppression, the row now carries the delivery's time instead of the STOP's, and the transition is logged like STOP and START (without the phone number). A second bounce changes neither the reason nor the time, and START still cannot lift it.

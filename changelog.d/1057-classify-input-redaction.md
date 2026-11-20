---
section: Fixed
issues: [1057]
---
- `ai.classify` keeps only a redacted copy of the text it classified: `ai.calls` and `ai.reviews`
  no longer show the sender's e-mail address or phone number, though the model still sees the text
  it was asked to classify.

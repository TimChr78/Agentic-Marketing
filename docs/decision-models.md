# Decision models

A decision model answers typed questions about a state with probabilities, confidence and a score — never text. Agentic Marketing supports TypeSafe's **JEV** through the **System One** API as a third AI provider kind (`decision`). Use it for cheap, frequent, typed judgments (a journey branch, an engagement score, a ranking) and keep the LLM (`aiDecide`, `ai.generate`) and rules for the work that needs language or an explanation.

- [When to use which](#when-to-use-which)
- [Configure a provider](#configure-a-provider)
- [The request and the two endpoints](#the-request-and-the-two-endpoints)
- [ai.score](#aiscore)
- [Scores, segments and journeys](#scores-segments-and-journeys)
- [Privacy: no personal data by default](#privacy-no-personal-data-by-default)
- [Budgets and the call log](#budgets-and-the-call-log)
- [Calibration](#calibration)
- [The decision gate](#the-decision-gate)
- [What is not built](#what-is-not-built)

## When to use which

| Need | Use | Why |
| - | - | - |
| Consent, suppression, frequency caps, eligibility | **Rules** | Deterministic and auditable; never a probability. |
| A choice that needs a rationale a person can review | **`aiDecide`** (LLM) | The LLM returns the option and a short rationale. |
| A label from free text, e.g. a reply's intent | **`ai.classify`** (LLM) | The model reads text; JEV has no zero-data-retention path for it. |
| A yes/no, choice or 0–1 score per person, often | **Decision model** | Typed probabilities, low latency and cost, no text to parse. |
| Ordering a capped audience | **Decision model + rules** | Rules keep the eligible set; the model only orders it. |
| A winner or uplift | **Control groups (#67)** | A prediction is not an experiment. |

A decision model does not replace consent, lawful basis, suppression or eligibility. Those stay deterministic.

## Configure a provider

```json
POST /v1/aiProviders.create
{
  "name": "TypeSafe JEV",
  "kind": "decision",
  "baseUrl": "https://api.commandcode.ai/provider/v1",
  "models": { "default": "typesafe/jev" },
  "useFor": ["decisions"],
  "monthlyTokenBudget": 2000000,
  "allowPersonalData": false,
  "apiKey": "<your key>"
}
```

`kind` is one of `openai-compatible`, `anthropic-compatible` and `decision`. The API key is sealed with the workspace key and never returned. `aiProviders.list` shows `allowPersonalData` and the tokens used this month. A decision provider a workspace uses for decisions is found by `useFor: ["decisions"]`; `ai.score` may also name a provider id.

`allowPersonalData` is **false** by default and can only be changed by a person (`aiProviders.create`/`update` are people-only). Set it to `true` only when the provider is covered by a **no-retention agreement**. JEV through CommandCode has none: a request with `x-cmd-zdr: 1` returns `422`.

## The request and the two endpoints

The same body works on both:

- CommandCode: `POST https://api.commandcode.ai/provider/v1/systemone` with `model: "typesafe/jev"` (or a pinned version such as `typesafe/jev-1.14.0`).
- TypeSafe directly: `POST https://api.typesafe.ai/v1/systemone`. Zero data retention is available only under an enterprise agreement.

```json
{
  "model": "typesafe/jev",
  "state": { "traits": { "plan": "pro" }, "segments": ["seg_…"], "eventCounts": { "page": 4 } },
  "questions": {
    "conversion_propensity": {
      "type": "noul",
      "instructions": "Is this person likely to convert in the next 14 days?"
    },
    "channel": {
      "type": "choice",
      "instructions": "Which channel fits?",
      "criteria": { "email": "E-mail", "sms": "SMS", "push": "Push" }
    },
    "intent": {
      "type": "score",
      "instructions": "How strong is the intent?",
      "criteria": ["Low", "Medium", "High"]
    }
  }
}
```

The response is TypeSafe's own, with one answer per question key:

```json
{
  "model": "jev-1.14.0",
  "answers": {
    "conversion_propensity": { "type": "noul", "noul": 0.82 },
    "channel": { "type": "choice", "choice": "email", "confidence": 0.7, "probabilities": { "email": 0.7, "sms": 0.2, "push": 0.1 } },
    "intent": { "type": "score", "score": 1.5, "confidence": 0.5, "probabilities": { "0": 0.1, "1": 0.3, "2": 0.6 } }
  },
  "usage": { "input_tokens": 210, "output_tokens": 14 }
}
```

`noul` returns the probability that the answer is yes. `choice` returns the chosen label, a probability for every label and confidence. `score` returns a position on the ordered levels, a probability for each level and confidence.

Limits enforced before a request is sent or metered:

- **100 questions** per call (each with a unique key).
- **64K tokens** for the state plus all questions; a conservative bound also keeps the state plus the longest question within 32K.
- A request timeout (30 seconds by default) and clear errors: `too_many_questions`, `too_large`, `personal_data`, `provider_error`, `timeout`, `invalid_response`.

## ai.score

```json
POST /v1/ai.score
{
  "questions": [{ "key": "conversion_propensity", "type": "noul", "instructions": "Likely to convert in 14 days?" }],
  "profileId": "prf_…",
  "store": { "key": "conversion_propensity", "ttlHours": 168 }
}
```

- `providerId` is optional; the provider used for decisions is the default.
- `state` is optional. With `profileId` and no state, the server builds a **non-personal** state from the person: segment ids, event counts, agent-visible non-personal traits and contextual fields.
- `profileId` checks the `ai_processing` consent exactly like `ai.classify` and journey AI steps.
- `store` saves the first answer as a named score for the person (needs `profileId`); the default TTL is 7 days.
- The answer is `{ answer, answers, model, modelVersion, callId, inputTokens, outputTokens, latencyMs, stored }`. There is no rationale.

The command writes one `ai_calls` row of kind `score` with the provider, model/version, tokens, latency and the **state hash and question set** — never the raw state. A refused state is logged too, so the refusal is auditable. `ai.calls { kind: "score" }` and `ai.usage` show these calls.

## Scores, segments and journeys

Scores live in `profile_scores`, one row per person and key (the newest value), with the value as a predicted probability in 0–1, confidence, the full distribution, model, model version, call id and `expires_at`. Expired scores are invisible to reads and segments.

- `profiles.scores { profileId, key? }` returns the unexpired scores.
- A segment condition can read one:

```json
{ "score": { "key": "conversion_propensity", "gte": 0.6 } }
```

  `gte`, `lte` or both are required, each between 0 and 1. The condition works in `segments.preview` and in published dynamic segments. It reads the same stored value and never calls the model.

- A journey **decision node** asks one typed question and routes on a threshold:

```json
{
  "id": "decide",
  "kind": "decision",
  "label": "Likely to convert?",
  "config": {
    "question": {
      "key": "conversion_propensity",
      "type": "noul",
      "instructions": "Is this person likely to convert in the next 14 days?"
    },
    "threshold": 0.5,
    "scoreKey": "conversion_propensity",
    "timeout": "PT5M"
  },
  "next": [{ "to": "high" }, { "to": "fallback" }]
}
```

The two edges are `[at-or-above the threshold, fallback]`. A `noul` compares its probability; a `choice` compares the probability of its `answer` label; a `score` compares the normalised score. Without consent, a provider error, a timeout or an invalid answer the participant takes the **fallback** edge, and the reason is on the participant and in `ai.calls`. Publishing validates the question (unique key, 2–255 choice labels or 2–10 score levels), the threshold (0–1) and the two edges. `journeys.simulate` shows the probability without calling a model:

```json
POST /v1/journeys.simulate { "artifactId": "jrn_…", "scores": { "decide": 0.7 } }
```

The step reads `decide: probability 0.700 ≥ 0.5`. With no score it shows the fallback edge. An end-to-end decision step stores the score under `scoreKey` (the question key when omitted) for later segments and steps.

## Privacy: no personal data by default

`typesafe/jev` has **no zero-data-retention path** upstream. A provider with `allowPersonalData: false` (the default) refuses a state that contains an e-mail address, phone number, payment or national identifier, IP address, or an identifier key. The refusal is an `invalid_input` error that names the kind of data found; nothing is sent, and a failed `ai.score` call records it in `ai.calls`.

Only these go into a state the server builds:

- **segment ids** (`seg_…`), not names or members;
- **event counts** by event name;
- **agent-visible non-personal traits** from the tracking plan (`agentVisible` and `pii: "none"`);
- **contextual fields** such as the trigger event's name — never free text with contact details.

The profile id is not sent. When a caller passes its own `state`, the same guard applies. A provider marked `allowPersonalData: true` under a no-retention agreement sends the state as given, but the call log still stores only a hash.

`ai_processing` consent applies as for every AI step: `ai.score` with a `profileId` and a journey decision node check it, and take the fallback/refuse when it is missing.

## Budgets and the call log

Decision calls use the same reservation and budget path as other providers: the estimated tokens (state + questions + a small answer allowance) are reserved under a per-provider lock before the call and released after it. `monthlyTokenBudget` is shared with the provider's other uses; when it is reached, `ai.score` returns a budget conflict and a journey decision takes its fallback edge.

`ai.calls` records kind `score`, status (`done`, `fallback`, `failed`), provider, model/version, tokens, latency and the state hash. `ai.usage` counts these tokens in the month and the estimated cost.

## Calibration

A decision model without calibration is a random number generator with confidence. `ai.calibration` compares stored predictions for one score key with a later event:

```json
POST /v1/ai.calibration
{ "scoreKey": "conversion_propensity", "event": "Order Completed", "withinDays": 14, "bins": 10 }
```

- Each prediction is counted as positive when the person did the event between the score's creation and `withinDays` later (one ClickHouse query maps event identifiers to profiles).
- The **reliability table** bins predictions by predicted probability (default 10 bins) and reports the number of people, the mean prediction and the observed share.
- The **Brier score** is the mean squared error of the predicted probability; lower is better, and 0.25 is a coin toss on a balanced outcome.

Use it on a holdout before promoting a decision node past a pilot, and watch the reliability table for bins that are consistently above or below the diagonal. Calibration is a report, not an automatic gate.

## The decision gate

Epic #192 promotes decision models past the pilot only when a decision model **beats the current rules/LLM path on a holdout**, at acceptable cost, latency and privacy. Otherwise record the result and keep `aiDecide`/rules. This release makes the adapter, the score store, the journey node and calibration available; it does not claim that JEV is better for any flow.

## What is not built

- A `score` prompt artifact (`ai.score` takes questions inline; there is no `promptId` variant yet).
- Send-time ranking, pre-send risk triage and inbound-reply triage. Replies contain personal data and JEV has no ZDR, so reply triage needs a ZDR-capable decision provider.
- A general ML platform, feature store or model training; this is an inference adapter with calibration.
- Probabilities for consent, suppression or eligibility — those stay deterministic.

---
section: Security
issues: [956]
---
- Known provider names are credential qualifiers, so `<provider>Key`, `<provider>Token` and `<provider>Secret` are redacted for the model providers a workspace can configure with its own key: `mistralKey`, `ollamaKey`, `vllmKey`, `litellmKey`, `openrouterKey`, `lmStudioKey`, `groqKey`, `togetherKey`, `deepseekKey`, `geminiKey`, `cohereKey`, `perplexityKey`, `fireworksKey`, `huggingfaceKey`, `hfKey`, `replicateKey`, `xaiKey`, `bedrockKey` and `vertexKey`, in camelCase and with `_key`/`-key` separators. Runtime provider names are free text, so this covers the names the platform knows: they are exported from `packages/ai` (`modelProviderNames`), and the completeness test reads the same list, so a known provider without a qualifier fails it.

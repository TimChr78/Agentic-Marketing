-- Wave 4, Phase 18 (#231; ADR-0016 §4.5): the independent model check.
-- Before an autonomous or held action a second model compares the agent's intent with the
-- action and its mandate. That call is logged with the other AI calls, kind "check".
ALTER TABLE ai_calls DROP CONSTRAINT ai_calls_kind_check;
ALTER TABLE ai_calls ADD CONSTRAINT ai_calls_kind_check CHECK (kind IN ('decide', 'generate', 'copilot', 'test', 'classify', 'check'));

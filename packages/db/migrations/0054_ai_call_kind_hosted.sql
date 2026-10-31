-- #274: hosted agent runs are logged with the other AI calls, kind "hosted", so the tokens they
-- use count against the provider's monthly budget.
ALTER TABLE ai_calls DROP CONSTRAINT ai_calls_kind_check;
ALTER TABLE ai_calls ADD CONSTRAINT ai_calls_kind_check CHECK (kind IN ('decide', 'generate', 'copilot', 'test', 'classify', 'check', 'hosted'));

-- Wave 4, Phase 18 (#223, #224, #225; ADR-0016): mandates and the first autonomy.
--
-- The policy engine gains a fourth decision, `hold` (act with veto): the action waits for a
-- person until a deadline, then runs unless vetoed. The ledger records which mandate version
-- decided and the agent's stated intent. An approval request can carry such a deadline.
ALTER TABLE agent_actions DROP CONSTRAINT agent_actions_decision_check;
ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_decision_check CHECK (decision IN ('allow', 'hold', 'ask', 'deny'));
ALTER TABLE agent_actions ADD COLUMN mandate_id text;
ALTER TABLE agent_actions ADD COLUMN mandate_version integer;
ALTER TABLE agent_actions ADD COLUMN intent text;

-- A held change (level 2) runs at hold_until unless a person rejects it first.
ALTER TABLE approval_requests ADD COLUMN hold_until timestamptz;
CREATE INDEX approval_requests_holds ON approval_requests (hold_until) WHERE status = 'pending' AND hold_until IS NOT NULL;

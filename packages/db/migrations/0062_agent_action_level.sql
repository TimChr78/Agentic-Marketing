-- Agent ledger (#327): the level the policy engine decided an action at. Level 4 is earned from
-- level-3 operation; a held change that ran after its veto window is recorded at level 2, so it no
-- longer counts. Older rows have no level and do not count towards earning level 4.
ALTER TABLE agent_actions ADD COLUMN level smallint;

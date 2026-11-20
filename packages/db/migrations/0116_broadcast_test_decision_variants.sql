-- The variant counts a subject test's winner decision used (#1099, 0.17.2).
--
-- The status report recomputed the variants on every read. After the decision, the rest of the
-- audience is sent under the winner's variant, so the winner's counts grew and no longer described
-- the sample the reason was recorded from: a test could say "fewer than 20 sends in a variant"
-- beside counts of 20 or more. Storing the decision's counts makes the reason and the reported
-- counts one read.
ALTER TABLE broadcast_tests ADD COLUMN IF NOT EXISTS decided_variants jsonb;

COMMENT ON COLUMN broadcast_tests.decided_variants IS
  'The variant counts the winner decision used, fixed when it was made; status reports these after the decision (#1099).';

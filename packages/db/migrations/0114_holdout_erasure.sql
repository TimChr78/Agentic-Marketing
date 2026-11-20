-- Erasure removes the person's holdout arms explicitly (#1048).
--
-- The foreign key from holdout_assignments to profiles already cascades, but the erasure stage and
-- a restore replay name the table so a report cannot count a person whose profile row is gone even
-- when a restored snapshot was loaded without its foreign keys or triggers. The app role is
-- append-only on this table (0041), so the deletion runs under the table owner and takes the
-- workspace from `app.workspace_id`, exactly like merge_holdout_assignments.
CREATE FUNCTION erase_holdout_assignments(p_profiles text[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ws uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  removed integer;
BEGIN
  IF ws IS NULL THEN RAISE EXCEPTION 'no workspace'; END IF;
  DELETE FROM holdout_assignments
  WHERE workspace_id = ws AND profile_id = ANY(p_profiles);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION erase_holdout_assignments(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_holdout_assignments(text[]) TO am_app;
COMMENT ON FUNCTION erase_holdout_assignments(text[]) IS
  'Removes the erased merged family''s holdout assignments in the caller''s workspace (#1048).';

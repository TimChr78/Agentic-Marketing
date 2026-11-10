-- A pending domain claim holds its hostname for seven days from when it became pending (#575),
-- not from when the row was created. Moving a verified domain to a new host or prefix starts a new
-- claim, so judging the window by created_at made a years-old row's fresh claim look expired at
-- once, and another workspace reclaimed it. created_at stays for display only.
ALTER TABLE workspace_domains ADD COLUMN pending_since timestamptz;

-- A claim that is pending now has been pending since its row was created. Verified rows keep the
-- value too; it only decides expiry while status = 'pending'.
UPDATE workspace_domains SET pending_since = created_at;

ALTER TABLE workspace_domains ALTER COLUMN pending_since SET NOT NULL;
ALTER TABLE workspace_domains ALTER COLUMN pending_since SET DEFAULT now();

-- The commands set pending_since themselves, but the window is a correctness rule, not a
-- convention: a future path that moves a row, resets its token or switches it back to pending
-- without setting the column must still start a fresh window. An explicit write to pending_since
-- wins, so a repair can backdate a row deliberately.
CREATE FUNCTION workspace_domains_track_pending() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'pending'
     AND NEW.pending_since IS NOT DISTINCT FROM OLD.pending_since
     AND (OLD.status <> 'pending'
          OR NEW.host <> OLD.host
          OR COALESCE(NEW.path_prefix, '') <> COALESCE(OLD.path_prefix, '')
          OR NEW.verification_token IS DISTINCT FROM OLD.verification_token) THEN
    NEW.pending_since := now();
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workspace_domains_pending_since
  BEFORE UPDATE ON workspace_domains
  FOR EACH ROW EXECUTE FUNCTION workspace_domains_track_pending();

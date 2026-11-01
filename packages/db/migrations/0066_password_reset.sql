-- Self-service password reset (#191): the audit log records the client IP of events that do not
-- come through the command layer (a reset request and a completed reset are unauthenticated and
-- have no principal workspace of their own). The hashed token, the token itself and the password
-- are never stored. Existing rows keep a null ip and their hash chain stays valid: the IP joins the
-- hash only for entries that have one.
ALTER TABLE audit_log ADD COLUMN ip text;

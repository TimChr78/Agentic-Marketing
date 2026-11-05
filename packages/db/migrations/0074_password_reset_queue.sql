-- Password reset request queue (#379). This is an installation-level outbox, not tenant data: the
-- public request path seals the normalized address with a key derived from the installation secret
-- and inserts one row before it looks anything up. Account lookup, single sign-on/password
-- eligibility, token minting and provider I/O all happen in the delivery worker, so every
-- syntactically valid address follows the same request work.
--
-- No tenant data key or network KEK is touched on the request path: `email_sealed` and the
-- worker-minted `token_sealed` use purpose-separated AES-256-GCM keys derived from AUTH_SECRET
-- (HKDF-SHA256). A database dump alone therefore yields neither an address nor a usable link.
--
-- The worker wipes `email_sealed` and `token_sealed` when a row reaches a terminal state, and the
-- cleanup path expires unprocessed rows (24 h) and prunes terminal rows (7 days). Running that
-- cleanup requires the worker role; a deployment without one neither sends nor cleans up.
CREATE TABLE password_reset_deliveries (
  id text PRIMARY KEY,
  -- Sealed normalized address, present only while the request is queued or sending.
  email_sealed bytea,
  -- The requesting client IP, used only for the audit entry the worker appends.
  ip text NOT NULL,
  -- The account resolved by the worker; null until then, and wiped on terminal completion.
  user_id text,
  -- Worker-minted Better Auth token, sealed with the installation secret.
  token_sealed bytea,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  -- Terminal outcome: sent, unknown, sso_only, no_password, no_sender, delivery_failed, expired,
  -- consumed, account_gone, invalid_token. Never an address or token.
  outcome text,
  attempts integer NOT NULL DEFAULT 0,
  -- Fencing value for the current delivery lease. Every retry/settle/token write requires it.
  claim_id uuid,
  next_attempt_at timestamptz,
  -- A bounded reason code, never an address or token.
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_deliveries_payload CHECK ((status IN ('queued', 'sending')) = (email_sealed IS NOT NULL)),
  CONSTRAINT password_reset_deliveries_claim CHECK ((status = 'sending') = (claim_id IS NOT NULL)),
  CONSTRAINT password_reset_deliveries_token CHECK (token_sealed IS NULL OR user_id IS NOT NULL),
  CONSTRAINT password_reset_deliveries_outcome CHECK ((status IN ('sent', 'failed', 'skipped')) = (outcome IS NOT NULL))
);

CREATE INDEX password_reset_deliveries_due
  ON password_reset_deliveries (next_attempt_at)
  WHERE status = 'queued';

CREATE INDEX password_reset_deliveries_stale
  ON password_reset_deliveries (updated_at)
  WHERE status = 'sending';

CREATE INDEX password_reset_deliveries_settled
  ON password_reset_deliveries (updated_at)
  WHERE status IN ('sent', 'failed', 'skipped');

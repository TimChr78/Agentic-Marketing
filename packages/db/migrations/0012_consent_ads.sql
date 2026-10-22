-- Wave 2, Phase 8: consent everywhere (prerequisite for performance marketing).

-- Ad click ids are identifiers of the person who clicked: they move with merges and go with
-- erasure like every identifier. Stored only with the ad_measurement purpose allowed.
ALTER TABLE identifiers DROP CONSTRAINT identifiers_type_check;
ALTER TABLE identifiers ADD CONSTRAINT identifiers_type_check
  CHECK (type IN ('anonymous_id', 'user_id', 'email', 'phone', 'gclid', 'gbraid', 'wbraid', 'fbc', 'fbp', 'msclkid'));

-- OAuth 2.0 connections: the authorization in progress (state hash, PKCE verifier) and the state
-- of the tokens. The tokens themselves are sealed with the connection's secrets.
ALTER TABLE connections ADD COLUMN oauth_status text CHECK (oauth_status IN ('pending', 'connected', 'error'));
ALTER TABLE connections ADD COLUMN oauth_error text;
ALTER TABLE connections ADD COLUMN oauth_pending jsonb;
ALTER TABLE connections ADD COLUMN token_expires_at timestamptz;
CREATE INDEX connections_oauth_expiry ON connections (token_expires_at) WHERE oauth_status = 'connected';
CREATE INDEX connections_oauth_state ON connections ((oauth_pending ->> 'stateHash')) WHERE oauth_pending IS NOT NULL;

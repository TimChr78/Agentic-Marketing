-- Rollout pause notification state (#473). Additive only.

-- A send is claimed by writing `notifying_at` and incrementing `notify_attempts` in its own commit,
-- then the e-mail is sent, and a second commit marks the pause notified (or schedules a retry). A
-- crash between the claim and the mark therefore leaves the row claimable again after the lease,
-- while the e-mail's idempotency key stays the same so a crash after the provider accepted it at
-- most duplicates one message (at-least-once, de-duplicated by key where the provider supports it).
ALTER TABLE experience_rollout_pauses ADD COLUMN notifying_at timestamptz;
ALTER TABLE experience_rollout_pauses ADD COLUMN notify_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE experience_rollout_pauses ADD COLUMN notify_after timestamptz;

COMMENT ON COLUMN experience_rollout_pauses.notifying_at IS
  'When a worker last claimed this pause for the owner e-mail (#473); null when no attempt is in flight.';
COMMENT ON COLUMN experience_rollout_pauses.notify_attempts IS
  'How many times the owner e-mail was claimed (#473); bounded so a permanently failing send stops retrying.';
COMMENT ON COLUMN experience_rollout_pauses.notify_after IS
  'The earliest instant a failed owner e-mail is retried (#473); null for a fresh or delivered pause.';

-- The delivery sweep finds owed e-mails that are not claimed and are due now.
CREATE INDEX experience_rollout_pauses_due ON experience_rollout_pauses (notified_at, notify_after)
  WHERE notified_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON experience_rollout_pauses TO am_app;

COMMENT ON TABLE experience_rollout_pauses IS
  'Durable record of each guardrail pause (#473, #476): the owner e-mail (claimed, sent, then marked, with a bounded retry) and the experience.rollout_paused agent event are delivered from it.';

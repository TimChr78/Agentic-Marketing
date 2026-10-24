-- Test sends (#46). A test send is a real message through the configured provider, but it is
-- marked so it never counts towards reporting, frequency caps or stream health, and so provider
-- events cannot change a person's consent. Every workspace may also keep a small seed list of
-- addresses (besides its members) that admins allow test sends to.

ALTER TABLE messages ADD COLUMN test boolean NOT NULL DEFAULT false;
ALTER TABLE workspaces ADD COLUMN seed_list text[] NOT NULL DEFAULT '{}';

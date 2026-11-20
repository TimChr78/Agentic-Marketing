-- The writer protocol marker (#1066). The 0.15.0 lock protocol and the 0.17.0 erasure contract
-- require that an older process never writes beside a newer one. A protocol change records its
-- version here in the same migration that changes the schema, so a server that implements an older
-- protocol can refuse to start writers instead of running across a drained upgrade by mistake.
--
-- Version 1 is the protocol this release implements. A future release that changes how writers
-- coordinate bumps the value and the server constant in apps/server/src/writerProtocol.ts together.
CREATE TABLE writer_protocol (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  protocol_version integer NOT NULL CHECK (protocol_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO writer_protocol (singleton, protocol_version) VALUES (true, 1);

COMMENT ON TABLE writer_protocol IS
  'The writer protocol version the database expects; a server refuses to start writers when this is newer than it implements (#1066).';
COMMENT ON COLUMN writer_protocol.protocol_version IS
  'Bumped by the migration that changes the writer lock or erasure protocol, together with the server constant.';

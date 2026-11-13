import { randomBytes } from 'node:crypto';
import type { EventBus } from '@agentic-marketing/events';
import type { HotState } from '@agentic-marketing/hotstate';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { inboundTokenHash } from '../src/connections';
import { inboundApi } from '../src/inbound';

// #885 round 6: a webhook mapping is the workspace's own JSONata, but when it throws the route used
// to answer the sender with the raw exception. That text can quote a credential the body or an
// expression carried, so it is redacted while complete, then cut.

const SECRET = 'probe-secret';
const kp = localKeyProvider(Buffer.alloc(32, 7).toString('base64'));

let t: DisposableDb;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  t = await createDisposableDb('inbound_mapping');
}, 120_000);

afterAll(async () => {
  if (t) await t.close();
});

async function addConnection(token: string, mapping: string) {
  const id = `con_${randomBytes(16).toString('hex')}`;
  await t.db.admin.query(
    `INSERT INTO connections (workspace_id, id, connector, name, settings, secrets, secrets_key_id, token_hash, enabled)
     VALUES ($1, $2, 'webhook', 'Incoming webhook', $3, NULL, NULL, $4, true)`,
    [t.workspace, id, JSON.stringify({ mapping }), inboundTokenHash(token)],
  );
  return id;
}

describe.skipIf(!hasTestDatabase())('inbound mapping failure text (#885)', () => {
  it('answers the sender with a redacted mapping error', async () => {
    const token = randomBytes(18).toString('base64url');
    const connection = await addConnection(token, `$error("password=${SECRET}")`);
    const server = inboundApi({
      db: t.db,
      bus: { publish: async () => ({ duplicates: 0 }) } as unknown as EventBus,
      kp,
      hot: {} as Pick<HotState, 'claim' | 'complete' | 'release'>,
    });

    const res = await server.request(`http://localhost/hooks/in/${connection}/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as { message: string };
    expect(payload.message).toContain('The mapping failed');
    expect(payload.message).toContain('password=');
    expect(payload.message).not.toContain(SECRET);
  });
});

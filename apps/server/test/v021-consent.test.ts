import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { evaluate, materialize } from '@agentic-marketing/segments';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CASES, P } from '../../../packages/profiles/test/consentCases';
import { startTestServer, type User } from './harness';

// 0.2.1 (#103): segment consent conditions follow the shared consent rule (ADR 0014) in both
// evaluators, the streaming one (JS) and the batch one (SQL), and a migration makes existing
// workspaces recompute their consent segments.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
const people = new Map<string, string>();

beforeAll(async () => {
  t = await startTestServer('test_v021_consent', 3298);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  await t.srv.db.withWorkspace(ws, async (tx) => {
    for (const c of CASES) {
      const id = `prf_${randomBytes(16).toString('hex')}`;
      people.set(c.name, id);
      await tx.execute(sql`INSERT INTO profiles (workspace_id, id) VALUES (${ws}, ${id})`);
      for (const r of c.rows)
        await tx.execute(sql`INSERT INTO consent_state (workspace_id, profile_id, purpose, channel, status, basis, source, updated_at)
          VALUES (${ws}, ${id}, ${r.purpose}, ${r.channel}, ${r.status}, 'consent', 'api', ${r.updatedAt.toISOString()})`);
    }
  });
}, 60_000);
afterAll(() => t?.close());

describe('consent conditions in segments', () => {
  it('give the same members in JS and SQL, as the shared rule says', async () => {
    const expected = CASES.filter((c) => c.any === 'granted').map((c) => people.get(c.name));
    const { js, batch } = await t.srv.db.withWorkspace(ws, async (tx) => {
      const ctx = { tx, workspaceId: ws, events: t.srv.events };
      const js = [...(await evaluate({ consent: P }, ctx))];
      const m = await materialize({ consent: P }, ctx);
      const rows = await tx.execute<{ profile_id: string }>(sql.raw(`SELECT profile_id FROM ${m.table}`));
      return { js, batch: rows.rows.map((r) => r.profile_id) };
    });
    expect(js.sort()).toEqual(expected.sort());
    expect(batch.sort()).toEqual(expected.sort());
  });

  it('the 0.2.1 migration makes the scheduler recompute consent segments only', async () => {
    const api = t.api(owner, ws);
    const create = async (name: string, condition: object) => {
      const a = await api.call('artifacts.create', { type: 'segment', name, content: { condition } });
      await api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'x' });
      await api.call('segments.refresh', { artifactId: a.artifactId });
      return a.artifactId;
    };
    const consent = await create('Subscribers', { consent: P });
    const nested = await create('Subscribers on pro', { all: [{ segment: consent }, { trait: 'plan', op: 'eq', value: 'pro' }] });
    const plain = await create('Pro', { trait: 'plan', op: 'eq', value: 'pro' });
    const migration = readFileSync(new URL('../../../packages/db/migrations/0026_consent_segments_recompute.sql', import.meta.url), 'utf8');
    await t.srv.db.admin.query(migration);
    const { rows } = await t.srv.db.admin.query<{ segment_id: string }>('SELECT segment_id FROM segment_runs WHERE workspace_id = $1', [
      ws,
    ]);
    const left = rows.map((r) => r.segment_id);
    expect(left).toContain(plain);
    expect(left).not.toContain(consent);
    expect(left).not.toContain(nested);
  });
});

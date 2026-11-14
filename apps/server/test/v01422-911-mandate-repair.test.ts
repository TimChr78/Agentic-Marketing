import { activeMandates, repairActiveMandates } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #911 review (A1): the SQL repair in 0094 ranked by parseable expiry and updated_at, but the
// runtime skips a mandate whose content fails the full schema. With an older valid mandate and a
// newer schema-invalid one, SQL archived the valid one and kept the unusable one, so the agent
// lost its mandate. The repair now runs in code, under the `am.agent-mandate` lock, and keeps
// exactly what `activeMandates` picks.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_v01422_911r', testPort(4464), {}, { holdTickMs: 86_400_000 });
  owner = await t.signUp(`owner-v01422-911r-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

/** A published mandate artifact, as a pre-fix install left duplicates behind. */
async function seedMandate(ws: string, content: unknown, opts: { name: string; updatedMinutesAgo: number }) {
  const id = newId('mnd');
  await t.srv.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version, created_at, updated_at)
     VALUES ($1, $2, 'agent_mandate', $3, 1, 1, now() - interval '30 days', now() - make_interval(mins => $4))`,
    [ws, id, opts.name, opts.updatedMinutesAgo],
  );
  await t.srv.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3, $4, 'user', $5)`,
    [ws, id, content, `hash-${id}`, owner.id],
  );
  return id;
}

const valid = (agent: string, purpose = 'Act for this workspace') => ({ agent, purpose, validUntil: inDays(30) });
const invalid = (agent: string) => ({ agent, purpose: '', validUntil: inDays(30) });

/** What the policy engine uses for one agent, exactly as the runtime computes it. */
const activeId = (ws: string, agentId: string) =>
  t.srv.db.withWorkspace(ws, (tx) => activeMandates(tx, [agentId])).then((map) => map.get(agentId)?.view.id ?? null);

const archivedOf = async (ws: string, ids: string[]) => {
  const { rows } = await t.srv.db.admin.query<{ id: string; archived: boolean; name: string }>(
    'SELECT id, archived, name FROM artifacts WHERE workspace_id = $1 AND id = ANY($2::text[]) ORDER BY id',
    [ws, ids],
  );
  return rows;
};

describe('the single-active-mandate repair keeps what the runtime uses (#911 A1)', () => {
  it('keeps an older valid mandate over a newer one the runtime skips', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const agent = newId('agt');
    const olderValid = await seedMandate(ws, valid(agent), { name: 'Older valid', updatedMinutesAgo: 60 * 24 * 3 });
    const newerInvalid = await seedMandate(ws, invalid(agent), { name: 'Newer invalid', updatedMinutesAgo: 10 });

    const before = await activeId(ws, agent);
    expect(before).toBe(olderValid);

    const out = await repairActiveMandates(t.srv.db);
    expect(out.archived).toContain(newerInvalid);

    // The runtime's answer does not change, and the unusable row is the one archived.
    expect(await activeId(ws, agent)).toBe(before);
    expect(await archivedOf(ws, [olderValid, newerInvalid])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: newerInvalid, archived: true, name: `Newer invalid (archived duplicate ${newerInvalid})` }),
        expect.objectContaining({ id: olderValid, archived: false }),
      ]),
    );
  });

  it('breaks an equal updated_at tie the same way the runtime does and does not change the answer', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const agent = newId('agt');
    const first = await seedMandate(ws, valid(agent), { name: 'First', updatedMinutesAgo: 30 });
    const second = await seedMandate(ws, valid(agent), { name: 'Second', updatedMinutesAgo: 30 });
    await t.srv.db.admin.query(
      'UPDATE artifacts SET updated_at = (SELECT updated_at FROM artifacts WHERE id = $1) WHERE workspace_id = $2 AND id = $3',
      [first, ws, second],
    );

    const before = await activeId(ws, agent);
    await repairActiveMandates(t.srv.db);
    expect(await activeId(ws, agent)).toBe(before);
    // The runtime orders by updated_at and then id, so the higher id wins.
    expect(before).toBe([first, second].sort().at(-1));
    const rows = await archivedOf(ws, [first, second]);
    expect(rows.filter((r) => !r.archived).map((r) => r.id)).toEqual([before]);
  });

  it('never lets an expired mandate win over a valid one', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const agent = newId('agt');
    const expired = await seedMandate(
      ws,
      { agent, purpose: 'Expired', validUntil: inDays(-1) },
      {
        name: 'Expired',
        updatedMinutesAgo: 1,
      },
    );
    const validRow = await seedMandate(ws, valid(agent, 'Still valid'), { name: 'Valid', updatedMinutesAgo: 60 * 24 });

    expect(await activeId(ws, agent)).toBe(validRow);
    await repairActiveMandates(t.srv.db);
    expect(await activeId(ws, agent)).toBe(validRow);
    expect(await archivedOf(ws, [expired, validRow])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expired, archived: true }),
        expect.objectContaining({ id: validRow, archived: false }),
      ]),
    );
  });

  it('leaves other agents, single mandates and already repaired workspaces alone', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const repairedAgent = newId('agt');
    const kept = await seedMandate(ws, valid(repairedAgent), { name: 'Kept', updatedMinutesAgo: 60 });
    const gone = await seedMandate(ws, valid(repairedAgent), { name: 'Gone', updatedMinutesAgo: 120 });
    const otherAgent = newId('agt');
    const otherOnly = await seedMandate(ws, invalid(otherAgent), { name: 'Other agent', updatedMinutesAgo: 60 });

    const first = await repairActiveMandates(t.srv.db);
    expect(first.archived).toEqual([gone]);
    expect(await archivedOf(ws, [kept, gone, otherOnly])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: kept, archived: false }),
        expect.objectContaining({ id: gone, archived: true }),
        expect.objectContaining({ id: otherOnly, archived: false }),
      ]),
    );

    // Recorded once per workspace; the next run finds nothing to do.
    const recorded = await t.srv.db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM data_repairs WHERE name = 'single_active_mandate' AND workspace_id = $1",
      [ws],
    );
    expect(recorded.rows[0]?.n).toBe(1);
    expect((await repairActiveMandates(t.srv.db)).archived).toEqual([]);
  });
});

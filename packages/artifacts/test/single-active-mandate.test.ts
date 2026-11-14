import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../../db/src/migrate';
import { APP_ROLE, createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';

// #911: a published mandate is unique per agent before the fix only for new publishes (the
// `am.agent-mandate` validator lock, #871). Workspaces that hit the pre-fix race kept two live
// mandates for one agent. The migration archives every one `activeMandates` would not pick: the
// newest updated_at among published, unarchived mandates whose validUntil is in the future.

const open: DisposableDb[] = [];
afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
});

let nextId = 1;
const id = (prefix: string) => `${prefix}_${(nextId++).toString(16).padStart(32, '0')}`;
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

describe.skipIf(!hasTestDatabase())('single active mandate migration (#911)', () => {
  it('keeps the mandate activeMandates picks and archives the others, leaving other agents alone', async () => {
    const d = await createDisposableDb('mandate', { upTo: '0093_one_published_version.sql' });
    open.push(d);
    const ws = d.workspace;
    const otherWs = crypto.randomUUID();
    await d.db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [otherWs, 'Other', 'none']);

    const mandate = async (workspace: string, agent: string, validUntil: string, updatedDaysAgo: number) => {
      const artifactId = id('mnd');
      await d.db.admin.query(
        `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version, created_at, updated_at)
         VALUES ($1, $2, 'agent_mandate', $3, 1, 1, now() - interval '30 days', now() - make_interval(days => $4))`,
        [workspace, artifactId, `Mandate ${agent} v${updatedDaysAgo}`, updatedDaysAgo],
      );
      await d.db.admin.query(
        `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
         VALUES ($1, $2, 1, 'published', $3, $4, 'user', 'usr_seed')`,
        [workspace, artifactId, { agent, purpose: 'Seed', validUntil }, `hash-${artifactId}`],
      );
      return artifactId;
    };

    const agentA = id('agt');
    const aOlderValid = await mandate(ws, agentA, days(30), 3);
    const aNewerValid = await mandate(ws, agentA, days(20), 1);
    // An expired mandate that is newer than a valid one never wins.
    const agentB = id('agt');
    const bValid = await mandate(ws, agentB, days(30), 2);
    const bExpiredNewer = await mandate(ws, agentB, days(-1), 0);
    // A single mandate is untouched.
    const agentC = id('agt');
    const cOnly = await mandate(ws, agentC, days(30), 5);
    // The same agent id in another workspace is a different agent: its mandates stay as they are.
    const dDuplicate = await mandate(otherWs, agentA, days(30), 1);
    const dDuplicate2 = await mandate(otherWs, agentA, days(30), 2);
    const eOnly = await mandate(otherWs, id('agt'), days(30), 4);

    await migrate(d.db.admin, APP_ROLE);

    const row = async (workspace: string, artifactId: string) =>
      (
        await d.db.admin.query<{ archived: boolean; name: string }>(
          'SELECT archived, name FROM artifacts WHERE workspace_id = $1 AND id = $2',
          [workspace, artifactId],
        )
      ).rows[0];

    expect(await row(ws, aNewerValid)).toMatchObject({ archived: false });
    expect(await row(ws, aOlderValid)).toMatchObject({ archived: true });
    expect((await row(ws, aOlderValid))?.name).toBe(`Mandate ${agentA} v3 (archived duplicate ${aOlderValid})`);
    expect(await row(ws, bValid)).toMatchObject({ archived: false });
    expect(await row(ws, bExpiredNewer)).toMatchObject({ archived: true });
    expect(await row(ws, cOnly)).toMatchObject({ archived: false });
    expect(await row(otherWs, dDuplicate)).toMatchObject({ archived: false });
    expect(await row(otherWs, dDuplicate2)).toMatchObject({ archived: true });
    expect(await row(otherWs, eOnly)).toMatchObject({ archived: false });

    // Exactly one live, published mandate remains per agent in the repaired workspace.
    const live = await d.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM artifacts
        WHERE workspace_id = $1 AND type = 'agent_mandate' AND archived = false AND published_version IS NOT NULL`,
      [ws],
    );
    expect(live.rows[0]?.n).toBe(3);
  }, 120_000);
});

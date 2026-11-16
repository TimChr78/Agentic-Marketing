import { randomUUID } from 'node:crypto';
import type { BusEvent } from '@agentic-marketing/events';
import { holdoutHashVersion } from '@agentic-marketing/journeys';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #972: campaigns.holdoutResult used to load the campaign's whole assignment history, pick each
// person's winner in JavaScript and keep every person in memory for the ClickHouse event query.
// The winners are chosen in SQL now and the event pass reads the people in bounded pages. The
// report must not change with the page size.

const PORT = testPort(3525);
const DB = 'test_v01427_holdout_paging';
const CONTROL = 13;
const TREATMENT = 12;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let campaign = '';

const stamp = Date.now();
const api = () => t.api(owner, ws);
const profileId = () => `prf_${randomUUID().replaceAll('-', '')}`;
const control = Array.from({ length: CONTROL }, profileId);
const treatment = Array.from({ length: TREATMENT }, profileId);
// One treatment person was also reached under a profile that was merged into them: their holding
// row sits on the alias, and a conversion arrives under it. The report resolves both to the person.
const alias = profileId();

const assignedAt = new Date(Date.now() - 2 * 86_400_000);
const convertAt = new Date(assignedAt.getTime() + 86_400_000).toISOString();

const conversion = (profileId: string): BusEvent => ({
  workspaceId: ws,
  sourceId: 'test',
  messageId: `v01427_${profileId}`,
  type: 'track',
  name: 'Campaign Purchase',
  anonymousId: '',
  userId: '',
  profileId,
  timestamp: convertAt,
  receivedAt: convertAt,
  properties: {},
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
});

beforeAll(async () => {
  t = await startTestServer(DB, PORT);
  owner = await t.signUp(`owner-holdout-paging-${stamp}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');

  // No members: this test measures the report's holdout path, not a send. The control group and
  // the goal are what the command reads.
  const created = await api().call('artifacts.create', {
    type: 'campaign',
    name: 'Paged holdout report',
    content: {
      goal: { kind: 'conversion', event: 'Campaign Purchase', attributionDays: 7 },
      controlGroup: { percent: 50, minSampleSize: 100 },
      members: [],
    },
  });
  campaign = created.artifactId;
  await api().call('artifacts.requestPublish', { artifactId: campaign, note: 'paged holdout report' });

  await t.srv.db.admin.query(`INSERT INTO profiles (workspace_id, id) SELECT $1, x FROM unnest($2::text[]) AS x`, [
    ws,
    [...control, ...treatment, alias],
  ]);
  await t.srv.db.admin.query(`UPDATE profiles SET merged_into = $3 WHERE workspace_id = $1 AND id = $2`, [ws, alias, treatment[0]!]);
  const hash = holdoutHashVersion(50);
  await t.srv.db.admin.query(
    `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
     SELECT $1, 'campaign', $2, $3, x, 'control', $4 FROM unnest($5::text[]) AS x`,
    [ws, campaign, hash, assignedAt, control],
  );
  await t.srv.db.admin.query(
    `INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
     SELECT $1, 'campaign', $2, $3, x, 'treatment', $4 FROM unnest($5::text[]) AS x`,
    [ws, campaign, hash, assignedAt, [...treatment, alias]],
  );
  // Six control and four treatment people convert inside the attribution window; the aliased
  // conversion belongs to treatment[0].
  await t.srv.events.insert([...control.slice(0, 6).map(conversion), ...treatment.slice(0, 4).map(conversion), conversion(alias)]);
}, 180_000);

afterAll(() => t?.close());

describe('paged holdout report (#972)', () => {
  it('returns the same result when the people list crosses a page boundary', async () => {
    const unpaged = await api().call('campaigns.holdoutResult', { campaignId: campaign });
    expect([unpaged.control.entered, unpaged.treatment.entered]).toEqual([CONTROL, TREATMENT]);
    expect([unpaged.control.converted, unpaged.treatment.converted]).toEqual([6, 4]);
    expect(unpaged.suppressed).toBe(false);

    process.env.CAMPAIGN_HOLDOUT_PAGE_SIZE = '4';
    try {
      const paged = await api().call('campaigns.holdoutResult', { campaignId: campaign });
      expect(paged).toEqual(unpaged);
    } finally {
      delete process.env.CAMPAIGN_HOLDOUT_PAGE_SIZE;
    }
  }, 120_000);
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// Wave 5, Phase 24 (B1, #445): broadcasts.list returns each broadcast's operational row in one
// read. The run, stage and current-delivery projections must match broadcasts.status exactly, and
// the list pages by full-precision updatedAt/id without repeating or skipping a tied row.

const PORT = testPort(3511);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let ws2 = '';
let template = '';
let segment = '';
let scheduled = '';
let done = '';
let stopped = '';
let draft = '';
const extraDrafts: string[] = [];

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

const api = (workspace = ws) => t.api(owner, workspace);

const create = async (workspace: string, type: 'email_template' | 'segment' | 'broadcast', name: string, content: object) =>
  (await api(workspace).call('artifacts.create', { type, name, content })).artifactId;

const publish = async (workspace: string, artifactId: string) => {
  await api(workspace).call('artifacts.requestPublish', { artifactId, note: 'broadcasts.list test' });
  return artifactId;
};

const list = (input: any) => api().call('broadcasts.list', input);
const status = (artifactId: string) => api().call('broadcasts.status', { artifactId });

/** Wait until the scheduler has created the broadcast's run (the tick runs every 300 ms). */
const runOf = (artifactId: string) =>
  eventually(
    async () =>
      (await t.srv.db.admin.query('SELECT status FROM broadcast_runs WHERE workspace_id = $1 AND broadcast_id = $2', [ws, artifactId]))
        .rows[0],
    (row) => !!row,
    20_000,
  );

const message = (artifactId: string, id: string, messageStatus: string, test = false) => [
  ws,
  id,
  `key-${id}`,
  `prf_${id.slice(-32).padStart(32, '0')}`,
  'marketing_email',
  artifactId,
  messageStatus,
  test,
];

const insertMessage = (artifactId: string, id: string, messageStatus: string, test = false) =>
  t.srv.db.admin.query(
    'INSERT INTO messages (workspace_id, id, idempotency_key, profile_id, purpose, journey_id, status, test) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    message(artifactId, id, messageStatus, test),
  );

beforeAll(async () => {
  t = await startTestServer('test_broadcasts_list', PORT);
  owner = await t.signUp(`owner-broadcasts-list-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  ws2 = await t.workspaceWith([[owner, 'owner']], 'none');

  for (const workspace of [ws, ws2]) {
    const publishedTemplate = await publish(
      workspace,
      await create(workspace, 'email_template', 'Newsletter', {
        purpose: 'marketing_email',
        subject: 'Weekly issue',
        mjml: mjml('Hello reader'),
      }),
    );
    const publishedSegment = await publish(
      workspace,
      await create(workspace, 'segment', 'Subscribers', { condition: { consent: 'marketing_email' } }),
    );
    if (workspace === ws) {
      template = publishedTemplate;
      segment = publishedSegment;
    }
  }

  // Scheduled: a future sendAt keeps the run scheduled while the scheduler ticks.
  scheduled = await publish(ws, await create(ws, 'broadcast', 'Scheduled issue', { template, segment, sendAt: '2030-01-04T09:00:00Z' }));
  await runOf(scheduled);

  // Done: the runner finished; the row carries its counts.
  done = await publish(ws, await create(ws, 'broadcast', 'Done issue', { template, segment, sendAt: '2030-01-11T09:00:00Z' }));
  await runOf(done);
  await t.srv.db.admin.query(
    `UPDATE broadcast_runs SET status = 'done', started_at = now() - interval '2 hours', finished_at = now() - interval '1 hour',
       recipients = 12, queued = 10, skipped = 2, window_skipped = 1, error = NULL
     WHERE workspace_id = $1 AND broadcast_id = $2`,
    [ws, done],
  );

  // Stopped: a staged send whose canary breached a threshold.
  stopped = await publish(
    ws,
    await create(ws, 'broadcast', 'Stopped issue', {
      template,
      segment,
      sendAt: '2030-01-18T09:00:00Z',
      stagedSend: { canaryPercent: 20, wait: 'PT2H', maxBounceRate: 0.05 },
    }),
  );
  await runOf(stopped);
  await eventually(
    async () =>
      (await t.srv.db.admin.query('SELECT stage FROM broadcast_stages WHERE workspace_id = $1 AND broadcast_id = $2', [ws, stopped]))
        .rows[0],
    (row) => !!row,
    20_000,
  );
  await t.srv.db.admin.query(
    `UPDATE broadcast_runs SET status = 'stopped', started_at = now() - interval '3 hours', finished_at = now() - interval '2 hours',
       recipients = 20, queued = 4, skipped = 0, window_skipped = 3
     WHERE workspace_id = $1 AND broadcast_id = $2`,
    [ws, stopped],
  );
  await t.srv.db.admin.query(
    `UPDATE broadcast_stages SET stage = 'stopped', canary_recipients = 4, canary_queued = 4, sent = 4, bounced = 1,
       bounce_rate = 0.25, stop_reason = 'Bounce rate 25% is above the 5% limit', stopped_at = now() - interval '2 hours'
     WHERE workspace_id = $1 AND broadcast_id = $2`,
    [ws, stopped],
  );

  // The done broadcast's messages by current status; the test send never counts.
  await insertMessage(done, 'msg_00000000000000000000000000000001', 'sent');
  await insertMessage(done, 'msg_00000000000000000000000000000002', 'sent');
  await insertMessage(done, 'msg_00000000000000000000000000000003', 'sent');
  await insertMessage(done, 'msg_00000000000000000000000000000004', 'delivered');
  await insertMessage(done, 'msg_00000000000000000000000000000005', 'bounced');
  await insertMessage(done, 'msg_00000000000000000000000000000006', 'sent', true);

  // Never scheduled: a draft broadcast has no run.
  draft = await create(ws, 'broadcast', 'Draft issue', { template, segment });
  for (let i = 0; i < 6; i++) extraDrafts.push(await create(ws, 'broadcast', `Draft issue ${i}`, { template, segment }));

  // Another workspace's broadcast must never appear in this workspace's pages.
  await create(ws2, 'broadcast', 'Other workspace issue', { template, segment });
}, 180_000);

afterAll(() => t?.close());

describe('broadcasts.list (B1)', () => {
  it('reports the same run, stage and delivery as broadcasts.status for each state', async () => {
    const page = await list({ limit: 100 });
    const byId = new Map(page.broadcasts.map((b) => [b.artifactId, b]));

    for (const [artifactId, expected, latestState] of [
      [scheduled, 'scheduled', 'published'],
      [done, 'done', 'published'],
      [stopped, 'stopped', 'published'],
      [draft, 'not_scheduled', 'draft'],
    ] as const) {
      const row = byId.get(artifactId);
      expect(row, artifactId).toBeDefined();
      const s = await status(artifactId);
      expect(row!.run).toEqual(s.run);
      expect(row!.run.status).toBe(expected);
      expect(row!.delivery).toEqual(s.delivery);
      expect(row!.stage ? { stage: row!.stage.stage, stopReason: row!.stage.stopReason } : null).toEqual(
        s.stage ? { stage: s.stage.stage, stopReason: s.stage.stopReason } : null,
      );
      // Content comes from the run's pinned version (the published one here).
      expect(row!.segmentId).toBe(segment);
      expect(row!.templateId).toBe(template);
      expect(row!.latestState).toBe(latestState);
    }

    expect(byId.get(done)!.delivery).toEqual({ sent: 3, delivered: 1, bounced: 1 });
    expect(byId.get(stopped)!.stage).toEqual({ stage: 'stopped', stopReason: 'Bounce rate 25% is above the 5% limit' });
    expect(byId.get(draft)!.run).toMatchObject({ status: 'not_scheduled', version: null, recipients: 0 });
  });

  it('filters by run status before pagination and counts the filtered set', async () => {
    expect((await list({ statuses: ['scheduled'], limit: 1 })).total).toBe(1);
    const scheduledPage = await list({ statuses: ['scheduled'], limit: 1 });
    expect(scheduledPage.broadcasts.map((b) => b.artifactId)).toEqual([scheduled]);
    expect(scheduledPage.nextCursor).toBeNull();

    expect((await list({ statuses: ['stopped'] })).broadcasts.map((b) => b.artifactId)).toEqual([stopped]);
    expect((await list({ statuses: ['done', 'stopped'] })).total).toBe(2);

    const drafts = await list({ statuses: ['not_scheduled'] });
    expect(drafts.total).toBe(7);
    expect(new Set(drafts.broadcasts.map((b) => b.artifactId))).toEqual(new Set([draft, ...extraDrafts]));

    // An unknown combination is empty rather than unfiltered.
    expect((await list({ statuses: ['failed'] })).total).toBe(0);
  });

  it('pages every row once when updatedAt ties, with a stable total', async () => {
    // One shared microsecond: the id tie-break has to carry the page boundary.
    await t.srv.db.admin.query(
      `UPDATE artifacts SET updated_at = '2026-11-04 12:34:56.123456+00' WHERE workspace_id = $1 AND type = 'broadcast'`,
      [ws],
    );
    const total = (await list({ limit: 2 })).total;
    expect(total).toBe(10);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await list({ limit: 2, ...(cursor ? { cursor } : {}) });
      expect(page.total).toBe(total);
      seen.push(...page.broadcasts.map((b) => b.artifactId));
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(20);
    } while (cursor);

    expect(pages).toBe(5);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('keeps another workspace’s broadcasts out of the list and total', async () => {
    const mine = await list({ limit: 100 });
    expect(mine.total).toBe(10);

    const other = await api(ws2).call('broadcasts.list', { limit: 100 });
    expect(other.total).toBe(1);
    expect(other.broadcasts.map((b) => b.name)).toEqual(['Other workspace issue']);
    const theirIds = new Set(other.broadcasts.map((b) => b.artifactId));
    expect(mine.broadcasts.some((b) => theirIds.has(b.artifactId))).toBe(false);
  });

  it('rejects a malformed cursor instead of restarting from the first page', async () => {
    await expect(api().call('broadcasts.list', { cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('keeps status pinned to the run version when a later draft targets another segment', async () => {
    // v1 sends to `segment`; v2 (a draft) targets another segment. The operational status stays on
    // the pinned definition, so the detail page can never pair v2's audience with v1's recipients.
    const otherSegment = await create(ws, 'segment', 'Other readers', { condition: { consent: 'marketing_email' } });
    const pinned = await publish(ws, await create(ws, 'broadcast', 'Pinned issue', { template, segment, sendAt: '2030-02-01T09:00:00Z' }));
    await runOf(pinned);

    expect(await status(pinned)).toMatchObject({ segmentId: segment, templateId: template });
    await api().call('artifacts.updateDraft', {
      artifactId: pinned,
      content: { template, segment: otherSegment, sendAt: '2030-02-01T09:00:00Z' },
    });
    const after = await status(pinned);
    expect(after.run).toMatchObject({ status: 'scheduled', version: 1 });
    expect(after.segmentId).toBe(segment);
    expect(after.templateId).toBe(template);
  });
});

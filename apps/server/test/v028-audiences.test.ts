import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// Phase 15 (#83): static lists and snapshots. Membership is a stored list, edited by command or
// CSV and mirrored into segment_memberships; the refresh job leaves it alone, sends still apply
// consent and suppression, and a snapshot stays fixed until it is refreshed.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let key = '';

beforeAll(async () => {
  t = await startTestServer('test_v028_audiences', testPort(3251));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  key = (await t.api(owner, ws).call('sources.create', { name: 'Backend', kind: 'server' })).key;
}, 60_000);
afterAll(() => t?.close());

const api = () => t.api(owner, ws);

const send = (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

const emailOf = (userId: string) => `${userId}@example.com`;

async function person(userId: string, traits: Record<string, unknown> = {}) {
  await send([{ type: 'identify', userId, traits: { email: emailOf(userId), ...traits } }]);
  return (
    await eventually(
      () => api().call('profiles.find', { type: 'user_id', value: userId }),
      (r) => !!r.profileId,
    )
  ).profileId!;
}

async function grant(profileId: string) {
  await api().call('consent.record', {
    profileId,
    purpose: 'marketing_email',
    channel: 'email',
    status: 'granted',
    source: 'api',
    proof: { test: true },
  });
}

async function createSegment(name: string, content: Record<string, unknown>) {
  const a = await api().call('artifacts.create', { type: 'segment', name, content });
  await api().call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'test' });
  return a.artifactId;
}

describe('static and snapshot audiences', () => {
  const ids: Record<string, string> = {};
  let list = '';
  let dynamic = '';

  it('adds people by e-mail, reports unknown people, and adding twice is a no-op', async () => {
    ids.ada = await person('ada', { city: 'Aarhus' });
    ids.bo = await person('bo', { city: 'Odense' });
    ids.cy = await person('cy', { city: 'Aarhus' });
    ids.di = await person('di', { city: 'Aarhus' });
    await grant(ids.ada);
    await grant(ids.cy);
    await grant(ids.di);

    list = await createSegment('Partner list', { mode: 'static' });
    const add = await api().call('audiences.add', {
      segmentId: list,
      emails: [emailOf('ada'), emailOf('cy'), 'nobody@example.com'],
    });
    expect(add).toMatchObject({ added: 2, existing: 0, unmatched: [{ value: 'nobody@example.com', reason: 'not_found' }] });

    const again = await api().call('audiences.add', { segmentId: list, emails: [emailOf('ada')] });
    expect(again).toMatchObject({ added: 0, existing: 1, unmatched: [] });

    const members = await api().call('segments.members', { artifactId: list });
    expect(members.total).toBe(2);
    expect(members.members.map((m) => m.profileId).sort()).toEqual([ids.ada, ids.cy].sort());
    // The owner has profiles:pii, so the page can show the decrypted e-mail.
    expect(members.members.every((m) => typeof m.email === 'string' && m.email.endsWith('@example.com'))).toBe(true);
    expect(await api().call('segments.preview', { artifactId: list })).toMatchObject({ count: 2 });

    // By profile id and user id too, and only to a list.
    await api().call('audiences.add', { segmentId: list, profileIds: [ids.bo], userIds: ['di'] });
    expect((await api().call('segments.members', { artifactId: list })).total).toBe(4);
    const dynamicTest = await createSegment('Aarhus rule', { condition: { trait: 'city', op: 'eq', value: 'Aarhus' } });
    const notAList = await api().call('segments.members', { artifactId: dynamicTest });
    expect(notAList.total).not.toBe(4);
    await expect(api().call('audiences.add', { segmentId: dynamicTest, profileIds: [ids.ada] })).rejects.toMatchObject({ status: 400 });
  });

  it('imports a CSV: matches by e-mail, reports unmatched rows without personal data, and is idempotent', async () => {
    // Start from ada and cy only, so the import has one person to add.
    await api().call('audiences.remove', { segmentId: list, userIds: ['bo', 'di'] });
    const csv = [
      'email,name',
      `${emailOf('ada')},Ada`,
      `${emailOf('bo')},Bo`,
      'unknown@example.com,Unknown',
      'not-an-email,Broken',
      `${emailOf('ada')},Ada again`,
    ].join('\n');

    const preview = await api().call('audiences.import', { segmentId: list, csv, column: 'email', idType: 'email', dryRun: true });
    expect(preview).toMatchObject({ importId: null, rows: 5, matched: 3, added: 1, existing: 1 });
    expect(preview.unmatched).toEqual([
      { row: 4, reason: 'not_found' },
      { row: 5, reason: 'invalid' },
    ]);
    expect(JSON.stringify(preview.unmatched)).not.toContain('unknown@example.com');
    expect(JSON.stringify(preview.unmatched)).not.toContain('not-an-email');

    const applied = await api().call('audiences.import', {
      segmentId: list,
      csv,
      column: 'email',
      idType: 'email',
      fileName: 'partner.csv',
    });
    expect(applied).toMatchObject({ rows: 5, matched: 3, added: 1, existing: 1 });
    expect(applied.importId).not.toBeNull();
    expect((await api().call('segments.members', { artifactId: list })).total).toBe(3);

    // The same file again adds nobody; the history keeps both imports.
    const retried = await api().call('audiences.import', { segmentId: list, csv, column: 'email', idType: 'email' });
    expect(retried).toMatchObject({ rows: 5, matched: 3, added: 0, existing: 2 });
    const history = await api().call('audiences.imports', { segmentId: list });
    expect(history.imports.length).toBe(2);
    expect(history.imports[0].fileName).toBeNull();
    expect(history.imports[0].unmatched).toEqual([
      { row: 4, reason: 'not_found' },
      { row: 5, reason: 'invalid' },
    ]);
    expect(JSON.stringify(history.imports)).not.toContain('unknown@example.com');
  });

  it('removes people, and a refresh leaves the stored list alone', async () => {
    const remove = await api().call('audiences.remove', { segmentId: list, emails: [emailOf('ada')] });
    expect(remove).toMatchObject({ removed: 1, notMembers: 0 });
    const missing = await api().call('audiences.remove', { segmentId: list, emails: [emailOf('ada')] });
    expect(missing).toMatchObject({ removed: 0, notMembers: 1 });

    const before = await api().call('segments.members', { artifactId: list });
    const refreshed = await api().call('segments.refresh', { artifactId: list });
    expect(refreshed).toEqual({ members: before.total, entered: 0, exited: 0 });
    expect((await api().call('segments.members', { artifactId: list })).total).toBe(before.total);
    // Put Ada back for the send test.
    await api().call('audiences.add', { segmentId: list, emails: [emailOf('ada')] });
  });

  it('reports a list membership stamp so an import invalidates a referencing estimate (#771)', async () => {
    const stampList = await createSegment('Stamp list', { mode: 'static' });
    await api().call('audiences.add', { segmentId: stampList, emails: [emailOf('ada')] });

    const own = await api().call('segments.preview', { artifactId: stampList });
    expect(own.count).toBe(1);
    expect(own.segments).toEqual([
      { id: stampList, version: 1, stamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/) },
    ]);
    const first = own.segments[0].stamp;

    // A rule that references the list resolves it, and the same stamp travels with its count.
    const rule = await api().call('segments.preview', { condition: { segment: stampList } });
    expect(rule).toMatchObject({ count: 1 });
    expect(rule.segments).toEqual([{ id: stampList, version: 1, stamp: first }]);

    // An import changes who the list holds without publishing a version: only the stamp moves.
    await api().call('audiences.add', { segmentId: stampList, emails: [emailOf('bo')] });
    const after = await api().call('segments.preview', { artifactId: stampList });
    expect(after.count).toBe(2);
    expect(after.segments[0].version).toBe(1);
    expect(after.segments[0].stamp).not.toBe(first);
  });

  it('gives concurrent imports into one list strictly increasing stamps (#771 review)', async () => {
    // A stamp only moves forward: two imports that commit one after the other must never share
    // (or go backwards from) the previous value, or a client polling preview misses one of them.
    const micros = (stamp: string) => {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})\.(\d{6})Z$/.exec(stamp);
      if (!m) throw new Error(`unexpected stamp ${stamp}`);
      return BigInt(Date.parse(`${m[1]}T${m[2]}Z`)) * 1000n + BigInt(m[3]);
    };

    const concurrent = await createSegment('Concurrent list', { mode: 'static' });
    const people = ['c1', 'c2', 'c3', 'c4'];
    for (const name of people) await person(`v028-concurrent-${name}`, { city: 'Testholm' });
    await api().call('audiences.add', { segmentId: concurrent, emails: [emailOf('v028-concurrent-c1')] });
    const before = (await api().call('segments.preview', { artifactId: concurrent })).segments[0].stamp as string;

    const imports = await Promise.all(
      people.map((name) =>
        api().call('audiences.import', {
          segmentId: concurrent,
          csv: `email\n${emailOf(`v028-concurrent-${name}`)}`,
          column: 'email',
          idType: 'email',
        }),
      ),
    );
    // c1 is already on the list; the other three are new.
    expect(imports.reduce((n, r) => n + r.added, 0)).toBe(3);

    const after = (await api().call('segments.preview', { artifactId: concurrent })).segments[0].stamp as string;
    expect(after).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    // Four list writes (one adds nobody, but each records a run) ran concurrently after the stamp
    // was read: each must have advanced it by at least one microsecond, even when
    // clock_timestamp() returned the same instant for two.
    expect(micros(after) - micros(before)).toBeGreaterThanOrEqual(BigInt(people.length));
    expect((await api().call('segments.members', { artifactId: concurrent })).total).toBe(4);
  });

  it('reports no reference stamp to a caller that cannot read the segment (#771 review)', async () => {
    const hidden = await createSegment('Hidden list', { mode: 'static' });
    await api().call('audiences.add', { segmentId: hidden, emails: [emailOf('ada')] });

    // The workspace can read artifacts, so the estimate can watch the list it referenced.
    expect(await api().call('segments.preview', { condition: { segment: hidden } })).toMatchObject({
      count: 1,
      segments: [{ id: hidden, version: 1, stamp: expect.stringMatching(/^\d{4}-/) }],
    });

    // A token limited to profiles:read may count the audience, but the segment's version and
    // membership stamp belong to an artifact it cannot read.
    const token = await api().call('apiTokens.create', { name: 'preview only', scopes: ['profiles:read'] });
    const preview = (body: unknown) =>
      fetch(`${t.base}/v1/segments.preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token.token}` },
        body: JSON.stringify(body),
      });
    const byRule = await preview({ condition: { segment: hidden } });
    expect(byRule.status).toBe(200);
    expect(await byRule.json()).toMatchObject({ count: 1, segments: [] });

    const byId = await preview({ artifactId: hidden });
    expect(byId.status).toBe(200);
    expect(await byId.json()).toMatchObject({ count: 1, segments: [] });
  });

  it('a broadcast to a static list reaches members with consent only', async () => {
    const template = await api().call('artifacts.create', {
      type: 'email_template',
      name: 'List issue',
      content: {
        purpose: 'marketing_email',
        subject: 'Hello',
        mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text><mj-text><a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>',
      },
    });
    await api().call('artifacts.requestPublish', { artifactId: template.artifactId, note: 'test' });
    const broadcast = await api().call('artifacts.create', {
      type: 'broadcast',
      name: 'List send',
      content: { template: template.artifactId, segment: list, sendAt: '2099-01-01T00:00:00Z' },
    });
    await api().call('artifacts.requestPublish', { artifactId: broadcast.artifactId, note: 'test' });

    const preview = await api().call('broadcasts.preview', { artifactId: broadcast.artifactId });
    // Ada and Cy consented, Bo did not; all three are on the list.
    expect(preview.audience).toBe(3);
    expect(preview.wouldSend).toBe(2);
    expect(preview.wouldSkip.no_lawful_basis).toBe(1);
  });

  it('creates a snapshot, keeps it fixed when the source changes, and refreshes on demand', async () => {
    dynamic = await createSegment('Aarhus', { condition: { trait: 'city', op: 'eq', value: 'Aarhus' } });
    await api().call('segments.refresh', { artifactId: dynamic });
    const source = await api().call('segments.members', { artifactId: dynamic });
    expect(new Set(source.members.map((m) => m.profileId))).toEqual(new Set([ids.ada, ids.cy, ids.di]));

    const snapshot = await api().call('audiences.snapshot', { sourceSegmentId: dynamic, name: 'Aarhus freeze', note: 'freeze it' });
    expect(snapshot.members).toBe(3);
    const snapMembers = await api().call('segments.members', { artifactId: snapshot.artifactId });
    expect(new Set(snapMembers.members.map((m) => m.profileId))).toEqual(new Set([ids.ada, ids.cy, ids.di]));
    expect(await api().call('segments.preview', { artifactId: snapshot.artifactId })).toMatchObject({ count: 3 });
    const got = await api().call('artifacts.get', { artifactId: snapshot.artifactId });
    expect(got.version.content).toMatchObject({ mode: 'snapshot', sourceSegment: dynamic, snapshotVersion: 1 });
    expect(typeof (got.version.content as { snapshotAt?: string }).snapshotAt).toBe('string');

    // A new person joins the rule; the snapshot stays fixed until refreshed.
    ids.eve = await person('eve', { city: 'Aarhus' });
    await api().call('segments.refresh', { artifactId: dynamic });
    expect((await api().call('segments.members', { artifactId: dynamic })).total).toBe(4);
    expect((await api().call('segments.members', { artifactId: snapshot.artifactId })).total).toBe(3);
    // Only a refresh changes a snapshot: it must not drift between review and send.
    const members = await api().call('segments.members', { artifactId: dynamic });
    const edit = await rejects(
      api().call('audiences.remove', { segmentId: snapshot.artifactId, profileIds: [members.members[0].profileId] }),
    );
    expect(edit.message).toMatch(/refreshSnapshot/);

    const refreshed = await api().call('audiences.refreshSnapshot', { segmentId: snapshot.artifactId });
    expect(refreshed).toMatchObject({ members: 4, added: 1, removed: 0 });
    expect((await api().call('segments.members', { artifactId: snapshot.artifactId })).total).toBe(4);
    const history = await api().call('audiences.imports', { segmentId: snapshot.artifactId });
    expect(history.imports[0]).toMatchObject({ source: 'snapshot', rows: 4, matched: 4, added: 1 });
  });

  it('erasure removes list membership', async () => {
    expect((await api().call('segments.members', { artifactId: list })).members.some((m) => m.profileId === ids.cy)).toBe(true);
    await api().call('profiles.erase', { profileId: ids.cy, reason: 'test erasure' });
    expect((await api().call('segments.members', { artifactId: list })).members.some((m) => m.profileId === ids.cy)).toBe(false);
    const { rows } = await t.srv.db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM segment_list_members WHERE workspace_id = $1 AND segment_id = $2 AND profile_id = $3',
      [ws, list, ids.cy],
    );
    expect(rows[0].n).toBe(0);
  });

  it('a journey segment trigger fires when a list gains a person', async () => {
    const journey = await api().call('artifacts.create', {
      type: 'journey',
      name: 'List entry',
      content: {
        purpose: 'marketing_email',
        nodes: [
          { id: 'trigger', kind: 'trigger', label: 'Joined the list', config: { segment: list, reentry: 'always' } },
          { id: 'exit', kind: 'exit', label: 'Done', config: {} },
        ],
      },
    });
    await api().call('artifacts.requestPublish', { artifactId: journey.artifactId, note: 'test' });

    // Add a new person by user id: the Segment Entered event should enrol them.
    ids.fay = await person('fay', { city: 'Odense' });
    const added = await api().call('audiences.add', { segmentId: list, userIds: ['fay'] });
    expect(added.added).toBe(1);

    const participant = await eventually(
      () =>
        t.srv.db.admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM journey_participants WHERE workspace_id = $1 AND journey_id = $2 AND profile_id = $3',
          [ws, journey.artifactId, ids.fay],
        ),
      (r) => (r.rows[0]?.n ?? 0) > 0,
    );
    expect(participant.rows[0].n).toBe(1);
    const events = await eventually(
      () => api().call('profiles.events', { profileId: ids.fay }),
      (r) => r.events.some((e) => e.name === 'Segment Entered' && e.properties.segment_id === list),
    );
    expect(events.events.some((e) => e.name === 'Segment Entered' && e.properties.segment_id === list)).toBe(true);
  });
});

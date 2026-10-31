import type { JourneyDefinition } from '@agentic-marketing/artifacts';
import { runEnrollmentJobsOnce } from '@agentic-marketing/journeys';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// #148: a segment backfill beyond journeys.enroll's 1,000 ids. A job enrolls the segment in chunks
// with a resumable cursor, applies re-entry/consent/suppression per person and reports why people
// were skipped; the audience threshold decides for an agent, and an idempotency key returns the
// same job.

const PEOPLE = 1_200;
// Every tenth person has no consent for the journey's purpose.
const WITHOUT_CONSENT = PEOPLE / 10;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let segmentId = '';
let journeyId = '';
let resumeJourneyId = '';
let token = '';
let agentId = '';

const api = () => t.api(owner);

const mjml =
  '<mjml><mj-body><mj-section><mj-column><mj-text>Hej</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>';

async function call(name: string, body: unknown = {}) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const countProfiles = async () =>
  (await t.srv.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM profiles WHERE workspace_id = $1', [ws])).rows[0]?.n ?? 0;
const countConsents = async () =>
  (
    await t.srv.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM consent_state
       WHERE workspace_id = $1 AND purpose = 'marketing_email' AND status = 'granted'`,
      [ws],
    )
  ).rows[0]?.n ?? 0;
const countParticipants = async (journey: string) =>
  (
    await t.srv.db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM journey_participants WHERE workspace_id = $1 AND journey_id = $2',
      [ws, journey],
    )
  ).rows[0]?.n ?? 0;

/** Drives the scheduler's enrollment sweep until the job stops. */
async function runUntilSettled(jobId: string, maxRuns = 12) {
  for (let i = 0; i < maxRuns; i++) {
    const job = await api().call('journeys.enrollmentJob', { jobId });
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job;
    await runEnrollmentJobsOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events });
  }
  return api().call('journeys.enrollmentJob', { jobId });
}

const journeyContent = (reentry: 'once' | 'always', templateId: string): JourneyDefinition => ({
  purpose: 'marketing_email',
  nodes: [
    { id: 'trigger', kind: 'trigger', label: 'Bulk entry', config: { event: 'Bulk Entry', reentry } },
    // Nothing sends during the test: the first step after entry is a long wait.
    { id: 'wait', kind: 'wait', label: 'Wait', config: { duration: 'P30D' } },
    { id: 'mail', kind: 'email', label: 'Welcome', config: { template: templateId } },
    { id: 'done', kind: 'exit', label: 'Done', config: {} },
  ],
});

beforeAll(async () => {
  t = await startTestServer('test_bulk_enroll', testPort(2717));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const client = api();
  await client.call('emailProviders.create', { name: 'Outbox', adapter: 'log', fromEmail: 'news@example.com', useFor: ['marketing'] });

  const template = await client.call('artifacts.create', {
    type: 'email_template',
    name: 'Bulk welcome',
    content: { purpose: 'marketing_email', subject: 'Welcome', mjml },
  });
  await client.call('artifacts.requestPublish', { artifactId: template.artifactId, note: 'setup' });

  await client.call('profiles.import', {
    label: 'Bulk enrollment fixture',
    rows: Array.from({ length: PEOPLE }, (_, i) => ({
      email: `bulk${i}@example.com`,
      traits: { region: 'eu', firstName: `Bulk ${i}` },
      ...(i % 10 === 9 ? {} : { consent: [{ purpose: 'marketing_email' as const, status: 'granted' as const }] }),
    })),
  });
  // Import publishes identify and consent events; wait until the workers stored every person and
  // the consent the enrollment gate reads.
  await eventually(countProfiles, (n) => n === PEOPLE, 180_000);
  await eventually(countConsents, (n) => n === PEOPLE - WITHOUT_CONSENT, 180_000);

  const segment = await client.call('artifacts.create', {
    type: 'segment',
    name: 'Imported list',
    content: { condition: { trait: 'region', op: 'eq', value: 'eu' } },
  });
  segmentId = segment.artifactId as string;
  await client.call('artifacts.requestPublish', { artifactId: segmentId, note: 'setup' });
  await eventually(
    () => client.call('segments.refresh', { artifactId: segmentId }),
    (r) => r.members === PEOPLE,
    60_000,
  );

  journeyId = (
    await client.call('artifacts.create', { type: 'journey', name: 'Bulk once', content: journeyContent('once', template.artifactId) })
  ).artifactId as string;
  await client.call('artifacts.requestPublish', { artifactId: journeyId, note: 'setup' });
  resumeJourneyId = (
    await client.call('artifacts.create', { type: 'journey', name: 'Bulk always', content: journeyContent('always', template.artifactId) })
  ).artifactId as string;
  await client.call('artifacts.requestPublish', { artifactId: resumeJourneyId, note: 'setup' });

  // An agent with just the scope the command needs.
  token = (await client.call('apiTokens.create', { name: 'Bulk enroll agent', scopes: ['messages:send', 'artifacts:read'] })).token;
  agentId = (await call('agents.get')).body.id;
}, 240_000);

afterAll(() => t?.close());

describe('bulk enrollment by segment (#148)', () => {
  it('enrolls a segment of 1,200 across chunks and reports why people were skipped', async () => {
    // One consenting person is already in the journey: re-entry "once" must skip them.
    const already = (await api().call('profiles.find', { type: 'email', value: 'bulk1@example.com' })).profileId as string;
    await api().call('journeys.enroll', { artifactId: journeyId, profileIds: [already], reason: 'fixture' });

    const created = await api().call('journeys.enrollSegment', {
      artifactId: journeyId,
      segmentId,
      reason: 'migrate the imported list',
    });
    expect(created).toMatchObject({ status: 'queued', people: PEOPLE, duplicate: false });
    expect(created.jobId).toMatch(/^job_[0-9a-f]{32}$/);

    // The first sweep is one chunk: the job stays running and a cursor records where it stopped.
    await runEnrollmentJobsOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events });
    const first = await api().call('journeys.enrollmentJob', { jobId: created.jobId });
    expect(first.status).toBe('running');
    expect(first.cursor).toMatch(/^prf_[0-9a-f]{32}$/);
    expect(first.entered + first.skipped + first.failed).toBeLessThanOrEqual(500);

    const done = await runUntilSettled(created.jobId);
    expect(done).toMatchObject({ status: 'done', entered: PEOPLE - WITHOUT_CONSENT - 1, skipped: WITHOUT_CONSENT + 1, failed: 0 });
    expect(done.entered + done.skipped + done.failed).toBe(PEOPLE);
    expect(done.skipReasons).toMatchObject({ no_lawful_basis: WITHOUT_CONSENT, reentry: 1 });
    expect(await countParticipants(journeyId)).toBe(PEOPLE - WITHOUT_CONSENT);

    const listed = await api().call('journeys.enrollmentJobs', { journeyId });
    expect(listed.jobs.map((j: { jobId: string }) => j.jobId)).toContain(created.jobId);
  }, 240_000);

  it('returns the same job for the same idempotency key, and refuses a different request', async () => {
    const body = { artifactId: journeyId, segmentId, limit: 5, reason: 'a small retry-safe backfill', idempotencyKey: 'bulk-retry-1' };
    const first = await api().call('journeys.enrollSegment', body);
    const second = await api().call('journeys.enrollSegment', body);
    expect(second).toMatchObject({ jobId: first.jobId, status: first.status, people: first.people, duplicate: true });
    expect(first.duplicate).toBe(false);

    const conflict = await rejects(api().call('journeys.enrollSegment', { ...body, artifactId: resumeJourneyId }));
    expect(conflict.code).toBe('conflict');
  });

  it('cancels a running job and stops advancing it', async () => {
    const created = await api().call('journeys.enrollSegment', { artifactId: journeyId, segmentId, reason: 'cancel me' });
    await runEnrollmentJobsOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events });
    const running = await api().call('journeys.enrollmentJob', { jobId: created.jobId });
    expect(running.status).toBe('running');

    const cancelled = await api().call('journeys.cancelEnrollment', { jobId: created.jobId, reason: 'stop' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finishedAt).not.toBeNull();

    await runEnrollmentJobsOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events });
    const after = await api().call('journeys.enrollmentJob', { jobId: created.jobId });
    expect(after).toMatchObject({ status: 'cancelled', cursor: cancelled.cursor, entered: cancelled.entered, skipped: cancelled.skipped });
  });

  it('refuses an agent above the audience threshold with the reason, and audits it', async () => {
    const denied = await call('journeys.enrollSegment', { artifactId: journeyId, segmentId, reason: 'enrol the whole list' });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain('above the workspace’s threshold of 1,000');
    expect(denied.body.message).toContain('cannot wait for an approval');

    const { actions } = await api().call('agents.activity', { agentId, decision: 'deny', limit: 5 });
    const refusal = actions.find((a: { command: string }) => a.command === 'journeys.enrollSegment');
    expect(refusal).toMatchObject({ decision: 'deny', actionClass: 'journey.live' });
    expect(refusal?.impact).toMatchObject({ people: PEOPLE, touches: { segments: expect.arrayContaining([segmentId]) } });

    // Capping the audience with limit brings it under the threshold: the agent may start it.
    const allowed = await call('journeys.enrollSegment', { artifactId: journeyId, segmentId, limit: 10, reason: 'ten at a time' });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ status: 'queued', people: 10, duplicate: false });
  });

  it('resumes from the cursor after a crash without enrolling anyone twice', async () => {
    const created = await api().call('journeys.enrollSegment', { artifactId: resumeJourneyId, segmentId, reason: 'resume me' });
    await runEnrollmentJobsOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events });
    const first = await api().call('journeys.enrollmentJob', { jobId: created.jobId });
    expect(first.status).toBe('running');
    expect(first.cursor).not.toBeNull();

    // Simulate a crash: the process lost the "running" flag but the committed cursor remains.
    await t.srv.db.admin.query(`UPDATE enrollment_jobs SET status = 'queued' WHERE id = $1`, [created.jobId]);
    const done = await runUntilSettled(created.jobId);
    expect(done).toMatchObject({ status: 'done', entered: PEOPLE - WITHOUT_CONSENT, skipped: WITHOUT_CONSENT, failed: 0 });

    const duplicates = await t.srv.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT profile_id FROM journey_participants
         WHERE workspace_id = $1 AND journey_id = $2
         GROUP BY profile_id HAVING count(*) > 1
       ) d`,
      [ws, resumeJourneyId],
    );
    expect(duplicates.rows[0]?.n).toBe(0);
    expect(await countParticipants(resumeJourneyId)).toBe(PEOPLE - WITHOUT_CONSENT);
  }, 240_000);
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #398: successful bulk reads participate in the same audit chain as profiles.get/export,
// including redacted reads. Audit records contain an input hash, never decrypted output.
describe('PII list read auditing', () => {
  let t: Awaited<ReturnType<typeof startTestServer>>;
  let owner: User;
  let reader: User;
  let ws: string;
  let segment: string;

  beforeAll(async () => {
    t = await startTestServer('test_v072_pii_audit', testPort(3491));
    owner = await t.signUp(`audit-owner-${Date.now()}@example.com`);
    reader = await t.signUp(`audit-reader-${Date.now()}@example.com`);
    ws = await t.workspaceWith(
      [
        [owner, 'owner'],
        [reader, 'marketer'],
      ],
      'none',
    );
    const api = t.api(owner, ws);
    const source = await api.call('sources.create', { name: 'Backend', kind: 'server' });
    const res = await fetch(`${t.base}/v1/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${source.key}:`).toString('base64')}` },
      body: JSON.stringify({
        batch: [{ type: 'identify', userId: 'read-audit-person', traits: { email: 'private-audit@example.com', plan: 'pro' } }],
      }),
    });
    expect(res.ok).toBe(true);
    await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'read-audit-person' }),
      (r) => !!r.profileId,
    );
    const created = await api.call('artifacts.create', {
      type: 'segment',
      name: 'Pro',
      content: { condition: { trait: 'plan', op: 'eq', value: 'pro' } },
    });
    segment = created.artifactId;
    await api.call('artifacts.requestPublish', { artifactId: segment, note: 'Audit test' });
    await api.call('segments.refresh', { artifactId: segment });
  });
  afterAll(() => t?.close());

  for (const pii of [true, false]) {
    it(`audits a successful ${pii ? 'decrypted' : 'redacted'} list read`, async () => {
      const user = pii ? owner : reader;
      const api = t.api(user, ws);
      const before = await t.srv.db.admin.query<{ seq: string }>(
        'SELECT coalesce(max(seq), 0) AS seq FROM audit_log WHERE workspace_id = $1',
        [ws],
      );
      const profiles = await api.call('profiles.list', {});
      const members = await api.call('segments.members', { artifactId: segment });
      expect(profiles.profiles).toHaveLength(1);
      expect(members.members).toHaveLength(1);
      expect(profiles.profiles[0].email).toBe(pii ? 'private-audit@example.com' : null);
      expect(members.members[0].email).toBe(pii ? 'private-audit@example.com' : null);
      const audit = await t.srv.db.admin.query(
        `SELECT command, principal_id, ok, input_hash FROM audit_log WHERE workspace_id = $1 AND seq > $2
         AND command IN ('profiles.list', 'segments.members') ORDER BY seq`,
        [ws, before.rows[0].seq],
      );
      expect(audit.rows).toEqual([
        { command: 'profiles.list', principal_id: user.id, ok: true, input_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { command: 'segments.members', principal_id: user.id, ok: true, input_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ]);
      expect(JSON.stringify(audit.rows)).not.toContain('private-audit@example.com');
    });
  }
});

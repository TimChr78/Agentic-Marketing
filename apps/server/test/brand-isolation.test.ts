import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #189: a brand is a workspace, so the same e-mail address is a different person in each brand.
// An unsubscribe, topic change, suppression, erasure or export in one brand must not reach the
// other, and the export must name the workspace it belongs to.

const PORT = testPort(3495);
const SMTP_PORT = testPort(3496);
const FROM = '2026-01-01T00:00:00.000Z';
const to = () => new Date(Date.now() + 86_400_000).toISOString();

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let wsA = '';
let wsB = '';
let templateA = '';
let templateB = '';
let webhookA = '';
let webhookB = '';
const sharedEmail = `shared-${Date.now()}@example.com`;
const bounceEmail = `bounce-${Date.now()}@example.com`;
const complaintEmail = `complaint-${Date.now()}@example.com`;
let sharedA = '';
let sharedB = '';
let bounceA = '';
let bounceB = '';
let complaintA = '';
let complaintB = '';

const apiA = () => t.api(owner, wsA);
const apiB = () => t.api(owner, wsB);

const inbox: { to: string[]; data: string }[] = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, session, cb) {
    let data = '';
    stream.on('data', (chunk) => (data += chunk));
    stream.on('end', () => {
      inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), data });
      cb();
    });
  },
});

const purposesContent = {
  purposes: DEFAULT_PURPOSES.map((p) =>
    p.key === 'marketing_email'
      ? {
          ...p,
          topics: [
            { key: 'newsletter', name: 'Weekly newsletter', description: 'The Friday issue', default: 'subscribed' as const },
            { key: 'product_news', name: 'Product news', description: 'Launches and changes', default: 'unsubscribed' as const },
          ],
        }
      : p,
  ),
};

const template = (subject: string) => ({
  purpose: 'marketing_email',
  subject,
  mjml: `<mjml><mj-body><mj-section><mj-column>
    <mj-text>Hello {{ profile.firstName | default: 'there' }}</mj-text>
    <mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a> · <a href="{{ preferences_url | raw }}">Preferences</a></mj-text>
  </mj-column></mj-section></mj-body></mjml>`,
});

async function importPerson(api: ReturnType<typeof t.api>, email: string, brand: string) {
  await api.call('profiles.import', {
    label: `Brand ${brand} subscribers`,
    rows: [
      {
        email,
        traits: { brand, firstName: brand.toLowerCase() },
        consent: [{ purpose: 'marketing_email', status: 'granted' as const }],
      },
    ],
  });
  const found = await eventually(
    () => api.call('profiles.find', { type: 'email', value: email }),
    (r) => !!r.profileId,
  );
  await eventually(
    () => api.call('profiles.get', { profileId: found.profileId! }),
    (p) => p.consent.some((c) => c.purpose === 'marketing_email' && c.status === 'granted'),
  );
  return found.profileId!;
}

async function publish(api: ReturnType<typeof t.api>, artifactId: string) {
  await api.call('artifacts.requestPublish', { artifactId, note: 'brand isolation test' });
}

beforeAll(async () => {
  await new Promise<void>((r) => smtp.listen(SMTP_PORT, '127.0.0.1', () => r()));
  t = await startTestServer('test_brand_isolation', PORT);
  owner = await t.signUp(`brand-isolation-${Date.now()}@example.com`);
  wsA = await t.workspaceWith([[owner, 'owner']], 'none');
  wsB = await t.workspaceWith([[owner, 'owner']], 'none');

  for (const [index, fromEmail] of ['news@brand-a.example', 'news@brand-b.example'].entries()) {
    const api = index === 0 ? apiA() : apiB();
    const purposes = await api.call('artifacts.create', { type: 'purposes', name: 'Purposes', content: purposesContent });
    await publish(api, purposes.artifactId);
    const provider = await api.call('emailProviders.create', {
      name: `SMTP ${fromEmail}`,
      adapter: 'smtp',
      config: { host: '127.0.0.1', port: SMTP_PORT, requireTls: false, events: 'postmark' },
      secrets: { password: 'relay-password' },
      fromEmail,
      fromName: 'News',
      useFor: ['marketing'],
    });
    if (index === 0) webhookA = provider.webhookPath;
    else webhookB = provider.webhookPath;
    const created = await api.call('artifacts.create', {
      type: 'email_template',
      name: `News ${fromEmail}`,
      content: template(`News for ${fromEmail}`),
    });
    await publish(api, created.artifactId);
    if (index === 0) templateA = created.artifactId;
    else templateB = created.artifactId;
  }

  sharedA = await importPerson(apiA(), sharedEmail, 'A');
  sharedB = await importPerson(apiB(), sharedEmail, 'B');
  bounceA = await importPerson(apiA(), bounceEmail, 'A');
  bounceB = await importPerson(apiB(), bounceEmail, 'B');
  complaintA = await importPerson(apiA(), complaintEmail, 'A');
  complaintB = await importPerson(apiB(), complaintEmail, 'B');
}, 120_000);

afterAll(async () => {
  await t?.close();
  await new Promise<void>((r) => smtp.close(() => r()));
});

describe('per-brand data semantics (#189)', () => {
  it('keeps two profiles, consent ledgers and event histories for the same e-mail address', async () => {
    expect(sharedA).toMatch(/^prf_/);
    expect(sharedB).toMatch(/^prf_/);
    expect(sharedA).not.toBe(sharedB);
    expect((await apiA().call('profiles.get', { profileId: sharedA })).traits).toMatchObject({ brand: 'A' });
    expect((await apiB().call('profiles.get', { profileId: sharedB })).traits).toMatchObject({ brand: 'B' });

    const eventsA = await eventually(
      () => apiA().call('profiles.events', { profileId: sharedA }),
      (r) => r.events.length >= 2,
    );
    const eventsB = await eventually(
      () => apiB().call('profiles.events', { profileId: sharedB }),
      (r) => r.events.length >= 2,
    );
    expect(eventsA.events.length).toBeGreaterThanOrEqual(2);
    expect(eventsB.events.length).toBeGreaterThanOrEqual(2);
  });

  it('unsubscribes only brand A through the public link, leaving brand B consented', async () => {
    const token = t.srv.email.links.sign({ w: wsA, p: sharedA, u: 'marketing_email', m: 'isolation-unsubscribe-a' });
    const res = await fetch(`${t.base}/u/${token}`, { method: 'POST' });
    expect(res.status).toBe(200);

    const a = await apiA().call('consent.history', { profileId: sharedA });
    expect(a.records.at(-1)).toMatchObject({
      purpose: 'marketing_email',
      channel: 'email',
      status: 'withdrawn',
      source: 'unsubscribe',
    });

    const b = await apiB().call('consent.history', { profileId: sharedB });
    expect(b.records.map((r) => `${r.purpose}:${r.status}`)).toEqual(['marketing_email:granted']);
    expect((await apiB().call('profiles.get', { profileId: sharedB })).consent).toContainEqual(
      expect.objectContaining({ purpose: 'marketing_email', status: 'granted' }),
    );
  });

  it('records a consent command only in the brand it was called for', async () => {
    await apiA().call('consent.record', {
      profileId: sharedA,
      purpose: 'marketing_email',
      status: 'objected',
      source: 'api',
      proof: { via: 'brand isolation test' },
    });

    const a = await apiA().call('profiles.get', { profileId: sharedA });
    expect(a.consent).toContainEqual(expect.objectContaining({ purpose: 'marketing_email', status: 'objected' }));

    const historyB = await apiB().call('consent.history', { profileId: sharedB });
    expect(historyB.records).toHaveLength(1);
    expect(historyB.records[0]).toMatchObject({ purpose: 'marketing_email', status: 'granted' });
  });

  it('changes a topic in brand A’s preference centre without touching brand B', async () => {
    const token = t.srv.email.links.sign({ w: wsA, p: sharedA, u: 'marketing_email', m: 'isolation-preferences-a' });
    const saved = await fetch(`${t.base}/u/p/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'topic:product_news': 'subscribed' }).toString(),
    });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain('Your preferences are saved.');

    const a = await apiA().call('topics.preferences', { profileId: sharedA });
    expect(a.topics.find((x) => x.topic === 'product_news')).toMatchObject({
      status: 'subscribed',
      source: 'preference_center',
    });

    const b = await apiB().call('topics.preferences', { profileId: sharedB });
    expect(b.topics.find((x) => x.topic === 'product_news')).toMatchObject({ status: 'unsubscribed' });
    expect(b.topics.find((x) => x.topic === 'product_news')?.source).not.toBe('preference_center');
    expect(b.topics.find((x) => x.topic === 'newsletter')).toMatchObject({ status: 'subscribed' });
  });

  it('suppresses a hard bounce only in the brand that received it', async () => {
    expect(await apiA().call('messages.sendEmail', { profileId: bounceA, templateId: templateA })).toMatchObject({
      status: 'queued',
    });
    const sent = await eventually(
      () => apiA().call('messages.list', { profileId: bounceA }),
      (r) => r.messages[0]?.status === 'sent',
    );
    const messageId = sent.messages[0].id;

    const res = await fetch(`${t.base}${webhookA}`, {
      method: 'POST',
      body: JSON.stringify({
        RecordType: 'Bounce',
        ID: 11,
        Type: 'HardBounce',
        Description: 'Unknown user',
        MessageID: 'pm-isolation-a',
        BouncedAt: new Date().toISOString(),
        Metadata: { am_message_id: messageId },
      }),
    });
    expect(await res.json()).toEqual({ ok: true, events: 1 });

    expect(await apiA().call('messages.sendEmail', { profileId: bounceA, templateId: templateA })).toMatchObject({
      status: 'suppressed',
      reason: expect.stringContaining('hard_bounce'),
    });
    expect(await apiB().call('messages.sendEmail', { profileId: bounceB, templateId: templateB })).toMatchObject({
      status: 'queued',
    });

    const suppressions = async (ws: string) =>
      (
        await t.srv.db.admin.query<{ reason: string }>('SELECT reason FROM suppressions WHERE workspace_id = $1 ORDER BY reason', [ws])
      ).rows.map((r) => r.reason);
    expect(await suppressions(wsA)).toEqual(['hard_bounce']);
    expect(await suppressions(wsB)).toEqual([]);
    expect(inbox.some((m) => m.to.includes(bounceEmail))).toBe(true);
  });

  it('suppresses a complaint only in the brand that received it', async () => {
    expect(await apiB().call('messages.sendEmail', { profileId: complaintB, templateId: templateB })).toMatchObject({
      status: 'queued',
    });
    const sent = await eventually(
      () => apiB().call('messages.list', { profileId: complaintB }),
      (r) => r.messages[0]?.status === 'sent',
    );
    const res = await fetch(`${t.base}${webhookB}`, {
      method: 'POST',
      body: JSON.stringify({
        RecordType: 'SpamComplaint',
        ID: 12,
        MessageID: 'pm-isolation-b',
        BouncedAt: new Date().toISOString(),
        Metadata: { am_message_id: sent.messages[0].id },
      }),
    });
    expect(await res.json()).toEqual({ ok: true, events: 1 });

    // A complaint also withdraws consent, so the gateway may refuse on either ground.
    expect(await apiB().call('messages.sendEmail', { profileId: complaintB, templateId: templateB })).toMatchObject({
      status: 'suppressed',
      reason: expect.stringMatching(/complaint|withdrawn/),
    });
    expect(await apiA().call('messages.sendEmail', { profileId: complaintA, templateId: templateA })).toMatchObject({
      status: 'queued',
    });
  });

  it('analytics in brand A never sees brand B sends', async () => {
    await eventually(
      () => apiB().call('messages.list', { profileId: bounceB }),
      (r) => r.messages[0]?.status === 'sent',
    );
    const a = await apiA().call('analytics.query', {
      measures: ['email.sent'],
      from: FROM,
      to: to(),
      filters: { template: templateB },
    });
    expect(a.rows.flat()[0] ?? 0).toBe(0);

    const b = await apiB().call('analytics.query', {
      measures: ['email.sent'],
      from: FROM,
      to: to(),
      filters: { template: templateB },
    });
    // Brand B sent to two different people through this template; brand A sent to neither.
    expect(b.rows.flat()[0]).toBe(2);
  });

  it('exports one brand’s data and names its workspace', async () => {
    const a = await apiA().call('profiles.export', { profileId: sharedA });
    expect(a.workspaceId).toBe(wsA);
    expect(a.profile.id).toBe(sharedA);
    expect(a.profile.traits).toMatchObject({ brand: 'A' });
    expect(a.topicChoices).toContainEqual(expect.objectContaining({ topic: 'product_news', status: 'subscribed' }));
    expect(JSON.stringify(a)).not.toContain(sharedB);

    const b = await apiB().call('profiles.export', { profileId: sharedB });
    expect(b.workspaceId).toBe(wsB);
    expect(b.profile.id).toBe(sharedB);
    expect(b.profile.traits).toMatchObject({ brand: 'B' });
    expect(JSON.stringify(b)).not.toContain(sharedA);
  });

  it('erases a person in brand A while brand B keeps its profile and events', async () => {
    await apiA().call('profiles.erase', { profileId: sharedA, reason: 'DSR request for brand A only' });

    expect((await apiA().call('profiles.find', { type: 'email', value: sharedEmail })).profileId).toBeNull();
    expect((await apiB().call('profiles.find', { type: 'email', value: sharedEmail })).profileId).toBe(sharedB);

    const kept = await apiB().call('profiles.get', { profileId: sharedB });
    expect(kept.id).toBe(sharedB);
    expect(kept.traits).toMatchObject({ brand: 'B' });
    const events = await eventually(
      () => apiB().call('profiles.events', { profileId: sharedB }),
      (r) => r.events.length >= 2,
    );
    expect(events.events.length).toBeGreaterThanOrEqual(2);

    const suppressions = (
      await t.srv.db.admin.query<{ reason: string }>('SELECT reason FROM suppressions WHERE workspace_id = $1 ORDER BY reason', [wsB])
    ).rows.map((r) => r.reason);
    // B's own complaint from the earlier test, and no erasure from A's.
    expect(suppressions).toEqual(['complaint']);
  });
});

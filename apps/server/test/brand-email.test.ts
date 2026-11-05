import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #188: a brand sends from its own domain and links (confirm, unsubscribe, preferences, web
// version, List-Unsubscribe) on its own link host; a workspace without a domain keeps the
// installation fallback.

const MAIN_PORT = testPort(3455);
const PUBLIC_PORT = testPort(3456);
const SMTP_PORT = testPort(3457);
const FALLBACK = `http://localhost:${MAIN_PORT}`;

let t: Awaited<ReturnType<typeof startTestServer>>;
let ownerA: User;
let ownerB: User;
let wsA = '';
let wsB = '';
let wsC = '';
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

/** Decodes quoted-printable soft line breaks enough to search the message. */
const flat = (raw: string) => raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');

const template = (subject: string) => ({
  purpose: 'marketing_email',
  subject,
  mjml: `<mjml><mj-body><mj-section><mj-column>
    <mj-text>Hello {{ profile.firstName }}</mj-text>
    <mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text>
    <mj-text><a href="{{ preferences_url | raw }}">Preferences</a></mj-text>
    <mj-text><a href="{{ web_url | raw }}">View in browser</a></mj-text>
  </mj-column></mj-section></mj-body></mjml>`,
});

async function person(api: ReturnType<typeof t.api>, serverKey: string, userId: string, email: string) {
  const res = await fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}` },
    body: JSON.stringify({
      batch: [
        { type: 'identify', userId, traits: { email, firstName: userId }, timestamp: '2026-10-21T08:00:00Z' },
        {
          type: 'track',
          event: 'Segment Consent Preference Updated',
          userId,
          timestamp: '2026-10-21T08:00:01Z',
          context: { consent: { categoryPreferences: { marketing_email: true } } },
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
  const { profileId } = await eventually(
    () => api.call('profiles.find', { type: 'user_id', value: userId }),
    (r) => !!r.profileId,
  );
  await eventually(
    () => api.call('profiles.get', { profileId: profileId! }),
    (p) => p.consent.length > 0,
  );
  return profileId!;
}

async function brand(owner: User, ws: string, fromEmail: string, host: string | null, subject: string, recipient: string, userId: string) {
  const api = t.api(owner, ws);
  if (host) {
    const added = await api.call('workspace.domains.add', { host, isPrimary: true });
    await api.call('workspace.domains.verify', { id: added.domain.id });
  }
  const provider = await api.call('emailProviders.create', {
    name: `SMTP ${fromEmail}`,
    adapter: 'smtp',
    config: { host: '127.0.0.1', port: SMTP_PORT, requireTls: false, events: 'postmark' },
    secrets: { password: 'relay-password' },
    fromEmail,
    fromName: 'News',
    useFor: ['marketing'],
  });
  const created = await api.call('artifacts.create', { type: 'email_template', name: subject, content: template(subject) });
  await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'brand email test' });
  const { key } = await api.call('sources.create', { name: `Backend ${fromEmail}`, kind: 'server' });
  const profileId = await person(api, key, userId, recipient);
  return { api, provider, templateId: created.artifactId, profileId };
}

const sentTo = (address: string) =>
  eventually(
    async () => inbox.find((m) => m.to.includes(address)),
    (m) => !!m,
    15_000,
  );

beforeAll(async () => {
  await new Promise<void>((r) => smtp.listen(SMTP_PORT, '127.0.0.1', () => r()));
  t = await startTestServer('test_brand_email', MAIN_PORT, {
    PUBLIC_PORT: String(PUBLIC_PORT),
    PUBLIC_URL: `http://localhost:${MAIN_PORT}`,
    PUBLIC_LINKS_URL: FALLBACK,
  });
  ownerA = await t.signUp(`brand-email-a-${Date.now()}@example.com`);
  ownerB = await t.signUp(`brand-email-b-${Date.now()}@example.com`);
  wsA = await t.workspaceWith([[ownerA, 'owner']], 'none');
  wsB = await t.workspaceWith([[ownerB, 'owner']], 'none');
  wsC = await t.workspaceWith([[ownerA, 'owner']], 'none');
  t.srv.services.fetchDomainChallenge = async (url) => ({
    status: 200,
    body: decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''),
  });
}, 120_000);

afterAll(async () => {
  await t?.close();
  await new Promise<void>((r) => smtp.close(() => r()));
});

describe('per-brand e-mail links', () => {
  it('sends brand A and B links on their own hosts, with matching List-Unsubscribe', async () => {
    const a = await brand(ownerA, wsA, 'news@a.example', 'a.example', 'Brand A news', 'ada@example.com', 'ada');
    const b = await brand(ownerB, wsB, 'news@b.example', 'b.example', 'Brand B news', 'bo@example.com', 'bo');

    expect(await a.api.call('messages.sendEmail', { profileId: a.profileId, templateId: a.templateId })).toMatchObject({
      status: 'queued',
    });
    expect(await b.api.call('messages.sendEmail', { profileId: b.profileId, templateId: b.templateId })).toMatchObject({
      status: 'queued',
    });

    const mailA = flat((await sentTo('ada@example.com'))!.data);
    const mailB = flat((await sentTo('bo@example.com'))!.data);

    for (const [mail, host] of [
      [mailA, 'a.example'],
      [mailB, 'b.example'],
    ] as const) {
      expect(mail).toMatch(new RegExp(`^List-Unsubscribe:\\s*<https://${host.replace(/\./g, '\\.')}/u/`, 'm'));
      expect(mail).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
      expect(mail).toContain(`https://${host}/u/`);
      expect(mail).toContain(`https://${host}/u/p/`);
      expect(mail).toContain(`https://${host}/n/w/`);
    }
    expect(mailA).not.toContain('https://b.example');
    expect(mailB).not.toContain('https://a.example');
  });

  it('keeps a workspace without a domain on PUBLIC_LINKS_URL', async () => {
    const c = await brand(ownerA, wsC, 'news@c.example', null, 'Brand C news', 'cy@example.com', 'cy');
    expect(await c.api.call('messages.sendEmail', { profileId: c.profileId, templateId: c.templateId })).toMatchObject({
      status: 'queued',
    });
    const mail = flat((await sentTo('cy@example.com'))!.data);
    expect(mail).toMatch(new RegExp(`^List-Unsubscribe:\\s*<${FALLBACK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/u/`, 'm'));
    expect(mail).toContain(`${FALLBACK}/u/p/`);
    expect(mail).toContain(`${FALLBACK}/n/w/`);
  });

  it('shows the provider webhook URL on the brand host', async () => {
    const listed = await t.api(ownerA, wsA).call('emailProviders.list', {});
    expect(listed.providers.length).toBeGreaterThan(0);
    const created = await t.api(ownerA, wsA).call('emailProviders.refreshWebhookUrl', { id: listed.providers[0].id });
    expect(created.webhookUrl.startsWith('https://a.example/hooks/email/')).toBe(true);
  });
});

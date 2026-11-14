import http from 'node:http';
import { twilioSignature } from '@agentic-marketing/email';
import { logger } from '@agentic-marketing/telemetry';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #457: Twilio signs the exact callback URL it called. Public routing keeps the fallback and every
// verified domain reachable, so signature validation must use the request's own origin and prefix,
// not the workspace's current primary domain.

const PORT = testPort(3472);
const FALLBACK = `http://localhost:${PORT}`;
const AUTH_TOKEN = 'test-twilio-auth-token-123456';
const PHONE = '+4512345678';
const PRIMARY = 'sms-primary.example';
const SECONDARY = 'sms-secondary.example';
const PREFIXED = 'sms-prefixed.example';
const PREFIX = '/am';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let primaryId = '';
let secondaryId = '';
let webhookPath = '';

const post = (path: string, host: string, body: string, headers: Record<string, string>) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method: 'POST',
        headers: { host, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

/** POSTs a Twilio-signed callback to the public URL and the Host that serves it. */
async function callback(publicUrl: string, host: string, path: string, params: Record<string, string>) {
  const body = new URLSearchParams(params).toString();
  const signature = twilioSignature(AUTH_TOKEN, `${publicUrl}${path}`, params);
  return post(path, host, body, { 'x-twilio-signature': signature });
}

async function addVerified(host: string, pathPrefix?: string, isPrimary = false) {
  const added = await t.api(owner, ws).call('workspace.domains.add', { host, ...(pathPrefix ? { pathPrefix } : {}), isPrimary });
  t.srv.services.fetchDomainChallenge = async (url) => ({
    status: 200,
    body: decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''),
  });
  await t.api(owner, ws).call('workspace.domains.verify', { id: added.domain.id });
  return added.domain.id;
}

beforeAll(async () => {
  t = await startTestServer('test_sms_callbacks', PORT, {
    PUBLIC_URL: `http://localhost:${PORT}`,
    PUBLIC_LINKS_URL: FALLBACK,
  });
  owner = await t.signUp(`sms-callbacks-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  primaryId = await addVerified(PRIMARY, undefined, true);
  secondaryId = await addVerified(SECONDARY);
  await addVerified(PREFIXED, PREFIX);
  const sms = await t.api(owner, ws).call('smsProviders.create', {
    name: 'Twilio',
    adapter: 'twilio',
    config: { accountSid: `AC${'a'.repeat(32)}` },
    secrets: { authToken: AUTH_TOKEN },
    sender: 'Signal',
    useFor: ['transactional', 'marketing'],
  });
  webhookPath = sms.webhookPath;
}, 120_000);

afterAll(() => t?.close());

describe('Twilio callbacks on brand hosts', () => {
  const hosts = () => [
    { name: 'fallback', publicUrl: FALLBACK, host: `localhost:${PORT}`, path: `${webhookPath}/inbound` },
    { name: 'primary', publicUrl: `https://${PRIMARY}`, host: PRIMARY, path: `${webhookPath}/inbound` },
    { name: 'secondary', publicUrl: `https://${SECONDARY}`, host: SECONDARY, path: `${webhookPath}/inbound` },
    { name: 'prefixed', publicUrl: `https://${PREFIXED}`, host: PREFIXED, path: `${PREFIX}${webhookPath}/inbound` },
  ];

  it('accepts a signed STOP and status callback on the fallback, primary, secondary and prefixed hosts', async () => {
    for (const target of hosts()) {
      const stop = await callback(target.publicUrl, target.host, target.path, { From: PHONE, Body: 'STOP' });
      expect(stop.status, target.name).toBe(200);
      const status = await callback(target.publicUrl, target.host, `${target.path.replace(/\/inbound$/, '/status')}`, {
        MessageSid: `SM${'b'.repeat(32)}`,
        MessageStatus: 'queued',
      });
      expect(status.status, `${target.name} status`).toBe(200);
    }
  });

  it('keeps every previously valid callback URL working after the primary domain changes', async () => {
    await t.api(owner, ws).call('workspace.domains.update', { id: primaryId, isPrimary: false });
    await t.api(owner, ws).call('workspace.domains.update', { id: secondaryId, isPrimary: true });
    expect(await t.srv.domains.linksUrlFor(ws)).toBe(`https://${SECONDARY}`);

    for (const target of hosts()) {
      const stop = await callback(target.publicUrl, target.host, target.path, { From: PHONE, Body: 'STOP' });
      expect(stop.status, target.name).toBe(200);
    }
  });
});

// #636: realistic replies carry punctuation, mixed case or a polite word around the keyword.
// Twilio passes Body verbatim, so matching the first whitespace token alone never opted anyone out.
const REPLY_VARIANTS = [
  'STOP.',
  'STOP!',
  'stop,',
  'UNSUBSCRIBE.',
  'Please STOP',
  'stop please',
  '  Stop  ',
  'ＳＴＯＰ',
  'stop start',
  'STOP,please',
  'Please STOP/UNSUBSCRIBE',
  'Please stop—sending these messages',
  'Please cancel these marketing messages right now',
  'Kan ni avsluta dessa utskick till mig tack',
];
const CONVERSATIONAL = REPLY_VARIANTS.length;
const phoneOf = (i: number) => `+45${String(90_000_000 + i)}`;

describe('inbound keyword normalisation (#636)', () => {
  let profileIds: string[] = [];

  const inbound = (phone: string, body: string) =>
    callback(FALLBACK, `localhost:${PORT}`, `${webhookPath}/inbound`, { From: phone, Body: body });
  const suppressionCount = async () =>
    (
      await t.srv.db.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM suppressions WHERE workspace_id = $1 AND channel = 'sms' AND reason = 'stop'`,
        [ws],
      )
    ).rows[0].n;
  const consentHistory = async (profileId: string) => (await t.api(owner, ws).call('consent.history', { profileId })).records;

  beforeAll(async () => {
    const api = t.api(owner, ws);
    const { key } = await api.call('sources.create', { name: 'SMS keywords', kind: 'server' });
    const people = [...REPLY_VARIANTS, 'conversational'];
    const res = await fetch(`${t.base}/v1/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
      body: JSON.stringify({
        batch: people.flatMap((_, i) => [
          { type: 'identify', userId: `sms-keyword-${i}`, traits: { phone: phoneOf(i), email: `sms-keyword-${i}@example.com` } },
          {
            type: 'track',
            userId: `sms-keyword-${i}`,
            event: 'Segment Consent Preference Updated',
            context: { consent: { categoryPreferences: { marketing_sms: true } } },
          },
        ]),
      }),
    });
    expect(res.status).toBe(200);
    profileIds = await Promise.all(
      people.map(async (_, i) => {
        const found = await eventually(
          () => api.call('profiles.find', { type: 'user_id', value: `sms-keyword-${i}` }),
          (r) => !!r.profileId,
        );
        await eventually(
          () => api.call('profiles.get', { profileId: found.profileId! }),
          (p) => p.consent.length >= 1,
        );
        return found.profileId!;
      }),
    );
  }, 60_000);

  it.each(REPLY_VARIANTS.map((body, i) => [body, i] as const))('withdraws consent and suppresses the number for %j', async (body, i) => {
    const before = await suppressionCount();
    expect((await inbound(phoneOf(i), body)).status).toBe(200);
    expect(await suppressionCount()).toBe(before + 1);
    expect((await consentHistory(profileIds[i])).find((r) => r.purpose === 'marketing_sms' && r.status === 'withdrawn')).toMatchObject({
      channel: 'sms',
      source: 'unsubscribe',
    });
  });

  it('withdraws consent for a conversational sentence with an opt-out word anywhere', async () => {
    // Accepted behaviour: a false opt-out is recoverable, a missed one is not.
    const before = await suppressionCount();
    expect((await inbound(phoneOf(CONVERSATIONAL), "Don't stop the music, it's great")).status).toBe(200);
    expect(await suppressionCount()).toBe(before + 1);
    expect(
      (await consentHistory(profileIds[CONVERSATIONAL])).find((r) => r.purpose === 'marketing_sms' && r.status === 'withdrawn'),
    ).toMatchObject({
      channel: 'sms',
      source: 'unsubscribe',
    });
  });
});

// #664, #750: START may lift only the SMS stop row for that number, never a bounce or complaint
// suppression. A hard bounce that arrives while the stop row already holds the primary key must
// escalate that row instead of being dropped: otherwise START unsuppresses a number that bounced.
describe('START lifts only the SMS stop suppression (#664, #750)', () => {
  const rowsFor = async (hash: string) =>
    (
      await t.srv.db.admin.query<{ reason: string }>(
        `SELECT reason FROM suppressions WHERE workspace_id = $1 AND channel = 'sms' AND value_hash = $2 ORDER BY reason`,
        [ws, hash],
      )
    ).rows.map((r) => r.reason);

  const stopRow = async (since: Date) =>
    (
      await t.srv.db.admin.query<{ value_hash: string }>(
        `SELECT value_hash FROM suppressions WHERE workspace_id = $1 AND channel = 'sms' AND reason = 'stop' AND at >= $2
          ORDER BY at DESC`,
        [ws, since],
      )
    ).rows;

  it('lifts a stop that never bounced', async () => {
    const phone = '+4512345680';
    const inbound = (body: string) => callback(FALLBACK, `localhost:${PORT}`, `${webhookPath}/inbound`, { From: phone, Body: body });
    const since = new Date();

    expect((await inbound('STOP')).status).toBe(200);
    const stops = await stopRow(since);
    expect(stops).toHaveLength(1);
    const hash = stops[0]!.value_hash;
    expect(await rowsFor(hash)).toEqual(['stop']);

    expect((await inbound('START')).status).toBe(200);
    expect(await rowsFor(hash)).toEqual([]);
  });

  it('escalates a stop to hard_bounce when the in-flight message bounces, and START keeps it', async () => {
    const phone = '+4512345679';
    const inbound = (body: string) => callback(FALLBACK, `localhost:${PORT}`, `${webhookPath}/inbound`, { From: phone, Body: body });
    const since = new Date();
    const logged = vi.spyOn(logger, 'info');

    expect((await inbound('STOP')).status).toBe(200);
    const stops = await stopRow(since);
    expect(stops).toHaveLength(1);
    const hash = stops[0]!.value_hash;

    // The STOP was on day 1; move the row's timestamp back so the escalation has to move it to
    // the delivery's own time, not keep the STOP's (#910).
    const dayOne = new Date('2026-01-01T09:00:00.000Z');
    await t.srv.db.admin.query(`UPDATE suppressions SET at = $3 WHERE workspace_id = $1 AND value_hash = $2`, [ws, hash, dayOne]);

    // The message was already in flight when the STOP arrived, then the carrier reports it
    // undelivered with a permanent error (Twilio 30003: unreachable handset) — a hard bounce.
    const sid = `SM${'c'.repeat(32)}`;
    await t.srv.db.admin.query(
      `INSERT INTO messages (workspace_id, id, idempotency_key, channel, purpose, status, provider_message_id, recipient_hash)
       VALUES ($1, $2, $3, 'sms', 'marketing_sms', 'sent', $4, $5)`,
      [ws, `msg-${sid}`, `idem-${sid}`, sid, hash],
    );
    const bounce = () =>
      callback(FALLBACK, `localhost:${PORT}`, `${webhookPath}/status`, {
        MessageSid: sid,
        MessageStatus: 'undelivered',
        ErrorCode: '30003',
      });
    const bouncedAt = new Date();
    expect((await bounce()).status).toBe(200);
    expect(await rowsFor(hash)).toEqual(['hard_bounce']);
    const escalated = (
      await t.srv.db.admin.query<{ at: Date }>(
        `SELECT at FROM suppressions WHERE workspace_id = $1 AND channel = 'sms' AND value_hash = $2`,
        [ws, hash],
      )
    ).rows[0]!.at;
    expect(escalated.getTime()).toBeGreaterThan(dayOne.getTime());
    expect(escalated.getTime()).toBeGreaterThanOrEqual(bouncedAt.getTime() - 1000);
    // The transition is logged once, like STOP and START, without the raw number.
    const escalationLogs = logged.mock.calls.filter(([, message]) =>
      String(message).includes('suppression escalated from stop to hard_bounce'),
    );
    expect(escalationLogs).toHaveLength(1);
    expect(escalationLogs[0]![0]).toMatchObject({ workspace: ws, channel: 'sms', previous: 'stop', reason: 'hard_bounce' });
    expect(JSON.stringify(escalationLogs)).not.toContain(phone);

    // A second bounce changes neither the reason nor the timestamp: only a stop row may move.
    expect((await bounce()).status).toBe(200);
    const afterSecond = (
      await t.srv.db.admin.query<{ reason: string; at: Date }>(
        `SELECT reason, at FROM suppressions WHERE workspace_id = $1 AND channel = 'sms' AND value_hash = $2`,
        [ws, hash],
      )
    ).rows[0]!;
    expect(afterSecond.reason).toBe('hard_bounce');
    expect(afterSecond.at.getTime()).toBe(escalated.getTime());
    expect(logged.mock.calls.filter(([, message]) => String(message).includes('suppression escalated')).length).toBe(1);

    // START lifts the carrier block, never the delivery fact.
    expect((await inbound('START')).status).toBe(200);
    expect(await rowsFor(hash)).toEqual(['hard_bounce']);
    logged.mockRestore();
  });
});

import { newId, sha256 } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { DeliveryEventType } from '@agentic-marketing/email';
import { emailRoutes, linkSigner, smsAdapters, smsRoutes } from '@agentic-marketing/email';
import type { EventStore } from '@agentic-marketing/events';
import { personCrypto } from '@agentic-marketing/profiles';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import type { AdapterDeps } from '../src/adapters';

// #1154: an inbound SMS STOP and an inbound complaint/unsubscribe change consent, so the segment
// read-through must be refreshed after commit, exactly like the e-mail webhook. Click links accept
// the uppercase schemes the signer already accepts.

const MASTER_KEY = Buffer.alloc(32, 62).toString('base64');
const PHONE = '+15550007777';

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;
let profileId: string;
let providerId: string;
let links: ReturnType<typeof linkSigner>;
let events: { inserted: unknown[] };
let consentCalls: { workspaceId: string; profileIds: string[]; cause: string }[];

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('email_sms_consent');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
  links = linkSigner('sms-consent-secret');
  events = { inserted: [] };
  consentCalls = [];
  profileId = newId('prf');
  providerId = newId('smp');
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id: profileId, traits: { timezone: 'UTC' } });
    await tx.insert(schema.identifiers).values({
      workspaceId: ws,
      profileId,
      type: 'phone',
      value: await personCrypto(tx, ws, kp).matchHash('phone', PHONE),
    });
    await tx.insert(schema.smsProviders).values({
      workspaceId: ws,
      id: providerId,
      name: 'Log SMS',
      adapter: 'log',
      config: {},
      sender: 'Signal',
      useFor: ['marketing'],
      webhookTokenHash: sha256(`sms-consent:${providerId}`),
    });
  });
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const emailDeps = () => ({
  publicUrl: 'https://links.example.com',
  links,
  adapterDeps: {} as AdapterDeps,
  trackClicks: true,
});

function smsApp() {
  return smsRoutes({
    db: d.db,
    kp,
    email: emailDeps(),
    consentChanged: async (workspaceId, profileIds, cause) => {
      consentCalls.push({ workspaceId, profileIds, cause });
    },
  });
}

async function seedSentSms(providerMessageId: string) {
  const id = newId('msg');
  await d.db.admin.query(
    `INSERT INTO messages (workspace_id, id, idempotency_key, channel, purpose, profile_id, status, provider_id, provider_message_id)
     VALUES ($1, $2, $3, 'sms', 'marketing', $4, 'sent', $5, $6)`,
    [ws, id, `idem-${id}`, profileId, providerId, providerMessageId],
  );
  return id;
}

/** Replace the log adapter's status parser for one event type; restore it afterwards. */
function statusParser(type: DeliveryEventType, providerMessageId: string) {
  const adapter = smsAdapters.log as unknown as { create: (...args: unknown[]) => Record<string, unknown> };
  const original = adapter.create;
  adapter.create = (...args: unknown[]) => {
    const transport = original(...args) as Record<string, unknown>;
    return {
      ...transport,
      parseStatus: () => [{ providerMessageId, eventId: `evt-${type}`, type, at: new Date().toISOString() }],
    };
  };
  return () => {
    adapter.create = original;
  };
}

describe.skipIf(!hasTestDatabase())('SMS consent refresh (#1154)', () => {
  it('calls consentChanged after commit for an inbound STOP', async () => {
    consentCalls = [];
    const app = smsApp();
    const token = links.sign({ w: ws, sms: providerId });
    const response = await app.request(`https://links.example.com/hooks/sms/${token}/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: PHONE, Body: 'STOP' }).toString(),
    });
    expect(response.status).toBe(200);
    expect(consentCalls).toHaveLength(1);
    expect(consentCalls[0]!.workspaceId).toBe(ws);
    expect(consentCalls[0]!.profileIds).toContain(profileId);
    expect(consentCalls[0]!.cause).toMatch(/^sms-stop:/);
  });

  it('calls consentChanged for an unsubscribed status callback', async () => {
    consentCalls = [];
    const messageId = await seedSentSms('sms-status-1');
    const restore = statusParser('unsubscribed', 'sms-status-1');
    try {
      const app = smsApp();
      const token = links.sign({ w: ws, sms: providerId });
      const response = await app.request(`https://links.example.com/hooks/sms/${token}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ MessageSid: 'sms-status-1', MessageStatus: 'unsubscribed' }).toString(),
      });
      expect(response.status).toBe(200);
      expect(consentCalls).toHaveLength(1);
      expect(consentCalls[0]!.profileIds).toEqual([profileId]);
      expect(consentCalls[0]!.cause).toBe(`unsubscribe:${messageId}`);
    } finally {
      restore();
    }
  });

  it('calls consentChanged for a complained status callback', async () => {
    consentCalls = [];
    await seedSentSms('sms-status-2');
    const restore = statusParser('complained', 'sms-status-2');
    try {
      const app = smsApp();
      const token = links.sign({ w: ws, sms: providerId });
      const response = await app.request(`https://links.example.com/hooks/sms/${token}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ MessageSid: 'sms-status-2', MessageStatus: 'complained' }).toString(),
      });
      expect(response.status).toBe(200);
      expect(consentCalls.map((call) => call.profileIds)).toEqual([[profileId]]);
    } finally {
      restore();
    }
  });

  it('does not refresh consent for a START, which grants nothing', async () => {
    consentCalls = [];
    const app = smsApp();
    const token = links.sign({ w: ws, sms: providerId });
    const response = await app.request(`https://links.example.com/hooks/sms/${token}/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: PHONE, Body: 'START' }).toString(),
    });
    expect(response.status).toBe(200);
    expect(consentCalls).toEqual([]);
  });
});

describe.skipIf(!hasTestDatabase())('tracked click links accept an uppercase scheme (#1154)', () => {
  it('redirects to an HTTPS:// URL instead of answering 404', async () => {
    const app = emailRoutes({ db: d.db, kp, events: events as unknown as EventStore, email: emailDeps() });
    const token = links.sign({ w: ws, m: newId('msg'), url: 'HTTPS://example.com/landing' });
    const response = await app.request(`https://links.example.com/c/${token}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('HTTPS://example.com/landing');
  });
});

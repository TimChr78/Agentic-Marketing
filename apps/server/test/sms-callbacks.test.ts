import http from 'node:http';
import { twilioSignature } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

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

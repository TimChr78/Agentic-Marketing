import http from 'node:http';
import { newId } from '@agentic-marketing/core';
import { linkSigner } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #185: an installation without a verified brand domain keeps serving public paths on any Host,
// so upgrading does not break a proxy that rewrites Host or a LAN address used for testing.

const PORT = testPort(3471);
const SECRET = 'test-secret-test-secret-test-secret-123';
const signer = linkSigner(SECRET);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let domainId = '';

const get = (path: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });

beforeAll(async () => {
  t = await startTestServer('test_brand_routing_upgrade', PORT, {
    PUBLIC_URL: `http://localhost:${PORT}`,
    PUBLIC_LINKS_URL: 'https://links.example',
  });
  owner = await t.signUp(`brand-upgrade-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
});
afterAll(() => t?.close());

describe('public routes before any brand domain is verified', () => {
  it('serve on a Host other than PUBLIC_LINKS_URL', async () => {
    const token = signer.sign({ w: ws, p: newId('prf'), u: 'marketing_email', m: newId('msg') });
    expect(await get(`/u/${token}`, 'proxy-rewritten.internal')).toBe(200);
    expect(await get(`/u/${token}`, '192.168.1.20:8080')).toBe(200);
  });

  it('start checking the Host once a domain is verified', async () => {
    t.srv.services.fetchDomainChallenge = async (url) => ({
      status: 200,
      body: decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''),
    });
    const added = await t.api(owner, ws).call('workspace.domains.add', { host: 'brand.example', isPrimary: true });
    domainId = added.domain.id;
    await t.api(owner, ws).call('workspace.domains.verify', { id: added.domain.id });
    const token = signer.sign({ w: ws, p: newId('prf'), u: 'marketing_email', m: newId('msg') });
    expect(await get(`/u/${token}`, 'brand.example')).toBe(200);
    expect(await get(`/u/${token}`, 'proxy-rewritten.internal')).toBe(404);
  });

  it('keeps checking the Host after the last verified domain is removed (#463)', async () => {
    await t.api(owner, ws).call('workspace.domains.remove', { id: domainId });
    const token = signer.sign({ w: ws, p: newId('prf'), u: 'marketing_email', m: newId('msg') });
    expect(await get(`/u/${token}`, 'proxy-rewritten.internal')).toBe(404);
    expect(await get(`/u/${token}`, '192.168.1.20:8080')).toBe(404);
    // The installation fallback host keeps serving.
    expect(await get(`/u/${token}`, 'links.example')).toBe(200);
  });
});

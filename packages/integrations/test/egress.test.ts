import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { checkUrl, isBlockedAddress, safeRequest } from '../src/egress';
import { newWebhookSecret, signWebhook, verifyHmac, verifyWebhook, webhookHeaders } from '../src/signing';

const none = { allowedHosts: [] };

describe('egress guard', () => {
  it('blocks private, loopback, link-local and metadata addresses unless allowed', () => {
    for (const a of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '192.168.1.5',
      '172.20.0.1',
      '100.64.0.1',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ])
      expect(isBlockedAddress(a, none), a).toBe(true);
    expect(isBlockedAddress('93.184.216.34', none)).toBe(false);
    expect(isBlockedAddress('192.168.1.5', { allowedHosts: ['192.168.1.0/24'] })).toBe(false);
    expect(isBlockedAddress('192.168.2.5', { allowedHosts: ['192.168.1.0/24'] })).toBe(true);
  });

  it('checks URLs before any request', () => {
    expect(checkUrl('ftp://example.com', none)).toBe('only http and https URLs are allowed');
    expect(checkUrl('https://user:pw@example.com', none)).toContain('credentials');
    expect(checkUrl('http://localhost:5678/webhook', none)).toBe('localhost is an internal address');
    expect(checkUrl('http://localhost:5678/webhook', { allowedHosts: ['localhost'] })).toBeNull();
    expect(checkUrl('http://[::1]/x', none)).toContain('private address');
    expect(checkUrl('https://n8n.example.com/webhook/abc', none)).toBeNull();
  });

  it('refuses names that resolve to private addresses at connect time, and never follows redirects', async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/' });
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    await expect(safeRequest(`http://localtest.me:${port}/`, {}, none)).rejects.toThrow(/private address|ENOTFOUND|EAI_AGAIN/);
    const res = await safeRequest(`http://127.0.0.1:${port}/`, {}, { allowedHosts: ['127.0.0.1'] });
    expect(res.status).toBe(302);
    srv.close();
  });
});

describe('signing', () => {
  it('signs and verifies Standard Webhooks', () => {
    const secret = newWebhookSecret();
    const now = 1_790_000_000_000;
    const h = webhookHeaders(secret, 'msg_1', '{"a":1}', now);
    expect(h['webhook-signature']).toBe(signWebhook(secret, 'msg_1', 1_790_000_000, '{"a":1}'));
    expect(verifyWebhook(secret, h, '{"a":1}', now)).toBe(true);
    expect(verifyWebhook(secret, h, '{"a":2}', now)).toBe(false);
    expect(verifyWebhook(secret, h, '{"a":1}', now + 600_000)).toBe(false);
    expect(verifyWebhook(newWebhookSecret(), h, '{"a":1}', now)).toBe(false);
  });

  it('verifies HMAC signatures in hex and base64, with a prefix', () => {
    const sig = createHmac('sha256', 's').update('body').digest('hex');
    expect(verifyHmac('s', 'body', `sha256=${sig}`, 'hex', 'sha256=')).toBe(true);
    expect(verifyHmac('s', 'body', sig, 'hex', 'sha256=')).toBe(false);
    expect(verifyHmac('s', 'body', createHmac('sha256', 's').update('body').digest('base64'), 'base64')).toBe(true);
    expect(verifyHmac('s', 'body', undefined, 'base64')).toBe(false);
  });
});

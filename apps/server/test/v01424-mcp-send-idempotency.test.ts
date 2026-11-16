import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #949: four write tools declare their own `idempotencyKey` input (the three sends and a bulk
// enrollment), so the MCP surface never took the key out and never applied the strict key rule to
// it: `"order 1234"` reached the advisory-lock key while another write tool refused it. The MCP
// argument is now validated with the same rule as every other tool's, and REST keeps the broader
// 1–200 character bound its input-level keys always had.

const PORT = testPort(3505);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let template = '';
let profileId = '';
let mcp: Client;

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

const api = () => t.api(owner, ws);

const post = async (command: string, body: unknown) => {
  const res = await fetch(`${t.base}/v1/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: t.base, 'x-workspace-id': ws },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { error?: string; message?: string; status?: string; duplicate?: boolean } };
};

const sendArgs = (idempotencyKey: string) => ({ profileId, templateId: template, idempotencyKey });

beforeAll(async () => {
  t = await startTestServer('test_v01424_mcp_send_keys', PORT);
  owner = await t.signUp(`owner-mcp-send-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  await api().call('emailProviders.create', {
    name: 'Relay',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });
  const key = (await api().call('sources.create', { name: 'Backend', kind: 'server' })).key;
  await fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch: [{ type: 'identify', userId: 'mcp-send-1', traits: { email: 'mcp-send@example.com' } }] }),
  });
  profileId = (
    await eventually(
      () => api().call('profiles.find', { type: 'user_id', value: 'mcp-send-1' }),
      (r) => !!r.profileId,
    )
  ).profileId!;
  await api().call('consent.record', { profileId, purpose: 'marketing_email', status: 'granted' });
  const created = await api().call('artifacts.create', {
    type: 'email_template',
    name: 'mcp send keys',
    content: { purpose: 'marketing_email', subject: 'Your order', mjml: mjml('Hello') },
  });
  await api().call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'v01424 mcp send keys' });
  template = created.artifactId;
  const token = await api().call('apiTokens.create', { name: 'send client', scopes: ['messages:send', 'artifacts:read'] });
  mcp = new Client({ name: 'mcp-send-keys-test', version: '1' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token.token}` } },
    }),
  );
}, 120_000);

afterAll(async () => {
  await mcp?.close().catch(() => {});
  await t?.close();
});

describe('MCP validates the idempotencyKey a send tool declares (#949)', () => {
  it('refuses a key with a space on messages.sendEmail', async () => {
    const refused = await mcp.callTool({ name: 'messages.sendEmail', arguments: sendArgs('order 1234') });
    expect(refused.isError).toBe(true);
    const text = (refused.content as { type: 'text'; text: string }[])[0]!.text;
    expect(text).toContain('1 to 200 printable characters');
    expect(JSON.parse(text).error).toBe('invalid_input');
  });

  it('refuses a key outside the rule on journeys.enrollSegment', async () => {
    const refused = await mcp.callTool({
      name: 'journeys.enrollSegment',
      arguments: {
        artifactId: `jrn_${'0'.repeat(32)}`,
        segmentId: `seg_${'0'.repeat(32)}`,
        reason: 'mcp key rule',
        idempotencyKey: 'job 1',
      },
    });
    expect(refused.isError).toBe(true);
    expect((refused.content as { type: 'text'; text: string }[])[0]!.text).toContain('1 to 200 printable characters');
  });

  it('accepts a valid key and replays it', async () => {
    const first = await mcp.callTool({ name: 'messages.sendEmail', arguments: sendArgs('order-1234') });
    expect(first.isError).toBeFalsy();
    const a = first.structuredContent as { messageId: string; status: string; duplicate: boolean };
    expect(a.duplicate).toBe(false);
    expect(['queued', 'sent', 'sending', 'suppressed', 'failed']).toContain(a.status);
    const again = await mcp.callTool({ name: 'messages.sendEmail', arguments: sendArgs('order-1234') });
    const b = again.structuredContent as { messageId: string; duplicate: boolean };
    expect(b.duplicate).toBe(true);
    expect(b.messageId).toBe(a.messageId);
  });

  it('keeps REST’s input-level keys as they were', async () => {
    const spaced = await post('messages.sendEmail', sendArgs('order 5555'));
    expect(spaced.status).toBe(200);
    expect(spaced.body.status).toBeDefined();
    // The same key replays on REST too, so the value was stored rather than rewritten.
    const replay = await post('messages.sendEmail', sendArgs('order 5555'));
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
  });
});

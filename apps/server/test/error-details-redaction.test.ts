import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #996: the executor redacts an AppError's message before REST or MCP returns it, but its `details`
// used to travel raw. `recipes.preview` reports an unknown parameter by name, so a caller (or a
// model) that puts a credential into one saw it echoed back in `details.problems` even though the
// message was redacted. The fix sits where errors leave the executor, so every surface gets it.

const SECRET = 'review_dummy_secret';
const PARAM = `password=${SECRET}`;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws: string;
let mcp: Client;

beforeAll(async () => {
  t = await startTestServer('test_error_details_redaction', testPort(3496));
  owner = await t.signUp(`error-details-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const token = await t.api(owner, ws).call('apiTokens.create', { name: 'details reader', scopes: ['artifacts:read'] });
  mcp = new Client({ name: 'error-details-redaction-test', version: '1' });
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

const preview = { recipeId: 'weekly-newsletter', params: { [PARAM]: 'x' } };

describe('a credential in a parameter name never comes back from an error (#996)', () => {
  it('redacts it in the REST error body, message and details alike', async () => {
    const res = await fetch(`${t.base}/v1/recipes.preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: t.base, 'x-workspace-id': ws },
      body: JSON.stringify(preview),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body.error).toBe('invalid_input');
    expect(body.message).toContain('Unknown parameter');
    // The structured field survives so a client can still act on it.
    expect(body.details.problems.join(' ')).toContain('Unknown parameter');
    expect(body.details.problems.join(' ')).toContain('[redacted]');
  });

  it('redacts it in the MCP tool error the client receives', async () => {
    const result = await mcp.callTool({ name: 'recipes.preview', arguments: preview });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const body = JSON.parse(text);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(body.message).toContain('Unknown parameter');
    expect(body.details.problems.join(' ')).toContain('[redacted]');
  });
});

// A schema error names the offending key. Zod's tree keeps the caller's key as an object key, so
// the key itself must be redacted too, not only string values (#996 review).
const keyedPreview = { recipeId: 'weekly-newsletter', params: { [PARAM]: {} } };

describe('a credential used as an object key never comes back from an error (#996)', () => {
  it('redacts the key in the REST validation details', async () => {
    const res = await fetch(`${t.base}/v1/recipes.preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: t.base, 'x-workspace-id': ws },
      body: JSON.stringify(keyedPreview),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body.details)).toContain('password=[redacted]');
  });

  it('redacts the key in the MCP tool error', async () => {
    const result = await mcp.callTool({ name: 'recipes.preview', arguments: keyedPreview });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).toContain('password=[redacted]');
  });

  it('redacts a connector secret header name in the REST error', async () => {
    // The HTTP connector's secrets schema is a record of header name to string; an integer value
    // makes Zod report the caller's header name as an object key.
    const res = await fetch(`${t.base}/v1/connections.create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: t.base, 'x-workspace-id': ws },
      body: JSON.stringify({
        connector: 'http',
        name: 'Leaky header',
        settings: { baseUrl: 'https://api.example.com' },
        secrets: { headers: { [PARAM]: 1 } },
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_input');
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body.details)).toContain('password=[redacted]');
  });
});

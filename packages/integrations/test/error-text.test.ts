import { AppError } from '@agentic-marketing/core';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { describe, expect, it } from 'vitest';
import { runAction, runConnectionAction } from '../src/connections';
import { shopifyGraphql } from '../src/connectors/shopify';

// #885: a provider's error body, or a secret provider's failure, used to be wrapped into an
// AppError whose message reached the caller, the audit log and the agent ledger. A provider's own
// code and message are expected and stay; everything else propagates for the executor to sanitise.
const SECRET = 'driver failure: password=probe-secret';

describe('connections.runAction (#885)', () => {
  const connection = (over: Record<string, unknown>) => ({
    id: `con_${'0'.repeat(32)}`,
    workspaceId: 'ws_test',
    connector: 'http',
    name: 'Probe',
    settings: {},
    secrets: null,
    secretsKeyId: null,
    oauthStatus: null,
    enabled: true,
    ...over,
  });

  const context = (row: unknown, keyProvider?: KeyProvider) => {
    const chain = {
      from: () => chain,
      where: async () => [row],
    };
    const tx = {
      select: () => chain,
    };
    return {
      tx,
      principal: { workspaceId: 'ws_test', userId: 'usr_probe', type: 'user', permissions: new Set<string>() },
      services: { keyProvider, egress: { allowedHosts: [] } },
    } as never;
  };

  it('lets a secret provider failure propagate instead of quoting its text', async () => {
    const keyProvider = {
      id: 'kek',
      wrap: async () => Buffer.from(''),
      unwrap: async () => {
        throw new Error(SECRET);
      },
    } as unknown as KeyProvider;
    const handler = runConnectionAction.handler;
    const ctx = context(connection({ connector: 'shopify_app', secrets: Buffer.from('blob'), secretsKeyId: 'kek' }), keyProvider);
    const err = (await handler({ id: `con_${'0'.repeat(32)}`, action: 'registerWebhooks', input: {} }, ctx).catch(
      (e: unknown) => e,
    )) as Error;
    // Unexpected: it stays an ordinary Error, so the executor answers and audits it as the fixed
    // internal failure rather than echoing "password=probe-secret".
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
  });

  it('keeps a connector’s own AppError, which is written for the caller', async () => {
    const handler = runConnectionAction.handler;
    const ctx = context(connection({ connector: 'no_such_connector' }));
    const err = (await handler({ id: `con_${'0'.repeat(32)}`, action: 'request', input: {} }, ctx).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('Unknown connector');
  });

  it('keeps a not-connected OAuth connection, which the person can fix', async () => {
    const err = (await runAction(
      connection({
        connector: 'oauth_http',
        settings: {
          baseUrl: 'https://api.example.com',
          authorizeUrl: 'https://provider.example.com/authorize',
          tokenUrl: 'https://provider.example.com/token',
          scopes: [],
        },
        oauthStatus: null,
      }) as never,
      { clientId: 'client', clientSecret: 'secret' },
      'request',
      { path: '' },
      { allowedHosts: [] },
    ).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('not connected');
  });

  it('keeps an egress refusal, which is the caller’s diagnostic', async () => {
    const handler = runConnectionAction.handler;
    const ctx = context(connection({ settings: { baseUrl: 'http://127.0.0.1:1/' } }));
    const err = (await handler({ id: `con_${'0'.repeat(32)}`, action: 'request', input: {} }, ctx).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toMatch(/not allowed|private address/);
  });
});

describe('shopifyGraphql error bodies (#885)', () => {
  const settings = { shop: 'probe.myshopify.com', apiVersion: '2026-01', syncEmailConsent: false } as never;
  const request = (status: number, body: string) => async () => ({ status, body, headers: {} });

  it('keeps Shopify’s code and message, not its body', async () => {
    const err = (await shopifyGraphql(
      settings,
      'shpat_token',
      request(
        400,
        JSON.stringify({
          error: { code: 'THROTTLED', message: 'access_token=probe-secret is throttled' },
          echo: 'access_token=probe-secret',
        }),
      ),
      'query { shop { id } }',
    ).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('Shopify answered 400');
    expect(err.message).toContain('THROTTLED');
    expect(err.message).not.toContain('probe-secret');
  });

  it('redacts a GraphQL user error that echoes a credential', async () => {
    const err = (await shopifyGraphql(
      settings,
      'shpat_token',
      request(200, JSON.stringify({ errors: [{ message: 'access_token=probe-secret is invalid' }] })),
      'query { shop { id } }',
    ).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('Shopify');
    expect(err.message).not.toContain('probe-secret');
  });

  it('never quotes a body that is not JSON', async () => {
    const err = (await shopifyGraphql(settings, 'shpat_token', request(502, 'access_token=probe-secret'), 'query { shop { id } }').catch(
      (e: unknown) => e,
    )) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toBe('Shopify answered 502.');
  });
});

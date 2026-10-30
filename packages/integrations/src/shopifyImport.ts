import { DEFAULT_PURPOSES, publishedSingleton } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { acceptItems } from '@agentic-marketing/ingest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { connectionSecrets, connectorOf } from './connections';
import { CUSTOMERS_QUERY, graphqlCustomerItems, shopifyAppConnector, shopifyGraphql } from './connectors/shopify';
import { safeRequest } from './egress';
import { accessTokenOf } from './oauth';

// Importing a shop's existing customers (Phase 11): one page of 250 per call, through the same
// policy and bus as webhooks, so they become people like any identify (and, with syncEmailConsent,
// with their Shopify e-mail marketing consent). Call again with `cursor` until `done`.

export const importShopifyCustomers = defineCommand({
  name: 'shopify.importCustomers',
  title: 'Import Shopify customers',
  description:
    "Imports one page (up to 250) of a Shopify app connection's customers as people: name, e-mail, phone, order count, and, when the connection's syncEmailConsent is on, their e-mail marketing consent with Shopify as the proof. Repeat with the returned cursor until done. Importing again updates people; it does not duplicate them.",
  input: z.object({
    connection: z.string().regex(/^con_[0-9a-f]{32}$/),
    cursor: z.string().max(500).optional(),
  }),
  output: z.object({ imported: z.number().int(), consentRecords: z.number().int(), cursor: z.string().nullable(), done: z.boolean() }),
  permission: 'workspace:admin',
  effect: 'write',
  actionClass: 'data.write',
  target: (i) => i.connection,
  handler: async (input, ctx) => {
    const [row] = await ctx.tx.select().from(schema.connections).where(eq(schema.connections.id, input.connection));
    if (!row?.enabled) throw new AppError('not_found', `No enabled connection ${input.connection}.`);
    if (row.connector !== shopifyAppConnector.id)
      throw new AppError(
        'invalid_input',
        `${connectorOf(row.connector).label} connections cannot import customers; use a Shopify app connection.`,
      );
    const settings = shopifyAppConnector.settings.parse(row.settings);
    const secrets = await connectionSecrets(ctx.tx, row, ctx.services.keyProvider);
    const egress = ctx.services.egress ?? { allowedHosts: [] };
    let data: Awaited<ReturnType<typeof shopifyGraphql>>;
    try {
      data = await shopifyGraphql(
        settings,
        row.oauthStatus === 'connected' ? accessTokenOf(secrets) : undefined,
        (url, init) => safeRequest(url, init, egress),
        CUSTOMERS_QUERY,
        { after: input.cursor ?? null },
      );
    } catch (err) {
      throw new AppError('conflict', `Shopify: ${(err as Error).message}`);
    }
    const page = data.customers as { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Record<string, unknown>[] };
    const items = page.nodes.flatMap((n) => graphqlCustomerItems(n, settings));
    const policy = {
      plan: await publishedSingleton(ctx.tx, 'tracking_plan'),
      purposes: (await publishedSingleton(ctx.tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES,
    };
    const source = { id: row.id, workspaceId: ctx.principal.workspaceId, kind: 'server' as const, requiredPurpose: null };
    const { accepted, rejected } = acceptItems(items, source, policy);
    if (rejected.length) throw new AppError('invalid_input', `Shopify customers were refused: ${rejected[0].error}`);
    if (accepted.length) await ctx.services.bus.publish(accepted);
    return {
      imported: page.nodes.length,
      consentRecords: items.filter((i) => i.type === 'track').length,
      cursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
      done: !page.pageInfo.hasNextPage,
    };
  },
});

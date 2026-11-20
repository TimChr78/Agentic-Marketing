import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { AdapterDeps } from '@agentic-marketing/email';
import type { EventStore } from '@agentic-marketing/events';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { emailRoutes, linkSigner } from '../src';

// #1093: a signed preference link issued before a merge still names the old profile id. The route
// resolves it through the shared merge walk (256 hops, cycle-safe), so a link 21+ merges deep finds
// its person instead of showing the expired page.

const HOPS = 25;
const chain = Array.from({ length: HOPS }, () => newId('prf'));

let d: Awaited<ReturnType<typeof createDisposableDb>>;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('email_deep_merge_link');
  await d.db.withWorkspace(d.workspace, (tx) =>
    tx.insert(schema.profiles).values(
      chain.map((id, i) => ({
        workspaceId: d.workspace,
        id,
        mergedInto: i < chain.length - 1 ? chain[i + 1]! : null,
      })),
    ),
  );
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('a preference link on a deep merge chain (#1093)', () => {
  it(`resolves a link ${HOPS} merges deep to the person instead of expiring it`, async () => {
    const links = linkSigner('deep-merge-link-secret');
    const app = emailRoutes({
      db: d.db,
      kp: localKeyProvider(Buffer.alloc(32, 31).toString('base64')),
      events: {} as EventStore,
      email: {
        publicUrl: 'https://links.example.com',
        links,
        adapterDeps: {} as AdapterDeps,
        trackClicks: false,
      },
    });
    // The token was signed when the person still had the first id in the chain.
    const token = links.sign({ w: d.workspace, p: chain[0]!, u: 'marketing_email' });

    const response = await app.request(`/u/p/${token}`);

    // The old 20-hop walk returned null and the page answered 404 as an expired link.
    expect(response.status).toBe(200);
  });
});

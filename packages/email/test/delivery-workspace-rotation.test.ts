import { randomBytes, randomUUID } from 'node:crypto';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { personCrypto } from '@agentic-marketing/profiles';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/src/pool';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import type { AdapterDeps } from '../src/adapters';
import { deliverRound } from '../src/gateway';
import { linkSigner } from '../src/links';
import { webhookTokenHash } from '../src/providers';

// #1238: the delivery worker visits at most 100 workspaces per round, and the scan must pick the
// ones with work it can do now, in a defined order that rotates. A workspace holding only a message
// the claim cannot take (a quiet hour or a send window in the future) used to occupy a slot on every
// round, so every workspace behind the first 100 was never served.

const MASTER_KEY = Buffer.alloc(32, 63).toString('base64');
const BUSY = 100;
const DUE = 150;

let d: Awaited<ReturnType<typeof createDisposableDb>>;
// The delivery worker runs on the app pool, which the row policies constrain; the disposable
// database's own handle is the superuser for both pools, so it is only used to seed.
let app: Db;
let kp: ReturnType<typeof localKeyProvider>;

const email = () => ({
  publicUrl: 'https://links.example.test',
  links: linkSigner('workspace-rotation'),
  adapterDeps: {} as AdapterDeps,
  trackClicks: false,
});

async function queuedMessage(ws: string, createdAt: string, notBefore?: string): Promise<string> {
  const id = newId('msg');
  await d.db.admin.query(
    `INSERT INTO messages (workspace_id, id, idempotency_key, channel, purpose, status, not_before, created_at, updated_at)
     VALUES ($1, $2, $3, 'email', 'onboarding', 'queued', $4, $5, $5)`,
    [ws, id, `idem-${randomUUID()}`, notBefore ?? null, createdAt],
  );
  return id;
}

async function newWorkspace(name: string, id = randomUUID()): Promise<string> {
  await d.db.admin.query('INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, $3)', [id, name, 'none']);
  return id;
}

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('email_workspace_rotation');
  kp = localKeyProvider(MASTER_KEY);
  const appUrl = new URL(d.url.toString());
  appUrl.username = APP_ROLE.appRole;
  appUrl.password = APP_ROLE.appRolePassword;
  app = createDb({ adminUrl: d.url.toString(), appUrl: appUrl.toString(), poolSize: 2 });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('the delivery worker’s workspace scan (#1238)', () => {
  it('serves a workspace with due work while 100 other workspaces only hold messages', async () => {
    const ws = d.workspace;
    const templateId = newId('eml');
    const profileId = newId('prf');
    await d.db.withWorkspace(ws, async (tx) => {
      await tx.insert(schema.profiles).values({ workspaceId: ws, id: profileId, traits: { timezone: 'UTC' } });
      const crypto = personCrypto(tx, ws, kp);
      await tx.insert(schema.identifiers).values({
        workspaceId: ws,
        profileId,
        type: 'email',
        value: await crypto.matchHash('email', 'person@example.test'),
        valueEnc: await crypto.seal(profileId, 'person@example.test'),
      });
      await tx
        .insert(schema.artifacts)
        .values({ workspaceId: ws, id: templateId, type: 'email_template', name: 'Slots', latestVersion: 1, publishedVersion: 1 });
      await tx.insert(schema.artifactVersions).values({
        workspaceId: ws,
        artifactId: templateId,
        number: 1,
        state: 'published',
        content: {
          purpose: 'onboarding',
          subject: 'Hello',
          mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text></mj-column></mj-section></mj-body></mjml>',
        },
        contentHash: 'hash-1',
        authorType: 'user',
        authorId: 'usr_test',
      });
      await tx.insert(schema.emailProviders).values({
        workspaceId: ws,
        id: newId('prv'),
        name: 'Outbox',
        adapter: 'log',
        config: {},
        fromEmail: 'hej@example.test',
        fromName: 'Test',
        useFor: ['transactional'],
        webhookTokenHash: webhookTokenHash(`tok-${randomBytes(9).toString('hex')}`),
      });
      await tx.insert(schema.messages).values({
        workspaceId: ws,
        id: newId('msg'),
        idempotencyKey: `idem-${randomUUID()}`,
        channel: 'email',
        profileId,
        purpose: 'onboarding',
        templateId,
        templateVersion: 1,
        status: 'queued',
      });
    });
    // 100 workspaces whose only message waits for a send window that opens tomorrow. The ids sort
    // before the disposable workspace's random one, which is the order the old plan picked (#1238).
    for (let i = 0; i < BUSY; i++) {
      const other = await newWorkspace(`Busy ${i}`, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      await queuedMessage(other, new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    }

    const handled = await deliverRound(app, { kp, events: {} as EventStore, email: email() });
    const [row] = (
      await d.db.admin.query<{ status: string; reason: string | null }>('SELECT status, reason FROM messages WHERE workspace_id = $1', [ws])
    ).rows;
    expect(handled).toBe(1);
    expect(row).toMatchObject({ status: 'sent', reason: null });
  }, 120_000);

  it('rotates through more than 100 workspaces that each have work, instead of the same first 100', async () => {
    // One due message per workspace, all older than the retry back-off. They fail with no_template,
    // which is enough to tell that the workspace was visited.
    const ids: string[] = [];
    for (let i = 0; i < DUE; i++) {
      const ws = await newWorkspace(`Due ${i}`);
      ids.push(await queuedMessage(ws, new Date(Date.now() - 7_200_000).toISOString()));
    }
    const left = async () => {
      const { rows } = await d.db.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM messages WHERE id = ANY($1::text[]) AND status = 'queued'`,
        [ids],
      );
      return rows[0]!.n;
    };

    expect(await left()).toBe(DUE);
    // The first round reaches 100 of them (the bound is unchanged), the next one the rest.
    await deliverRound(app, { kp, events: {} as EventStore, email: email() });
    expect(await left()).toBe(DUE - 100);
    await deliverRound(app, { kp, events: {} as EventStore, email: email() });
    expect(await left()).toBe(0);
  }, 120_000);
});

describe.skipIf(!hasTestDatabase())('the per-row claim (#1237 review)', () => {
  it('processes the next due row while another connection holds the oldest queued row', async () => {
    // A worker's claim must not wait behind a row someone else locked: the UPDATE without
    // SKIP LOCKED serialised every worker behind the oldest row, so the next due message stalled
    // for as long as that lock lasted.
    const locked = await queuedMessage(d.workspace, new Date(Date.now() - 120_000).toISOString());
    const other = await queuedMessage(d.workspace, new Date(Date.now() - 60_000).toISOString());
    await d.db.admin.query(`DELETE FROM messages WHERE workspace_id = $1 AND status = 'queued' AND id NOT IN ($2, $3)`, [
      d.workspace,
      locked,
      other,
    ]);
    const locker = await d.db.admin.connect();
    await locker.query('BEGIN');
    let round: Promise<number> | undefined;
    try {
      await locker.query('SELECT id FROM messages WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [d.workspace, locked]);
      round = deliverRound(app, { kp, events: {} as EventStore, email: email() });
      const processed = await Promise.race([
        round,
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked on the old row'), 2000)),
      ]);
      expect(processed).toBe(1);
      const { rows } = await locker.query<{ status: string; reason: string | null }>(
        'SELECT status, reason FROM messages WHERE workspace_id = $1 AND id = $2',
        [d.workspace, other],
      );
      // It reached its own attempt (no template here, so it fails on purpose) rather than waiting.
      expect(rows[0]).toMatchObject({ status: 'failed' });
      expect(rows[0]!.reason).toMatch(/^no_template: /);
      const { rows: held } = await locker.query<{ status: string }>('SELECT status FROM messages WHERE workspace_id = $1 AND id = $2', [
        d.workspace,
        locked,
      ]);
      expect(held[0]!.status).toBe('queued');
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await round;
    }
  }, 30_000);
});

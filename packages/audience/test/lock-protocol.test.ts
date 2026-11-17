import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { linkSigner } from '@agentic-marketing/email';
import type { BusEvent } from '@agentic-marketing/events';
import { applyEvents, consentStateOf, mergedFamily, personCrypto, profileIdsForBatch } from '@agentic-marketing/profiles';
import { assertNoProviderCalls, localKeyProvider, prepareKeys, recordingKeyProvider, withPreparedKeys } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import {
  dropConsentPause,
  holdConsentPause,
  installConsentPause,
  releaseConsentPause,
  waitForAdvisoryHolderBlocked,
  waitForIdentityWaiter,
} from '../../profiles/test/lockSupport';
import { consentHook, IMPORTED, SUBMITTED } from '../src';

// #978 part 3: the form, double opt-in and import hooks take the workspace identity lock before
// their batch, so a signup and a merge cannot both decide the canonical profile from a stale view.

const MASTER_KEY = Buffer.alloc(32, 47).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let recorder: ReturnType<typeof recordingKeyProvider>;
let ws: string;
let hook: ReturnType<typeof consentHook>;
let formId: string;
let templateId: string;
let clock = 0;

const at = () => new Date(Date.UTC(2026, 2, 1, 0, clock++)).toISOString();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('audience_lock_protocol');
  kp = localKeyProvider(MASTER_KEY);
  recorder = recordingKeyProvider(kp);
  ws = d.workspace;
  hook = consentHook({ db: d.db, links: linkSigner('audience-lock-secret'), linksUrl: 'https://links.example.com' });
  // A published confirmation template and the form that uses it, so a double opt-in submission
  // prepares a real send intent.
  const artifact = async (type: 'email_template' | 'form', content: Record<string, unknown>) => {
    const id = newId(type === 'form' ? 'frm' : 'eml');
    await d.db.withWorkspace(ws, async (tx) => {
      await tx.insert(schema.artifacts).values({
        workspaceId: ws,
        id,
        type,
        name: type,
        latestVersion: 1,
        publishedVersion: 1,
      });
      await tx.insert(schema.artifactVersions).values({
        workspaceId: ws,
        artifactId: id,
        number: 1,
        state: 'published',
        content,
        contentHash: `hash-${id}`,
        authorType: 'user',
        authorId: 'usr_test',
      });
    });
    return id;
  };
  templateId = await artifact('email_template', {
    purpose: 'onboarding',
    subject: 'Confirm your subscription',
    mjml: '<mjml><mj-body><mj-section><mj-column><mj-text><a href="{{ confirm_url | raw }}">Confirm</a></mj-text></mj-column></mj-section></mj-body></mjml>',
  });
  formId = await artifact('form', {
    purposes: ['marketing_email'],
    doubleOptIn: true,
    confirmationTemplate: templateId,
    consentText: 'Send me the newsletter.',
    successUrl: '/check-inbox',
  });
  await installConsentPause(d.db.admin);
}, 120_000);

afterAll(async () => {
  if (d) await dropConsentPause(d.db.admin);
  await d?.close();
});

const event = (over: Partial<BusEvent>): BusEvent => {
  const timestamp = at();
  return {
    workspaceId: ws,
    sourceId: 'src_lock_test',
    messageId: newId('evt'),
    type: 'track',
    name: 'Page Viewed',
    anonymousId: '',
    userId: '',
    timestamp,
    receivedAt: timestamp,
    properties: {},
    traits: {},
    piiTraits: {},
    context: {},
    consent: {},
    ...over,
  };
};

async function seedProfile(id: string, idents: { anonymous?: string; user?: string }, createdAt: Date) {
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id, createdAt });
    const rows = [];
    if (idents.anonymous) rows.push({ workspaceId: ws, profileId: id, type: 'anonymous_id' as const, value: idents.anonymous });
    if (idents.user) rows.push({ workspaceId: ws, profileId: id, type: 'user_id' as const, value: idents.user });
    if (rows.length) await tx.insert(schema.identifiers).values(rows);
  });
}

const runBatch = async (batch: BusEvent[]) =>
  withPreparedKeys(
    async () => {
      const ids = await d.db.withWorkspace(ws, (tx) => profileIdsForBatch(tx, ws, batch, personCrypto(tx, ws, kp)));
      return prepareKeys(d.db, ws, kp, { profileIds: ids });
    },
    (prepared) => d.db.withWorkspace(ws, (tx) => applyEvents(tx, ws, batch, { prepared, purposes: async () => DEFAULT_PURPOSES })),
  );

const familyOf = (profileId: string) => d.db.withWorkspace(ws, (tx) => mergedFamily(tx, ws, profileId));
const grantedState = (profileId: string) =>
  d.db.withWorkspace(ws, async (tx) =>
    (await consentStateOf(tx, ws, profileId)).filter((r) => r.purpose === 'marketing_email' && r.status === 'granted'),
  );
const evidence = async (families: string[]) => {
  const res = await d.db.admin.query<{ profile_id: string; status: string }>(
    'SELECT profile_id, status FROM consent_records WHERE workspace_id = $1 ORDER BY id',
    [ws],
  );
  const allowed = new Set(families);
  return res.rows.filter((r) => allowed.has(r.profile_id));
};

const formEvent = (anonymous: string, over: Partial<BusEvent['properties']> = {}) =>
  event({
    anonymousId: anonymous,
    sourceId: formId,
    name: SUBMITTED,
    properties: {
      form_id: formId,
      form_version: 1,
      purposes: ['marketing_email'],
      consent_text: 'Send me the newsletter',
      page: 'https://example.com/signup',
      ...over,
    },
  });

const merge = (anonymous: string, user: string) => runBatch([event({ anonymousId: anonymous, userId: user })]);

describe.skipIf(!hasTestDatabase())('form and import consent under the identity lock (#978 part 3)', () => {
  it('a form signup after a P→Q merge records on the survivor', async () => {
    const q = newId('prf');
    const p = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, new Date(Date.UTC(2026, 2, 1)));
    await seedProfile(p, { anonymous: `anon-${p}` }, new Date(Date.UTC(2026, 2, 2)));
    await merge(`anon-${p}`, `user-${q}`);

    const resolved = await runBatch([formEvent(`anon-${p}`)]);
    await hook(ws, resolved);

    expect((await evidence([q, p])).map((r) => r.profile_id)).toEqual([q]);
    expect(await grantedState(q)).toHaveLength(1);
  }, 60_000);

  it('a form signup racing a merge stays in the survivor’s rebuild', async () => {
    const q = newId('prf');
    const p = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, new Date(Date.UTC(2026, 2, 1)));
    await seedProfile(p, { anonymous: `anon-${p}` }, new Date(Date.UTC(2026, 2, 2)));
    const resolved = await runBatch([formEvent(`anon-${p}`)]);
    // Pause the hook after it resolved P, before its evidence lands: the merge must wait.
    const probe = await d.db.admin.connect();
    let hooked: Promise<void> | undefined;
    let mergeBatch: Promise<unknown> | undefined;
    try {
      await holdConsentPause(probe);
      hooked = hook(ws, resolved);
      await waitForAdvisoryHolderBlocked(probe, ws);
      mergeBatch = merge(`anon-${p}`, `user-${q}`);
      await waitForIdentityWaiter(probe, ws);
    } finally {
      await releaseConsentPause(probe);
    }
    await hooked;
    await mergeBatch;
    probe.release();

    const family = await familyOf(q);
    expect(family).toEqual(expect.arrayContaining([p, q]));
    expect((await evidence(family)).map((r) => r.profile_id)).toEqual([p]);
    expect(await grantedState(q)).toHaveLength(1);
  }, 60_000);

  it('an import commits before a merge and the survivor keeps the refusal', async () => {
    const q = newId('prf');
    const p = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, new Date(Date.UTC(2026, 2, 1)));
    await seedProfile(p, { anonymous: `anon-${p}` }, new Date(Date.UTC(2026, 2, 2)));
    const imported = event({
      anonymousId: `anon-${p}`,
      sourceId: `imp_${newId('prf')}`,
      name: IMPORTED,
      properties: {
        label: 'Kit export',
        consent: [{ purpose: 'marketing_email', status: 'withdrawn', recordedAt: '2026-02-01T00:00:00.000Z' }],
      },
    });
    const resolved = await runBatch([imported]);
    await hook(ws, resolved);
    await merge(`anon-${p}`, `user-${q}`);

    const family = await familyOf(q);
    expect((await evidence(family)).map((r) => r.status)).toEqual(['withdrawn']);
    const state = await d.db.withWorkspace(ws, async (tx) =>
      (await consentStateOf(tx, ws, q)).filter((r) => r.purpose === 'marketing_email'),
    );
    expect(state).toMatchObject([{ status: 'withdrawn' }]);
  }, 60_000);

  it('prepares the double opt-in send outside the lock and makes no provider call in the hook', async () => {
    const p = newId('prf');
    await seedProfile(p, { anonymous: `anon-${p}` }, new Date(Date.UTC(2026, 2, 2)));
    const resolved = await runBatch([formEvent(`anon-${p}`, { double_opt_in: true })]);
    recorder.reset();
    // The hook only writes the intent (and reads the form), so the protected batch never reaches
    // the key provider: the confirmation is sent by the outbox dispatcher after the commit.
    await assertNoProviderCalls(recorder, () => hook(ws, resolved));
    expect(recorder.calls).toHaveLength(0);
    const outbox = await d.db.admin.query<{ kind: string }>("SELECT kind FROM outbox WHERE workspace_id = $1 AND kind = 'doi_send'", [ws]);
    expect(outbox.rowCount).toBe(1);
  }, 60_000);
});

import { type ConversionMap, DEFAULT_PURPOSES, publishedSingleton, publishValidators } from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { consentOf } from '@agentic-marketing/events';
import { accessTokenOf, connectionSecrets, connectorOf, type DeliveryDeps, deliveryHandlers } from '@agentic-marketing/integrations';
import { consentStateOf, currentConsent, profileForMessage, type ResolvedEvent } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { CLICK_ID_TYPES, type ClickIds, purposeHolds } from './clickIds';
import {
  type Conversion,
  googleAdsConnector,
  metaAdsConnector,
  microsoftAdsConnector,
  type Person,
  type SendResult,
  sendToGoogle,
  sendToMeta,
  sendToMicrosoft,
} from './platforms';
import { linkedinAdsConnector, pinterestAdsConnector, sendToLinkedin, sendToPinterest, sendToTiktok, tiktokAdsConnector } from './social';

// Conversion feedback (performance-marketing.md, flow 1): mapped events of people who allowed
// ad_measurement are queued per platform in the deliveries outbox and sent by the delivery worker,
// with retries and the connection's rate limit. Identifiers are read and hashed only at send time.

const PLATFORMS = ['meta', 'google', 'microsoft', 'linkedin', 'tiktok', 'pinterest'] as const;
type Platform = (typeof PLATFORMS)[number];
const CONNECTOR: Record<Platform, string> = {
  meta: metaAdsConnector.id,
  google: googleAdsConnector.id,
  microsoft: microsoftAdsConnector.id,
  linkedin: linkedinAdsConnector.id,
  tiktok: tiktokAdsConnector.id,
  pinterest: pinterestAdsConnector.id,
};

publishValidators.set('conversion_map', async (content, tx: Tx) => {
  const map = content as ConversionMap;
  const problems: string[] = [];
  const refs = map.rules.flatMap((r, i) => PLATFORMS.flatMap((p) => (r[p] ? [{ i, p, id: r[p]!.connection }] : [])));
  const rows = refs.length
    ? await tx
        .select()
        .from(schema.connections)
        .where(inArray(schema.connections.id, [...new Set(refs.map((r) => r.id))]))
    : [];
  map.rules.forEach((r, i) => {
    if (!PLATFORMS.some((p) => r[p])) problems.push(`rule ${i + 1} ("${r.event}") sends nowhere: add one of ${PLATFORMS.join(', ')}`);
    if (r.value && !r.currency && !r.currencyProperty) problems.push(`rule ${i + 1} ("${r.event}") has a value but no currency`);
  });
  for (const ref of refs) {
    const row = rows.find((x) => x.id === ref.id);
    if (!row) problems.push(`rule ${ref.i + 1}: ${ref.id} is not a connection in this workspace`);
    else if (row.connector !== CONNECTOR[ref.p])
      problems.push(`rule ${ref.i + 1}: ${ref.id} is a ${row.connector} connection, not ${CONNECTOR[ref.p]}`);
  }
  return problems;
});

const get = (o: unknown, path: string) =>
  path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

async function latestStatus(tx: Tx, ws: string, profileId: string, purpose: string) {
  return currentConsent(await consentStateOf(tx, ws, profileId), purpose);
}

/** Post-resolve hook: queues the conversions an event triggers. */
export function conversionHook(deps: { db: Db }) {
  return async (workspaceId: string, resolved: ResolvedEvent[]) => {
    if (!resolved.length) return;
    await deps.db.withWorkspace(workspaceId, async (tx) => {
      const map = await publishedSingleton(tx, 'conversion_map');
      if (!map) return;
      const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
      for (const { event: e, profileId } of resolved) {
        const rules = map.rules.filter((r) => r.event === e.name);
        if (!rules.length) continue;
        const signal = consentOf(e.context);
        const ledger = await latestStatus(tx, workspaceId, profileId, 'ad_measurement');
        if (!purposeHolds(purposes, 'ad_measurement', signal?.ad_measurement, ledger?.status)) continue;
        const page = e.context.page as { url?: string } | undefined;
        for (const r of rules) {
          const rawValue = r.value ? Number(get(e.properties, r.value)) : undefined;
          const currency =
            r.currency ?? (r.currencyProperty ? String(get(e.properties, r.currencyProperty) ?? '').toUpperCase() : undefined);
          const conversion = {
            eventId: e.messageId,
            name: e.name,
            at: e.timestamp,
            ...(rawValue !== undefined && Number.isFinite(rawValue) ? { value: rawValue } : {}),
            ...(currency && /^[A-Z]{3}$/.test(currency) ? { currency } : {}),
            ...(page?.url ? { sourceUrl: page.url } : {}),
            ...(typeof e.context.userAgent === 'string' ? { userAgent: e.context.userAgent } : {}),
            profileId,
            adTargeting: signal?.ad_targeting,
          };
          for (const platform of PLATFORMS) {
            const dest = r[platform];
            if (!dest) continue;
            await tx
              .insert(schema.deliveries)
              .values({
                workspaceId,
                id: newId('dlv'),
                kind: 'ad_conversion',
                targetId: dest.connection,
                action: platform,
                payload: { ...conversion, destination: dest },
                status: 'pending',
                idempotencyKey: `adc:${platform}:${dest.connection}:${e.messageId}`,
                profileId,
              })
              .onConflictDoNothing();
          }
        }
      }
    });
  };
}

async function personFor(tx: Tx, ws: string, profileId: string, kp: KeyProvider, adTargetingSignal: boolean | undefined) {
  const person = await profileForMessage(tx, ws, profileId, kp);
  if (!person) return null;
  const ids = await tx
    .select()
    .from(schema.identifiers)
    .where(and(eq(schema.identifiers.profileId, person.id), inArray(schema.identifiers.type, CLICK_ID_TYPES)))
    .orderBy(desc(schema.identifiers.lastSeen));
  const clickIds: ClickIds = {};
  for (const i of ids) clickIds[i.type as keyof ClickIds] ??= i.value;
  const purposes = (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
  const targeting = await latestStatus(tx, ws, person.id, 'ad_targeting');
  return {
    id: person.id,
    person: {
      email: person.email,
      phone: person.phone,
      clickIds,
      personalization: purposeHolds(purposes, 'ad_targeting', adTargetingSignal, targeting?.status),
    } satisfies Person,
  };
}

/** Sends one conversion with a connection; shared by the delivery worker and ads.test. */
function send(
  row: typeof schema.connections.$inferSelect,
  secrets: Record<string, unknown>,
  c: Conversion,
  p: Person,
  dest: unknown,
  egress: DeliveryDeps['egress'],
  test = false,
) {
  if (row.connector === metaAdsConnector.id)
    return sendToMeta(
      c,
      p,
      dest as { eventName: string },
      metaAdsConnector.settings.parse(row.settings),
      metaAdsConnector.secrets.parse(secrets),
      egress,
      { test },
    );
  if (row.connector === googleAdsConnector.id)
    return sendToGoogle(
      c,
      p,
      dest as { conversionAction: string },
      googleAdsConnector.settings.parse(row.settings),
      row.oauthStatus === 'connected' ? accessTokenOf(secrets) : undefined,
      egress,
      { test },
    );
  if (row.connector === microsoftAdsConnector.id) {
    if (test)
      return Promise.resolve<SendResult>({
        ok: false,
        error: 'Microsoft has no test mode: point apiBase at the sandbox and use a sandbox account',
        permanent: true,
      });
    return sendToMicrosoft(
      c,
      p,
      dest as { conversionName: string },
      microsoftAdsConnector.settings.parse(row.settings),
      microsoftAdsConnector.secrets.parse(secrets),
      row.oauthStatus === 'connected' ? accessTokenOf(secrets) : undefined,
      egress,
    );
  }
  if (row.connector === linkedinAdsConnector.id) {
    if (test)
      return Promise.resolve<SendResult>({
        ok: false,
        error: 'LinkedIn has no test mode: send to a test conversion rule',
        permanent: true,
      });
    return sendToLinkedin(
      c,
      p,
      dest as { conversionId: string },
      linkedinAdsConnector.settings.parse(row.settings),
      row.oauthStatus === 'connected' ? accessTokenOf(secrets) : undefined,
      egress,
    );
  }
  if (row.connector === tiktokAdsConnector.id)
    return sendToTiktok(
      c,
      p,
      dest as { event: string },
      tiktokAdsConnector.settings.parse(row.settings),
      tiktokAdsConnector.secrets.parse(secrets),
      egress,
      { test },
    );
  if (row.connector === pinterestAdsConnector.id)
    return sendToPinterest(
      c,
      p,
      dest as { eventName: string },
      pinterestAdsConnector.settings.parse(row.settings),
      pinterestAdsConnector.secrets.parse(secrets),
      egress,
      { test },
    );
  return Promise.resolve<SendResult>({
    ok: false,
    error: `${connectorOf(row.connector).label} does not take conversions`,
    permanent: true,
  });
}

deliveryHandlers.set('ad_conversion', async (db, d, deps) => {
  const c = d.payload as Conversion & { destination: unknown; adTargeting?: boolean };
  // Read everything in the transaction; the request to the platform runs outside it.
  type Ready = {
    row: typeof schema.connections.$inferSelect;
    found: NonNullable<Awaited<ReturnType<typeof personFor>>>;
    secrets: Record<string, unknown>;
  };
  const ready = await db.withWorkspace(d.workspaceId, async (tx): Promise<Ready | SendResult> => {
    const [row] = await tx.select().from(schema.connections).where(eq(schema.connections.id, d.targetId));
    if (!row?.enabled) return { ok: false, error: 'the connection was deleted or disabled', permanent: true };
    const found = await personFor(tx, d.workspaceId, c.profileId, deps.kp, c.adTargeting);
    if (!found) return { ok: false, error: 'the person was erased', permanent: true };
    // A withdrawal after the event wins: nothing is sent.
    const now = await latestStatus(tx, d.workspaceId, found.id, 'ad_measurement');
    if (now && ['withdrawn', 'denied', 'objected'].includes(now.status) && now.updatedAt.getTime() > Date.parse(c.at))
      return { ok: false, error: 'ad_measurement was withdrawn after the event', permanent: true };
    return { row, found, secrets: await connectionSecrets(tx, row, deps.kp) };
  });
  if ('ok' in ready) return ready;
  const limit = connectorOf(ready.row.connector).rateLimit ?? 600;
  if (deps.hot && !(await deps.hot.take(`con:${ready.row.id}`, 1, limit / 60, limit))) return 'later';
  return send(ready.row, ready.secrets, { ...c, profileId: ready.found.id }, ready.found.person, c.destination, deps.egress);
});

const ConnectionId = z.string().regex(/^con_[0-9a-f]{32}$/);

export const testAdConnection = defineCommand({
  name: 'ads.test',
  title: 'Test an ad platform connection',
  description:
    "Sends a sample conversion in the platform's test mode: Meta and TikTok with the connection's testEventCode (it shows under Test events), Google with validateOnly (checked, not recorded), Pinterest with test=true. The identifiers are made up.",
  input: z.object({
    connection: ConnectionId,
    eventName: z.string().max(100).default('Lead').describe('Meta event name (TikTok: its event, Pinterest: its event name)'),
    conversionAction: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional()
      .describe('Google conversion action id'),
  }),
  output: z.object({ ok: z.boolean(), statusCode: z.number().nullable(), response: z.unknown(), error: z.string().nullable() }),
  permission: 'workspace:admin',
  effect: 'write',
  target: (i) => i.connection,
  handler: async (input, ctx) => {
    const [row] = await ctx.tx.select().from(schema.connections).where(eq(schema.connections.id, input.connection));
    if (!row) throw new AppError('not_found', `No connection ${input.connection}.`);
    if (row.connector === googleAdsConnector.id && !input.conversionAction)
      throw new AppError('invalid_input', 'Google needs a conversionAction to validate against.');
    const sample: Conversion = {
      eventId: `test-${newId('evt')}`,
      name: 'Test',
      at: new Date().toISOString(),
      value: 1,
      currency: 'EUR',
      profileId: 'test',
    };
    const person: Person = { email: 'test@example.com', phone: null, clickIds: {}, personalization: false };
    const dest =
      row.connector === googleAdsConnector.id
        ? { conversionAction: input.conversionAction }
        : row.connector === tiktokAdsConnector.id
          ? { event: input.eventName }
          : row.connector === pinterestAdsConnector.id
            ? { eventName: input.eventName === 'Lead' ? 'lead' : input.eventName }
            : { eventName: input.eventName };
    const secrets = await connectionSecrets(ctx.tx, row, ctx.services.keyProvider);
    const r = await send(row, secrets, sample, person, dest, ctx.services.egress ?? { allowedHosts: [] }, true);
    return r.ok
      ? { ok: true, statusCode: r.statusCode, response: r.response, error: null }
      : { ok: false, statusCode: r.statusCode ?? null, response: null, error: r.error };
  },
});

export const listConversions = defineCommand({
  name: 'ads.conversions',
  title: 'Conversions sent to ad platforms',
  description:
    'Recent conversions queued for the ad platforms, newest first: event, platform, status (pending, done, dead) and the platform error. Only people who allowed ad_measurement are ever queued.',
  input: z.object({
    status: z.enum(['pending', 'running', 'done', 'dead']).optional(),
    connection: ConnectionId.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    conversions: z.array(
      z.object({
        id: z.string(),
        platform: z.string(),
        connection: z.string(),
        event: z.string(),
        eventId: z.string(),
        value: z.number().nullable(),
        currency: z.string().nullable(),
        profileId: z.string().nullable(),
        status: z.string(),
        attempts: z.number(),
        error: z.string().nullable(),
        createdAt: z.string(),
        finishedAt: z.string().nullable(),
      }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const d = schema.deliveries;
    const rows = await ctx.tx
      .select()
      .from(d)
      .where(
        and(
          eq(d.kind, 'ad_conversion'),
          input.status ? eq(d.status, input.status) : undefined,
          input.connection ? eq(d.targetId, input.connection) : undefined,
        ),
      )
      .orderBy(desc(d.createdAt))
      .limit(input.limit);
    return {
      conversions: rows.map((r) => {
        const p = r.payload as Partial<Conversion>;
        return {
          id: r.id,
          platform: r.action ?? '',
          connection: r.targetId,
          event: p.name ?? '',
          eventId: p.eventId ?? '',
          value: p.value ?? null,
          currency: p.currency ?? null,
          profileId: r.profileId,
          status: r.status,
          attempts: r.attempts,
          error: r.error,
          createdAt: r.createdAt.toISOString(),
          finishedAt: r.finishedAt?.toISOString() ?? null,
        };
      }),
    };
  },
});

export const adCommands = [testAdConnection, listConversions] as const;

import { DEFAULT_PURPOSES, publishedSingleton, type TrackingPlan } from '@agentic-marketing/artifacts';
import { type CommandContext, defineCommand } from '@agentic-marketing/commands';
import { AppError, isoDateTime, newId } from '@agentic-marketing/core';
import { type IdentifierType, schema, type Tx } from '@agentic-marketing/db';
import type {} from '@agentic-marketing/hotstate';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  consentStateOf,
  consentStatusSql,
  consentSummary,
  currentConsent,
  effectiveTopicStatus,
  findTopic,
  mergedFamily,
  purposeAllowed,
  recordConsent,
  recordTopicPreference,
  topicChoicesOf,
  topicSummary,
} from './consent';
import { personCrypto } from './crypto';

// Profile, consent and data-subject-request commands. Personal data is decrypted only for
// principals with profiles:pii; agents additionally see only traits the attribute schema marks
// agent-visible. Reads of personal data are audited.

const ProfileId = z.string().regex(/^prf_[0-9a-f]{32}$/);
const HIDDEN = '[hidden]';

async function canonical(ctx: CommandContext, profileId: string) {
  let id = profileId;
  for (let i = 0; i < 20; i++) {
    const [p] = await ctx.tx
      .select()
      .from(schema.profiles)
      .where(and(eq(schema.profiles.workspaceId, ctx.principal.workspaceId), eq(schema.profiles.id, id)));
    if (!p) throw new AppError('not_found', `No profile ${profileId}. Find people with profiles.find or profiles.list.`);
    if (!p.mergedInto) return p;
    id = p.mergedInto;
  }
  throw new Error('merge chain too long');
}

async function purposesOf(ctx: CommandContext) {
  return (await publishedSingleton(ctx.tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
}

/** Which personal values this principal may see in clear. */
function piiFilter(ctx: CommandContext, plan: TrackingPlan | null) {
  if (!ctx.principal.permissions.has('profiles:pii')) return () => false;
  if (ctx.principal.type === 'user') return () => true;
  const visible = new Set(plan?.traits.filter((t) => t.agentVisible).map((t) => t.name));
  return (name: string) => visible.has(name);
}

async function identifiersOf(ctx: CommandContext, profileId: string) {
  return ctx.tx
    .select()
    .from(schema.identifiers)
    .where(and(eq(schema.identifiers.workspaceId, ctx.principal.workspaceId), eq(schema.identifiers.profileId, profileId)))
    .orderBy(schema.identifiers.firstSeen);
}

const Identifier = z.object({ type: z.string(), value: z.string(), firstSeen: z.string(), lastSeen: z.string() });
const ConsentEntry = z.object({
  purpose: z.string(),
  channel: z.string(),
  status: z.string(),
  basis: z.string(),
  source: z.string(),
  updatedAt: z.string(),
});
const ProfileOut = z.object({
  id: z.string(),
  traits: z.record(z.string(), z.unknown()).describe('Traits that are not personal data'),
  personal: z.record(z.string(), z.unknown()).describe(`Personal traits; values are "${HIDDEN}" without profiles:pii`),
  identifiers: z.array(Identifier),
  consent: z.array(ConsentEntry),
  mergedFrom: z.array(z.string()),
  firstSeen: z.string(),
  lastSeen: z.string(),
});

async function profileOut(ctx: CommandContext, p: typeof schema.profiles.$inferSelect) {
  const ws = ctx.principal.workspaceId;
  const crypto = personCrypto(ctx.tx, ws, ctx.services.keyProvider);
  const show = piiFilter(ctx, await publishedSingleton(ctx.tx, 'tracking_plan'));
  const pii = (await crypto.open<Record<string, unknown>>(p.id, p.pii)) ?? {};
  const ids = await identifiersOf(ctx, p.id);
  const personal: Record<string, unknown> = {};
  const identifiers = [];
  for (const i of ids) {
    let value = i.value;
    if (i.type === 'email' || i.type === 'phone') {
      const plain = await crypto.open<string>(p.id, i.valueEnc);
      value = show(i.type) && plain ? plain : HIDDEN;
      personal[i.type] = value;
    }
    identifiers.push({ type: i.type, value, firstSeen: i.firstSeen.toISOString(), lastSeen: i.lastSeen.toISOString() });
  }
  for (const [k, v] of Object.entries(pii)) personal[k] = show(k) ? v : HIDDEN;
  const family = await mergedFamily(ctx.tx, ws, p.id);
  return {
    id: p.id,
    traits: p.traits,
    personal,
    identifiers,
    consent: (await consentStateOf(ctx.tx, ws, p.id)).map((c) => ({ ...c, updatedAt: c.updatedAt.toISOString() })),
    mergedFrom: family.filter((id) => id !== p.id),
    firstSeen: p.firstSeen.toISOString(),
    lastSeen: p.lastSeen.toISOString(),
  };
}

export const listProfiles = defineCommand({
  name: 'profiles.list',
  title: 'Recently active profiles',
  description:
    'People (known and anonymous) by most recent activity, with their current consent per purpose and, with profiles:pii, their e-mail. Page with `before` (a lastSeen value).',
  input: z.object({ limit: z.number().int().min(1).max(200).default(50), before: isoDateTime('before').optional() }),
  output: z.object({
    profiles: z.array(
      z.object({
        id: z.string(),
        traits: z.record(z.string(), z.unknown()),
        known: z.boolean(),
        lastSeen: z.string(),
        firstSeen: z.string(),
        consent: z
          .array(z.object({ purpose: z.string(), status: z.string().nullable() }))
          .describe('The current status per purpose in force; null when the person has recorded none'),
        email: z.string().nullable().describe('The person’s e-mail; always null without profiles:pii'),
      }),
    ),
  }),
  permission: 'profiles:read',
  effect: 'read',
  handler: async (input, ctx) => {
    const purposes = await purposesOf(ctx);
    // One query for the page: consentStatusSql is the shared rule (ADR-0014) as a scalar subquery.
    const consent = purposes.length
      ? sql<Record<string, string | null>>`jsonb_build_object(${sql.join(
          purposes.flatMap((p) => [sql`${p.key}::text`, consentStatusSql(sql`${schema.profiles.id}`, p.key)]),
          sql`, `,
        )})`
      : sql<Record<string, string | null>>`'{}'::jsonb`;
    const rows = await ctx.tx
      .select({
        id: schema.profiles.id,
        traits: schema.profiles.traits,
        lastSeen: schema.profiles.lastSeen,
        firstSeen: schema.profiles.firstSeen,
        consent,
      })
      .from(schema.profiles)
      .where(and(isNull(schema.profiles.mergedInto), input.before ? lt(schema.profiles.lastSeen, new Date(input.before)) : undefined))
      .orderBy(desc(schema.profiles.lastSeen))
      .limit(input.limit);
    const identifierRows = rows.length
      ? await ctx.tx
          .select({ profileId: schema.identifiers.profileId, type: schema.identifiers.type, valueEnc: schema.identifiers.valueEnc })
          .from(schema.identifiers)
          .where(
            and(
              inArray(
                schema.identifiers.profileId,
                rows.map((r) => r.id),
              ),
              inArray(schema.identifiers.type, ['user_id', 'email', 'phone']),
            ),
          )
      : [];
    const knownIds = new Set(identifierRows.map((r) => r.profileId));
    // Decrypting a page is two extra queries, and only for a caller who may see personal data.
    const plan = ctx.principal.type === 'agent' ? await publishedSingleton(ctx.tx, 'tracking_plan') : null;
    const showEmail = piiFilter(ctx, plan)('email');
    const emails = identifierRows.filter((r) => r.type === 'email' && r.valueEnc);
    const opened =
      showEmail && emails.length
        ? await personCrypto(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider).openMany<string>(
            emails.map((r) => ({ profileId: r.profileId, sealed: r.valueEnc as Buffer })),
          )
        : [];
    const emailOf = new Map(emails.map((r, i) => [r.profileId, opened[i] ?? null]));
    return {
      profiles: rows.map((r) => ({
        id: r.id,
        traits: r.traits,
        known: knownIds.has(r.id),
        lastSeen: r.lastSeen.toISOString(),
        firstSeen: r.firstSeen.toISOString(),
        consent: purposes.map((p) => ({ purpose: p.key, status: r.consent?.[p.key] ?? null })),
        email: showEmail ? (emailOf.get(r.id) ?? null) : null,
      })),
    };
  },
});

export const findProfile = defineCommand({
  name: 'profiles.find',
  title: 'Find a person',
  description:
    'Look a person up by e-mail, phone, user id or anonymous id. E-mail and phone are matched by hash, so this works without seeing personal data.',
  input: z.object({ type: z.enum(['email', 'phone', 'user_id', 'anonymous_id']), value: z.string().min(1).max(320) }),
  output: z.object({ profileId: z.string().nullable() }),
  permission: 'profiles:read',
  effect: 'read',
  sensitive: ['value'],
  handler: async (input, ctx) => {
    const crypto = personCrypto(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider);
    const value = input.type === 'email' || input.type === 'phone' ? await crypto.matchHash(input.type, input.value) : input.value;
    const [i] = await ctx.tx
      .select({ profileId: schema.identifiers.profileId })
      .from(schema.identifiers)
      .where(and(eq(schema.identifiers.type, input.type as IdentifierType), eq(schema.identifiers.value, value)));
    return { profileId: i?.profileId ?? null };
  },
});

export const getProfile = defineCommand({
  name: 'profiles.get',
  title: 'Read a profile',
  description:
    'A person’s traits, identifiers and consent. Personal values are shown only with profiles:pii (agents: only traits the tracking plan marks agentVisible). A merged profile id returns the profile it was merged into.',
  input: z.object({ profileId: ProfileId }),
  output: ProfileOut,
  permission: 'profiles:read',
  effect: 'read',
  auditReads: true,
  target: (i) => i.profileId,
  handler: async (input, ctx) => profileOut(ctx, await canonical(ctx, input.profileId)),
});

export const profileEvents = defineCommand({
  name: 'profiles.events',
  title: 'A person’s events',
  description: 'Events of a person across all their anonymous and user ids, newest first. Page with `before` (a timestamp).',
  input: z.object({ profileId: ProfileId, limit: z.number().int().min(1).max(500).default(100), before: isoDateTime('before').optional() }),
  output: z.object({
    events: z.array(
      z.object({
        eventId: z.string(),
        type: z.string(),
        name: z.string(),
        timestamp: z.string(),
        properties: z.record(z.string(), z.unknown()),
        context: z.record(z.string(), z.unknown()),
      }),
    ),
  }),
  permission: 'profiles:read',
  effect: 'read',
  target: (i) => i.profileId,
  handler: async (input, ctx) => {
    const p = await canonical(ctx, input.profileId);
    const ids = await identifiersOf(ctx, p.id);
    const events = await ctx.services.events.eventsOf(
      ctx.principal.workspaceId,
      {
        anonymousIds: ids.filter((i) => i.type === 'anonymous_id').map((i) => i.value),
        userIds: ids.filter((i) => i.type === 'user_id').map((i) => i.value),
      },
      { limit: input.limit, before: input.before },
    );
    return {
      events: events.map(({ eventId, type, name, timestamp, properties, context }) => ({
        eventId,
        type,
        name,
        timestamp,
        properties,
        context,
      })),
    };
  },
});

export const listPurposes = defineCommand({
  name: 'purposes.list',
  title: 'Processing purposes',
  description:
    'The purposes in force (the published purposes artifact, or the defaults) with their lawful basis, channels and whether consent needs double opt-in.',
  input: z.object({}),
  output: z.object({
    source: z.enum(['published', 'default']),
    purposes: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        basis: z.string(),
        channels: z.array(z.string()),
        description: z.string(),
        requiresDoubleOptIn: z.boolean().describe('Whether a consent for this purpose counts only after a confirmed opt-in'),
        topics: z
          .array(
            z.object({
              key: z.string(),
              name: z.string(),
              description: z.string(),
              default: z.enum(['subscribed', 'unsubscribed']),
            }),
          )
          .describe('Finer choices within the purpose; the purpose stays the lawful-basis gate'),
      }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_i, ctx) => {
    const published = await publishedSingleton(ctx.tx, 'purposes');
    const purposes = (published?.purposes ?? DEFAULT_PURPOSES).map((p) => ({ ...p, topics: p.topics ?? [] }));
    return { source: published ? ('published' as const) : ('default' as const), purposes };
  },
});

export const consentSummaryCommand = defineCommand({
  name: 'consent.summary',
  title: 'Consent per purpose',
  description:
    'How many people currently allow or refuse each purpose, overall and per channel, using the same current-status rule as sends and segments.',
  input: z.object({}),
  output: z.object({
    purposes: z.array(
      z.object({
        purpose: z.string(),
        granted: z.number().int().describe('People whose current status for the purpose is "granted"'),
        denied: z.number().int(),
        withdrawn: z.number().int(),
        objected: z.number().int(),
        channels: z
          .array(
            z.object({
              channel: z.string().describe('A channel that has records for this purpose, e.g. "email"'),
              granted: z.number().int(),
              denied: z.number().int(),
              withdrawn: z.number().int(),
              objected: z.number().int(),
            }),
          )
          .describe('The same counts for each channel on its own'),
      }),
    ),
    topics: z
      .array(
        z.object({
          purpose: z.string(),
          topic: z.string(),
          subscribed: z
            .number()
            .int()
            .describe('Active people who currently subscribe, counting the topic default for people with no choice'),
          unsubscribed: z.number().int(),
        }),
      )
      .describe('Topic choices under each purpose'),
  }),
  permission: 'profiles:read',
  effect: 'read',
  handler: async (_i, ctx) => {
    const all = await purposesOf(ctx);
    return {
      purposes: await consentSummary(
        ctx.tx,
        ctx.principal.workspaceId,
        all.map((p) => p.key),
      ),
      topics: await topicSummary(ctx.tx, ctx.principal.workspaceId, all),
    };
  },
});

export const recordConsentCommand = defineCommand({
  name: 'consent.record',
  title: 'Record consent or an objection',
  description:
    'Add an entry to a person’s consent ledger, e.g. a consent given on a form or an objection by phone. Agents may only record restrictions (denied, withdrawn, objected), never a consent.',
  input: z.object({
    profileId: ProfileId,
    purpose: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    channel: z.enum(['', 'email', 'web', 'sms', 'push', 'webhook']).default(''),
    status: z.enum(['granted', 'denied', 'withdrawn', 'objected']),
    source: z.enum(['form', 'import', 'api', 'unsubscribe']).default('api'),
    proof: z.record(z.string(), z.unknown()).default({}).describe('Evidence: form id and text version, double opt-in token, call notes …'),
  }),
  output: z.object({ recorded: z.boolean(), allowed: z.boolean().describe('Whether the purpose is now allowed for this person') }),
  permission: 'profiles:write',
  effect: 'write',
  target: (i) => i.profileId,
  handler: async (input, ctx) => {
    if (ctx.principal.type === 'agent' && input.status === 'granted')
      throw new AppError('forbidden', 'Agents cannot record a consent; only a person (or the person’s own action) can.');
    const p = await canonical(ctx, input.profileId);
    const purposes = await purposesOf(ctx);
    if (!purposes.some((x) => x.key === input.purpose))
      throw new AppError('invalid_input', `Unknown purpose "${input.purpose}". See purposes.list.`);
    const n = await recordConsent(ctx.tx, ctx.principal.workspaceId, p.id, purposes, [
      {
        purpose: input.purpose,
        channel: input.channel,
        status: input.status,
        source: ctx.principal.type === 'agent' ? 'agent' : input.source,
        proof: input.proof,
        recordedBy: ctx.principal.userId,
      },
    ]);
    const state = currentConsent(await consentStateOf(ctx.tx, ctx.principal.workspaceId, p.id), input.purpose, input.channel || undefined);
    const basis = purposes.find((x) => x.key === input.purpose)?.basis ?? 'consent';
    return { recorded: n > 0, allowed: purposeAllowed(basis, state?.status) };
  },
});

export const consentHistory = defineCommand({
  name: 'consent.history',
  title: 'Consent ledger of a person',
  description: 'Every consent, refusal, withdrawal and objection recorded for a person (including merged profiles), oldest first.',
  input: z.object({ profileId: ProfileId }),
  output: z.object({
    records: z.array(
      z.object({
        purpose: z.string(),
        channel: z.string(),
        status: z.string(),
        basis: z.string(),
        source: z.string(),
        proof: z.record(z.string(), z.unknown()),
        recordedAt: z.string(),
        recordedBy: z.string().nullable(),
      }),
    ),
  }),
  permission: 'profiles:read',
  effect: 'read',
  target: (i) => i.profileId,
  handler: async (input, ctx) => {
    const p = await canonical(ctx, input.profileId);
    const family = await mergedFamily(ctx.tx, ctx.principal.workspaceId, p.id);
    const rows = await ctx.tx
      .select()
      .from(schema.consentRecords)
      .where(inArray(schema.consentRecords.profileId, family))
      .orderBy(schema.consentRecords.recordedAt, schema.consentRecords.id);
    return {
      records: rows.map((r) => ({
        purpose: r.purpose,
        channel: r.channel,
        status: r.status,
        basis: r.basis,
        source: r.source,
        proof: r.proof,
        recordedAt: r.recordedAt.toISOString(),
        recordedBy: r.recordedBy,
      })),
    };
  },
});

export const topicPreferencesCommand = defineCommand({
  name: 'topics.preferences',
  title: 'A person’s topic choices',
  description:
    'The topics under each purpose with the person’s current choice: their own record, or the topic’s default when they have made none. A topic is a finer choice within a purpose and never replaces consent for it.',
  input: z.object({ profileId: ProfileId }),
  output: z.object({
    topics: z.array(
      z.object({
        purpose: z.string(),
        purposeName: z.string(),
        topic: z.string(),
        name: z.string(),
        description: z.string(),
        default: z.enum(['subscribed', 'unsubscribed']).describe('What applies when the person has made no choice'),
        status: z.enum(['subscribed', 'unsubscribed']),
        source: z.string().nullable().describe('Where their own choice came from; null when the default applies'),
        updatedAt: z.string().nullable(),
      }),
    ),
  }),
  permission: 'profiles:read',
  effect: 'read',
  target: (i) => i.profileId,
  handler: async (input, ctx) => {
    const p = await canonical(ctx, input.profileId);
    const purposes = await purposesOf(ctx);
    const choices = await topicChoicesOf(ctx.tx, ctx.principal.workspaceId, p.id);
    return {
      topics: purposes.flatMap((purpose) =>
        (purpose.topics ?? []).map((topic) => {
          const row = choices.find((c) => c.topic === topic.key);
          return {
            purpose: purpose.key,
            purposeName: purpose.name,
            topic: topic.key,
            name: topic.name,
            description: topic.description,
            default: topic.default,
            status: effectiveTopicStatus(choices, topic),
            source: row?.source ?? null,
            updatedAt: row?.updatedAt?.toISOString() ?? null,
          };
        }),
      ),
    };
  },
});

export const setTopicPreference = defineCommand({
  name: 'topics.set',
  title: 'Record a topic choice for a person',
  description:
    'Record that a person subscribes to or unsubscribes from one topic, with a note as evidence. Agents may only record an unsubscribe, never a subscribe. The purpose’s consent is separate and unchanged.',
  input: z.object({
    profileId: ProfileId,
    topic: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,40}$/)
      .describe('A topic key from purposes.list'),
    status: z.enum(['subscribed', 'unsubscribed']),
    note: z.string().max(1000).optional().describe('What they asked for and where, e.g. "asked by e-mail on 2026-10-27"'),
  }),
  output: z.object({
    recorded: z.boolean().describe('Whether the current choice changed'),
    topic: z.string(),
    purpose: z.string(),
    status: z.enum(['subscribed', 'unsubscribed']),
  }),
  permission: 'profiles:write',
  effect: 'write',
  target: (i) => i.profileId,
  handler: async (input, ctx) => {
    if (ctx.principal.type === 'agent' && input.status === 'subscribed')
      throw new AppError('forbidden', 'Agents cannot subscribe someone to a topic; only a person (or the person’s own action) can.');
    const p = await canonical(ctx, input.profileId);
    const found = findTopic(await purposesOf(ctx), input.topic);
    if (!found) throw new AppError('invalid_input', `Unknown topic "${input.topic}". See purposes.list for the topics in force.`);
    const recorded = await recordTopicPreference(
      ctx.tx,
      ctx.principal.workspaceId,
      p.id,
      found.purpose.key,
      found.topic.key,
      input.status,
      ctx.principal.type === 'agent' ? 'agent' : 'api',
      { note: input.note, recordedBy: ctx.principal.userId },
    );
    return { recorded, topic: found.topic.key, purpose: found.purpose.key, status: input.status };
  },
});

export const exportProfile = defineCommand({
  name: 'profiles.export',
  title: 'Export a person’s data (access request)',
  description:
    'Everything held about a person, for a data subject access or portability request: profile, personal data, identifiers, consent ledger, topic choices and their history, and events.',
  input: z.object({ profileId: ProfileId, maxEvents: z.number().int().min(0).max(100_000).default(10_000) }),
  output: z.object({
    exportedAt: z.string(),
    profile: ProfileOut,
    consentRecords: z.array(z.record(z.string(), z.unknown())),
    topicChoices: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Current choices per topic, from the preference centre and elsewhere (#84)'),
    topicHistory: z.array(z.record(z.string(), z.unknown())).describe('Every topic choice with its source and evidence, oldest first'),
    events: z.array(z.record(z.string(), z.unknown())),
    aiDecisions: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Automated decisions and texts made for the person by AI steps, with the rationale (GDPR Art. 15 and 22)'),
    adUploads: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Conversions sent about the person to ad platforms (recipients under GDPR Art. 15), with what was sent'),
    pushDevices: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Browsers and apps registered for notifications (kind and dates; the endpoint or token is sealed)'),
  }),
  permission: 'profiles:pii',
  effect: 'read',
  humansOnly: true,
  auditReads: true,
  target: (i) => i.profileId,
  handler: async (input, ctx) => {
    const profile = await getProfile.handler({ profileId: input.profileId }, ctx);
    const { records } = await consentHistory.handler({ profileId: profile.id }, ctx);
    const { events } = input.maxEvents
      ? await profileEvents.handler({ profileId: profile.id, limit: Math.min(input.maxEvents, 500) }, ctx)
      : { events: [] };
    // Page through the rest.
    while (events.length < input.maxEvents && events.length % 500 === 0 && events.length) {
      const more = await profileEvents.handler(
        { profileId: profile.id, limit: Math.min(500, input.maxEvents - events.length), before: events[events.length - 1].timestamp },
        ctx,
      );
      if (!more.events.length) break;
      events.push(...more.events);
    }
    const family = [profile.id, ...profile.mergedFrom];
    const aiDecisions = (
      await ctx.tx.select().from(schema.aiCalls).where(inArray(schema.aiCalls.profileId, family)).orderBy(schema.aiCalls.createdAt)
    ).map((c) => ({
      at: c.createdAt.toISOString(),
      kind: c.kind,
      status: c.status,
      journeyId: c.journeyId,
      node: c.node,
      promptId: c.promptId,
      promptVersion: c.promptVersion,
      model: c.model,
      input: c.input,
      output: c.output,
      rationale: c.rationale,
      fallbackReason: c.error,
    }));
    const adUploads = (
      await ctx.tx
        .select()
        .from(schema.deliveries)
        .where(and(eq(schema.deliveries.kind, 'ad_conversion'), inArray(schema.deliveries.profileId, family)))
        .orderBy(schema.deliveries.createdAt)
    ).map((d) => {
      const p = d.payload as { name?: string; at?: string; value?: number; currency?: string };
      return {
        at: d.createdAt.toISOString(),
        platform: d.action,
        connection: d.targetId,
        event: p.name,
        eventAt: p.at,
        value: p.value,
        currency: p.currency,
        status: d.status,
        sent: 'hashed e-mail and phone, ad click ids, the event time and value',
      };
    });
    const ids = await ctx.tx
      .select({ type: schema.identifiers.type, value: schema.identifiers.value })
      .from(schema.identifiers)
      .where(and(inArray(schema.identifiers.profileId, family), inArray(schema.identifiers.type, ['anonymous_id', 'user_id'])));
    const ps = schema.pushSubscriptions;
    const anon = ids.filter((i) => i.type === 'anonymous_id').map((i) => i.value);
    const users = ids.filter((i) => i.type === 'user_id').map((i) => i.value);
    const pushDevices =
      anon.length || users.length
        ? (
            await ctx.tx
              .select()
              .from(ps)
              .where(or(anon.length ? inArray(ps.anonymousId, anon) : undefined, users.length ? inArray(ps.userId, users) : undefined))
          ).map((d) => ({
            kind: d.kind,
            registeredAt: d.createdAt.toISOString(),
            lastNotifiedAt: d.lastSentAt?.toISOString() ?? null,
          }))
        : [];
    const topicChoices = (
      await ctx.tx.select().from(schema.topicPreferences).where(inArray(schema.topicPreferences.profileId, family))
    ).map((t) => ({ topic: t.topic, status: t.status, source: t.source, updatedAt: t.updatedAt.toISOString() }));
    const topicHistory = (
      await ctx.tx
        .select()
        .from(schema.topicPreferenceHistory)
        .where(inArray(schema.topicPreferenceHistory.profileId, family))
        .orderBy(schema.topicPreferenceHistory.recordedAt)
    ).map((h) => ({
      at: h.recordedAt.toISOString(),
      topic: h.topic,
      purpose: h.purpose,
      status: h.status,
      source: h.source,
      note: h.note,
      proof: h.proof,
    }));
    return {
      exportedAt: new Date().toISOString(),
      profile,
      consentRecords: records,
      topicChoices,
      topicHistory,
      events,
      aiDecisions,
      adUploads,
      pushDevices,
    };
  },
});

/**
 * Removes people for good: events (ClickHouse), hot state, messages, consent ledger, merges and
 * the profiles themselves (identifiers and keys cascade, so sealed data is crypto-shredded).
 * `suppress` keeps hashes of their e-mail and phone so they are never contacted again: right for
 * an erasure request, wrong for a retention cleanup (they may sign up again).
 */
export async function removeProfiles(
  tx: Tx,
  ws: string,
  family: string[],
  services: { events: CommandContext['services']['events']; hot?: CommandContext['services']['hot'] },
  opts: { suppress: boolean },
) {
  const ids = await tx.select().from(schema.identifiers).where(inArray(schema.identifiers.profileId, family));
  // Events first: if this fails nothing else has changed, and the removal can simply be retried.
  await services.events.deleteEventsOf(ws, {
    anonymousIds: ids.filter((i) => i.type === 'anonymous_id').map((i) => i.value),
    userIds: ids.filter((i) => i.type === 'user_id').map((i) => i.value),
    profileIds: family,
  });
  // And from the decision API's hot state.
  await services.hot?.deleteSnapshot(ws, {
    anonymousIds: ids.filter((i) => i.type === 'anonymous_id').map((i) => i.value),
    userIds: ids.filter((i) => i.type === 'user_id').map((i) => i.value),
  });
  // Their browsers and apps stop getting notifications.
  const anon = ids.filter((i) => i.type === 'anonymous_id').map((i) => i.value);
  const users = ids.filter((i) => i.type === 'user_id').map((i) => i.value);
  if (anon.length) await tx.delete(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.anonymousId, anon));
  if (users.length) await tx.delete(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.userId, users));
  await tx.delete(schema.messages).where(inArray(schema.messages.profileId, family));
  // Out of every journey: no later step runs, and the participant's context (the trigger event) goes too.
  await tx.delete(schema.journeyParticipants).where(inArray(schema.journeyParticipants.profileId, family));
  // Out of every segment's materialised membership; static list rows cascade with the profile below.
  await tx.delete(schema.segmentMemberships).where(inArray(schema.segmentMemberships.profileId, family));
  const suppress = opts.suppress ? ids.filter((i) => i.type === 'email' || i.type === 'phone') : [];
  if (suppress.length)
    await tx
      .insert(schema.suppressions)
      .values(
        suppress.map((i) => ({ workspaceId: ws, channel: i.type === 'email' ? 'email' : 'sms', valueHash: i.value, reason: 'erased' })),
      )
      .onConflictDoNothing();
  const consent = await tx
    .delete(schema.consentRecords)
    .where(inArray(schema.consentRecords.profileId, family))
    .returning({ id: schema.consentRecords.id });
  await tx.delete(schema.profileMerges).where(inArray(schema.profileMerges.fromId, family));
  await tx.delete(schema.profileMerges).where(inArray(schema.profileMerges.intoId, family));
  // Cascades to identifiers, profile keys (crypto-shredding) and consent state.
  await tx.delete(schema.profiles).where(inArray(schema.profiles.id, family));
  return { profiles: family.length, identifiers: ids.length, consentRecords: consent.length };
}

export const eraseProfile = defineCommand({
  name: 'profiles.erase',
  title: 'Erase a person (erasure request)',
  description:
    'Permanently remove a person: profile and merged profiles, identifiers, consent ledger and events. Their encryption key is destroyed, so copies in backups become unreadable. Hashes of their e-mail and phone are kept on a suppression list so they are never contacted again.',
  input: z.object({ profileId: ProfileId, reason: z.string().min(1).max(500).describe('E.g. "Erasure request by e-mail on 2026-10-22"') }),
  output: z.object({ erasureId: z.string(), profiles: z.number(), identifiers: z.number(), consentRecords: z.number() }),
  permission: 'profiles:erase',
  effect: 'destructive',
  humansOnly: true,
  target: (i) => i.profileId,
  handler: async (input, ctx) => {
    const ws = ctx.principal.workspaceId;
    const p = await canonical(ctx, input.profileId);
    const family = await mergedFamily(ctx.tx, ws, p.id);
    const counts = await removeProfiles(ctx.tx, ws, family, ctx.services, { suppress: true });
    const erasureId = newId('era');
    await ctx.tx
      .insert(schema.erasures)
      .values({ workspaceId: ws, id: erasureId, profileIds: family, requestedBy: ctx.principal.userId, reason: input.reason, counts });
    return { erasureId, ...counts };
  },
});

export const profileCommands = [
  listProfiles,
  findProfile,
  getProfile,
  profileEvents,
  listPurposes,
  consentSummaryCommand,
  recordConsentCommand,
  consentHistory,
  topicPreferencesCommand,
  setTopicPreference,
  exportProfile,
  eraseProfile,
] as const;

/**
 * A person as message templates see them: traits and personal data merged, plus their e-mail
 * address, for the profile or the profile it was merged into. Null when there is no such person.
 */
export async function profileForMessage(
  tx: CommandContext['tx'],
  workspaceId: string,
  profileId: string,
  kp: CommandContext['services']['keyProvider'],
) {
  let id = profileId;
  for (let i = 0; i < 20; i++) {
    const [p] = await tx
      .select()
      .from(schema.profiles)
      .where(and(eq(schema.profiles.workspaceId, workspaceId), eq(schema.profiles.id, id)));
    if (!p) return null;
    if (p.mergedInto) {
      id = p.mergedInto;
      continue;
    }
    const crypto = personCrypto(tx, workspaceId, kp);
    const pii = (await crypto.open<Record<string, unknown>>(p.id, p.pii)) ?? {};
    const ids = await tx
      .select()
      .from(schema.identifiers)
      .where(and(eq(schema.identifiers.workspaceId, workspaceId), eq(schema.identifiers.profileId, p.id)));
    const sealedEmail = ids.find((i) => i.type === 'email');
    const email = sealedEmail ? await crypto.open<string>(p.id, sealedEmail.valueEnc) : undefined;
    const sealedPhone = ids.find((i) => i.type === 'phone');
    const phone = sealedPhone ? await crypto.open<string>(p.id, sealedPhone.valueEnc) : undefined;
    return {
      id: p.id,
      email: email ?? null,
      emailHash: sealedEmail?.value ?? null,
      phone: phone ?? null,
      phoneHash: sealedPhone?.value ?? null,
      userId: ids.find((i) => i.type === 'user_id')?.value ?? null,
      vars: { ...p.traits, ...pii, ...(email ? { email } : {}), id: p.id },
    };
  }
  return null;
}

import { DEFAULT_PURPOSES, type Purposes, publishedSingleton } from '@agentic-marketing/artifacts';
import {
  type ConsentSource,
  type ConsentStatus,
  schema,
  type TopicPreferenceSource,
  type TopicStatus,
  type Tx,
} from '@agentic-marketing/db';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';

// The consent and objection ledger (security-and-privacy.md §2). Records are append-only;
// consent_state is the latest record per purpose and channel, over a profile and every profile
// merged into it.

export interface ConsentInput {
  purpose: string;
  channel?: string;
  status: ConsentStatus;
  source: ConsentSource;
  proof?: Record<string, unknown>;
  messageId?: string;
  recordedBy?: string;
  recordedAt?: Date;
}

/** The profile and every profile merged into it, directly or through earlier merges. */
export async function mergedFamily(tx: Tx, workspaceId: string, profileId: string): Promise<string[]> {
  const res = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE fam(id) AS (
      SELECT ${profileId}::text
      UNION SELECT m.from_id FROM profile_merges m JOIN fam ON m.into_id = fam.id WHERE m.workspace_id = ${workspaceId}
    ) SELECT id FROM fam`);
  return res.rows.map((r) => r.id);
}

export function basisOf(purposes: Purposes, purpose: string) {
  return purposes.find((p) => p.key === purpose)?.basis ?? 'consent';
}

export async function recordConsent(tx: Tx, workspaceId: string, profileId: string, purposes: Purposes, records: ConsentInput[]) {
  if (!records.length) return 0;
  const inserted = await tx
    .insert(schema.consentRecords)
    .values(
      records.map((r) => ({
        workspaceId,
        profileId,
        purpose: r.purpose,
        channel: r.channel ?? '',
        status: r.status,
        basis: basisOf(purposes, r.purpose),
        source: r.source,
        proof: r.proof ?? {},
        messageId: r.messageId ?? null,
        recordedBy: r.recordedBy ?? null,
        recordedAt: r.recordedAt ?? new Date(),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.consentRecords.id });
  if (inserted.length) await recomputeConsentState(tx, workspaceId, profileId, purposes);
  return inserted.length;
}

export async function recomputeConsentState(tx: Tx, workspaceId: string, profileId: string, purposes?: Purposes) {
  const family = await mergedFamily(tx, workspaceId, profileId);
  await tx
    .delete(schema.consentState)
    .where(and(eq(schema.consentState.workspaceId, workspaceId), eq(schema.consentState.profileId, profileId)));
  await tx.execute(sql`
    INSERT INTO consent_state (workspace_id, profile_id, purpose, channel, status, basis, source, updated_at)
    SELECT DISTINCT ON (purpose, channel) workspace_id, ${profileId}, purpose, channel, status, basis, source, recorded_at
    FROM consent_records
    WHERE workspace_id = ${workspaceId} AND ${inArray(schema.consentRecords.profileId, family)}
    ORDER BY purpose, channel, recorded_at DESC, id DESC`);
  await exitRefusedJourneys(tx, workspaceId, profileId, purposes);
}

export async function consentStateOf(tx: Tx, workspaceId: string, profileId: string) {
  return tx
    .select()
    .from(schema.consentState)
    .where(and(eq(schema.consentState.workspaceId, workspaceId), eq(schema.consentState.profileId, profileId)));
}

// The current status of a purpose (docs/architecture/adr/0014-consent-channel-precedence.md).
// consent_state holds one row per purpose and channel: '' is "all channels" (forms, imports,
// the SDK), a named channel comes from that channel (an unsubscribe link writes 'email'). Every
// reader asks the same question through currentConsent (JS) or consentStatusSql (SQL):
//
// - For a channel C: the newest of the '' row and the C row.
// - Without a channel (segments, audience syncs, webhooks, AI): the '' row, unless a channel row
//   is at least as new as it; then a refusal on any channel wins over a grant, newest first.
//
// Equal timestamps resolve to the refusal. Without a channel, a channel-specific grant never
// lifts an all-channels refusal; it only counts for that channel's own sends.

export const REFUSALS: readonly ConsentStatus[] = ['withdrawn', 'objected', 'denied'];
const refusal = (s: string) => (REFUSALS as readonly string[]).includes(s);

export interface ConsentRow {
  purpose: string;
  channel: string;
  status: ConsentStatus;
  updatedAt: Date;
}

/** The row that decides a purpose's current status, for one channel or (without one) for the person. */
export function currentConsent<T extends ConsentRow>(rows: T[], purpose: string, channel?: string): T | undefined {
  const own = rows.filter((r) => r.purpose === purpose);
  const newest = (a: T, b: T) => b.updatedAt.getTime() - a.updatedAt.getTime();
  const refusalFirst = (a: T, b: T) => Number(refusal(b.status)) - Number(refusal(a.status));
  if (channel) return own.filter((r) => r.channel === '' || r.channel === channel).sort((a, b) => newest(a, b) || refusalFirst(a, b))[0];
  const all = own.find((r) => r.channel === '');
  return own
    .filter((r) => r.channel === '' || !all || r.updatedAt.getTime() >= all.updatedAt.getTime())
    .sort((a, b) => refusalFirst(a, b) || newest(a, b))[0];
}

/**
 * currentConsent as a scalar SQL subquery: the status (or NULL) for the person whose profile id
 * `profileId` evaluates to. Reads consent_state under the workspace's row policy.
 */
export function consentStatusSql(profileId: SQL, purpose: string, channel?: string): SQL {
  const isRefusal = sql`(c.status IN ('withdrawn', 'objected', 'denied'))`;
  if (channel)
    return sql`(SELECT c.status FROM consent_state c WHERE c.profile_id = ${profileId} AND c.purpose = ${purpose}
      AND c.channel IN ('', ${channel}) ORDER BY c.updated_at DESC, ${isRefusal} DESC LIMIT 1)`;
  return sql`(SELECT c.status FROM consent_state c WHERE c.profile_id = ${profileId} AND c.purpose = ${purpose}
      AND (c.channel = '' OR c.updated_at >= coalesce((SELECT a.updated_at FROM consent_state a
        WHERE a.profile_id = c.profile_id AND a.purpose = c.purpose AND a.channel = ''), '-infinity'::timestamptz))
    ORDER BY ${isRefusal} DESC, c.updated_at DESC LIMIT 1)`;
}

/**
 * The purposes a person has refused: the current status without a channel is a refusal and the
 * purpose's basis stops on it (consent, legitimate interest). Contract and legal obligation don't.
 * Not having consented yet (e.g. a pending double opt-in) is not a refusal.
 */
export function refusedPurposes<T extends ConsentRow>(rows: T[], purposes: Purposes): string[] {
  return [...new Set(rows.map((r) => r.purpose))].filter((purpose) => {
    const status = currentConsent(rows, purpose)?.status;
    return !!status && refusal(status) && !purposeAllowed(basisOf(purposes, purpose), status as ConsentStatus);
  });
}

/**
 * Exits the person's active journey participants whose journey purpose they refused (#108), so
 * no later step runs and the journey stops counting them. The journey sweeper checks the same
 * rule before every step, for anything that changes consent without passing here.
 */
export async function exitRefusedJourneys(tx: Tx, workspaceId: string, profileId: string, purposes?: Purposes) {
  const rows = await consentStateOf(tx, workspaceId, profileId);
  if (!rows.some((r) => refusal(r.status))) return 0;
  const all = purposes ?? (await publishedSingleton(tx, 'purposes'))?.purposes ?? DEFAULT_PURPOSES;
  const refused = refusedPurposes(rows, all);
  if (!refused.length) return 0;
  const res = await tx.execute(sql`
    UPDATE journey_participants p
    SET status = 'exited', error = 'consent_withdrawn: ' || (v.content->>'purpose'), due_at = NULL, waiting_event = NULL,
      updated_at = now()
    FROM artifact_versions v
    WHERE p.workspace_id = ${workspaceId} AND p.profile_id = ${profileId} AND p.status IN ('ready', 'waiting')
      AND v.workspace_id = p.workspace_id AND v.artifact_id = p.journey_id AND v.number = p.version
      AND v.content->>'purpose' IN (${sql.join(
        refused.map((r) => sql`${r}`),
        sql`, `,
      )})`);
  return res.rowCount ?? 0;
}

/** purposeAllowed in SQL, over a status expression such as consentStatusSql (never NULL). */
export function purposeAllowedSql(basis: string, status: SQL): SQL {
  if (basis === 'consent') return sql`coalesce(${status} = 'granted', false)`;
  if (basis === 'legitimate_interest') return sql`coalesce(${status} NOT IN ('withdrawn', 'objected', 'denied'), true)`;
  return sql`true`;
}

/**
 * Whether processing for a purpose is allowed for a person: consent needs a current "granted";
 * legitimate interest holds unless they objected or withdrew; contract and legal obligation hold.
 */
export function purposeAllowed(basis: string, status: ConsentStatus | undefined): boolean {
  if (basis === 'consent') return status === 'granted';
  if (basis === 'legitimate_interest') return status !== 'objected' && status !== 'withdrawn' && status !== 'denied';
  return true;
}

export interface ConsentCounts {
  granted: number;
  denied: number;
  withdrawn: number;
  objected: number;
}

const EMPTY_COUNTS = (): ConsentCounts => ({ granted: 0, denied: 0, withdrawn: 0, objected: 0 });

export interface PurposeConsentSummary extends ConsentCounts {
  purpose: string;
  /** Named channels that have rows for this purpose; `channel` is never ''. */
  channels: ({ channel: string } & ConsentCounts)[];
}

/**
 * How many people currently allow or refuse each purpose (and each named channel that has rows),
 * with the same rule as sends and segments. One query per rule, never one per person.
 */
export async function consentSummary(tx: Tx, workspaceId: string, purposeKeys: string[]): Promise<PurposeConsentSummary[]> {
  const overall = await tx.execute<{ purpose: string; status: ConsentStatus; n: number }>(sql`
    WITH winner AS (
      SELECT DISTINCT ON (c.profile_id, c.purpose) c.purpose, c.status
      FROM consent_state c
      WHERE c.workspace_id = ${workspaceId}
        AND (c.channel = '' OR c.updated_at >= coalesce((
          SELECT a.updated_at FROM consent_state a
          WHERE a.workspace_id = c.workspace_id AND a.profile_id = c.profile_id AND a.purpose = c.purpose AND a.channel = ''
        ), '-infinity'::timestamptz))
      ORDER BY c.profile_id, c.purpose, (c.status IN ('withdrawn', 'objected', 'denied')) DESC, c.updated_at DESC
    )
    SELECT purpose, status, count(*)::int AS n FROM winner GROUP BY purpose, status`);
  const perChannel = await tx.execute<{ channel: string; purpose: string; status: ConsentStatus; n: number }>(sql`
    WITH ch AS (
      SELECT DISTINCT channel FROM consent_state WHERE workspace_id = ${workspaceId} AND channel <> ''
    ), winner AS (
      SELECT ch.channel, c.purpose, c.status, row_number() OVER (
        PARTITION BY ch.channel, c.profile_id, c.purpose
        ORDER BY c.updated_at DESC, (c.status IN ('withdrawn', 'objected', 'denied')) DESC) AS rn
      FROM ch CROSS JOIN consent_state c
      WHERE c.workspace_id = ${workspaceId} AND c.channel IN ('', ch.channel)
    )
    SELECT channel, purpose, status, count(*)::int AS n FROM winner WHERE rn = 1 GROUP BY channel, purpose, status`);

  const summary = new Map(
    purposeKeys.map((purpose) => [purpose, { purpose, ...EMPTY_COUNTS(), channels: [] as PurposeConsentSummary['channels'] }]),
  );
  for (const row of overall.rows) {
    const s = summary.get(row.purpose);
    if (s) s[row.status] += Number(row.n);
  }
  for (const row of perChannel.rows) {
    const s = summary.get(row.purpose);
    if (!s) continue;
    let channel = s.channels.find((c) => c.channel === row.channel);
    if (!channel) {
      channel = { channel: row.channel, ...EMPTY_COUNTS() };
      s.channels.push(channel);
    }
    channel[row.status] += Number(row.n);
  }
  for (const s of summary.values()) s.channels.sort((a, b) => a.channel.localeCompare(b.channel));
  return [...summary.values()];
}

// Topics are finer choices within a purpose (#84). They never replace consent: a purpose still
// needs its lawful basis, and a topic choice only decides which of its messages reach the person.

export type TopicDefinition = Purposes[number]['topics'][number];

/** The purpose and topic a key belongs to, or undefined when no purpose defines it. */
export function findTopic(purposes: Purposes, key: string): { purpose: Purposes[number]; topic: TopicDefinition } | undefined {
  for (const purpose of purposes) for (const topic of purpose.topics ?? []) if (topic.key === key) return { purpose, topic };
  return undefined;
}

export interface TopicChoiceRow {
  topic: string;
  status: TopicStatus;
  source?: TopicPreferenceSource;
  updatedAt?: Date;
}

/** The person's choice when they made one, otherwise the topic's default. */
export function effectiveTopicStatus(rows: TopicChoiceRow[], topic: { key: string; default: TopicStatus }): TopicStatus {
  return rows.find((r) => r.topic === topic.key)?.status ?? topic.default;
}

export async function topicChoicesOf(tx: Tx, workspaceId: string, profileId: string): Promise<TopicChoiceRow[]> {
  return tx
    .select({
      topic: schema.topicPreferences.topic,
      status: schema.topicPreferences.status,
      source: schema.topicPreferences.source,
      updatedAt: schema.topicPreferences.updatedAt,
    })
    .from(schema.topicPreferences)
    .where(and(eq(schema.topicPreferences.workspaceId, workspaceId), eq(schema.topicPreferences.profileId, profileId)));
}

/** The topic status as a boolean SQL predicate over the profile whose id `profileId` evaluates to. */
export function topicSubscribedSql(profileId: SQL, topic: string, defaultStatus: TopicStatus): SQL {
  return sql`(coalesce((SELECT tp.status FROM topic_preferences tp
    WHERE tp.profile_id = ${profileId} AND tp.topic = ${topic}), ${defaultStatus}) = 'subscribed')`;
}

export interface TopicSummary {
  purpose: string;
  topic: string;
  subscribed: number;
  unsubscribed: number;
}

/**
 * How many active people currently subscribe to each topic, counting the topic's default for
 * people with no choice. One query, like consentSummary.
 */
export async function topicSummary(tx: Tx, workspaceId: string, purposes: Purposes): Promise<TopicSummary[]> {
  const definitions = purposes.flatMap((p) => (p.topics ?? []).map((t) => ({ purpose: p.key, topic: t.key, default: t.default })));
  if (!definitions.length) return [];
  const [{ n: total }] = (
    await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM profiles WHERE workspace_id = ${workspaceId} AND merged_into IS NULL`,
    )
  ).rows;
  const rows = await tx.execute<{ topic: string; status: TopicStatus; n: number }>(sql`
    SELECT topic, status, count(*)::int AS n FROM topic_preferences
    WHERE workspace_id = ${workspaceId} GROUP BY topic, status`);
  const counts = new Map<string, { subscribed: number; unsubscribed: number }>();
  for (const row of rows.rows) {
    const c = counts.get(row.topic) ?? { subscribed: 0, unsubscribed: 0 };
    c[row.status] += Number(row.n);
    counts.set(row.topic, c);
  }
  return definitions.map((d) => {
    const c = counts.get(d.topic) ?? { subscribed: 0, unsubscribed: 0 };
    if (d.default === 'subscribed')
      return { purpose: d.purpose, topic: d.topic, subscribed: Math.max(0, total - c.unsubscribed), unsubscribed: c.unsubscribed };
    return { purpose: d.purpose, topic: d.topic, subscribed: c.subscribed, unsubscribed: Math.max(0, total - c.subscribed) };
  });
}

/** Records one topic choice and appends the evidence. Returns whether the current status changed. */
export async function recordTopicPreference(
  tx: Tx,
  workspaceId: string,
  profileId: string,
  purpose: string,
  topic: string,
  status: TopicStatus,
  source: TopicPreferenceSource,
  opts: { note?: string; proof?: Record<string, unknown>; recordedBy?: string } = {},
) {
  const [current] = await tx
    .select({ status: schema.topicPreferences.status })
    .from(schema.topicPreferences)
    .where(
      and(
        eq(schema.topicPreferences.workspaceId, workspaceId),
        eq(schema.topicPreferences.profileId, profileId),
        eq(schema.topicPreferences.topic, topic),
      ),
    );
  await tx
    .insert(schema.topicPreferences)
    .values({ workspaceId, profileId, topic, status, source, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.topicPreferences.workspaceId, schema.topicPreferences.profileId, schema.topicPreferences.topic],
      set: { status, source, updatedAt: new Date() },
    });
  await tx.insert(schema.topicPreferenceHistory).values({
    workspaceId,
    profileId,
    topic,
    purpose,
    status,
    source,
    note: opts.note ?? null,
    proof: opts.proof ?? {},
    recordedBy: opts.recordedBy ?? null,
  });
  return current?.status !== status;
}

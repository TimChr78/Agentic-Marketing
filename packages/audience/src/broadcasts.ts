import { createHash } from 'node:crypto';
import {
  artifactTypes,
  assignHoldout,
  type BroadcastDefinition,
  type EmailTemplate,
  holdoutDetail,
  holdoutParticipantId,
  publishValidators,
  type SendWindowDefinition,
} from '@agentic-marketing/artifacts';
import { campaignWithControlForMember } from '@agentic-marketing/campaigns';
import { defineCommand } from '@agentic-marketing/commands';
import { AppError, newId } from '@agentic-marketing/core';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import {
  checkPushRecipient,
  checkRecipient,
  checkSmsRecipient,
  type Decision,
  deliveryPolicy,
  type EmailRequest,
  requestEmail,
  requestPush,
  requestSms,
  sendTestMessages,
  testRecipientsInput,
  testSendOutput,
  topicProblems,
  validateSubject,
} from '@agentic-marketing/email';
import type { EventStore, JourneyEvent } from '@agentic-marketing/events';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';

// Broadcasts: a one-off send of a template to a segment, e.g. the weekly newsletter. Publishing
// the artifact (after approval, when the workspace's policy wants one) schedules a run; the
// scheduler works through the segment's members and asks the send gateway for each, so consent,
// suppressions and unsubscribes apply per person. Sends are keyed by (broadcast, person). A
// broadcast sends once: publishing a later version after its run changes nothing. Two optional
// phases sit on top: a subject test sends variants to a sample and then the winner to the rest,
// and a send window holds each message until the next opening in the reader's own time zone.

const BroadcastId = z.string().regex(/^bct_[0-9a-f]{32}$/);
const BATCH = 200;
const LEASE_MS = 120_000;
// A variant needs this many sends before its rate means anything; below it the test has no winner.
const MIN_VARIANT_SENDS = 20;

/** Seconds in the small ISO durations broadcasts accept (P1W, P2D, PT4H, PT30M). */
function durationSeconds(iso: string): number {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 604_800 + Number(m[2] ?? 0) * 86_400 + Number(m[3] ?? 0) * 3_600 + Number(m[4] ?? 0) * 60;
}

/**
 * Which subject a person gets in a broadcast test, or null when they are not in the sample.
 * One stable hash of profile + broadcast: a retry, a resume after a crash, or a later recompute
 * always assigns the same person the same variant, and the sample is spread evenly by the modulo.
 */
export function subjectAssignment(profileId: string, broadcastId: string, samplePercent: number, variants: number): string | null {
  if (variants < 1) return null;
  const h = createHash('sha256').update(`${profileId}:${broadcastId}`).digest().readUInt32BE(0);
  return h % 100 < samplePercent ? String.fromCharCode(65 + (h % variants)) : null;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

interface LocalTime {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

/** Wall-clock parts of an instant in a time zone (no dependency: Intl has the zone data). */
function localParts(at: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
}

const weekdayOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** The UTC instant of a wall-clock time in a zone, by correcting a UTC guess with Intl's offset. */
function zonedInstant(y: number, m: number, d: number, h: number, min: number, timeZone: string): Date {
  const wanted = Date.UTC(y, m - 1, d, h, min);
  let ts = wanted;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(ts), timeZone);
    const actual = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    if (actual === wanted) break;
    ts += wanted - actual;
  }
  return new Date(ts);
}

function insideWindow(now: LocalTime, window: SendWindowDefinition): boolean {
  const t = now.h * 60 + now.min;
  const [s, e] = [minutesOf(window.start), minutesOf(window.end)];
  const today = WEEKDAYS[weekdayOf(now.y, now.m, now.d)];
  const allowed = !window.days || window.days.includes(today);
  if (s === e) return allowed;
  if (s < e) return allowed && t >= s && t < e;
  // A window that crosses midnight: the after-midnight part belongs to the previous day.
  const previous = WEEKDAYS[(weekdayOf(now.y, now.m, now.d) + 6) % 7];
  const previousAllowed = !window.days || window.days.includes(previous);
  return (allowed && t >= s) || (previousAllowed && t < e);
}

function nextOpening(now: Date, window: SendWindowDefinition, timeZone: string): Date | null {
  const p = localParts(now, timeZone);
  const today = Date.UTC(p.y, p.m - 1, p.d);
  const [s, sm] = [Number(window.start.slice(0, 2)), Number(window.start.slice(3))];
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(today + offset * 86_400_000);
    if (window.days && !window.days.includes(WEEKDAYS[day.getUTCDay()])) continue;
    const at = zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), s, sm, timeZone);
    if (at.getTime() > now.getTime()) return at;
  }
  return null;
}

/**
 * When a send window holds a message: the next opening, or a skip when that is beyond
 * sendAt + maxDelay. Inside the window there is no hold.
 */
export function sendWindowHold(
  now: Date,
  window: SendWindowDefinition,
  timeZone: string,
  anchor: Date,
  maxDelaySeconds: number,
): { next: Date | null; skip: boolean } {
  if (insideWindow(localParts(now, timeZone), window)) return { next: null, skip: false };
  const next = nextOpening(now, window, timeZone);
  if (!next) return { next: null, skip: true };
  return { next, skip: next.getTime() > anchor.getTime() + maxDelaySeconds * 1000 };
}

const validZone = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** The request shape all three channels share; subject tests only reach the e-mail path. */
type BroadcastRequest = EmailRequest;
type RequestFor = (tx: Tx, ws: string, kp: KeyProvider, events: EventStore, req: BroadcastRequest) => Promise<Decision>;

async function published(tx: Tx, id: string, type: 'email_template' | 'sms_template' | 'push_template' | 'segment') {
  const [a] = await tx
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.id, id), eq(schema.artifacts.type, type), isNotNull(schema.artifacts.publishedVersion)));
  return !!a;
}

publishValidators.set('broadcast', async (content, tx: Tx) => {
  const b = content as BroadcastDefinition;
  const problems: string[] = [];
  const [type, label] = channelOf(b.template);
  if (!(await published(tx, b.template, type))) problems.push(`${b.template} is not a published ${label} template`);
  else if (b.topic) {
    const meta = await purposeOf(tx, b.template);
    if (meta) problems.push(...(await topicProblems(tx, meta.purpose, b.topic)));
  }
  if (!(await published(tx, b.segment, 'segment'))) problems.push(`${b.segment} is not a published segment`);
  if (b.subjectTest) {
    if (!b.template.startsWith('eml_')) problems.push('A subject test needs an e-mail template');
    for (const [i, subject] of b.subjectTest.subjects.entries()) {
      const bad = validateSubject(subject);
      if (bad) problems.push(`subjectTest.subjects[${i}]: ${bad}`);
    }
  }
  return problems;
});

const channelOf = (template: string) =>
  template.startsWith('sms_')
    ? (['sms_template', 'SMS'] as const)
    : template.startsWith('psh_')
      ? (['push_template', 'push'] as const)
      : (['email_template', 'e-mail'] as const);
const requestFor = (template: string) =>
  (template.startsWith('sms_') ? requestSms : template.startsWith('psh_') ? requestPush : requestEmail) as RequestFor;
const checkFor = (template: string) =>
  template.startsWith('sms_') ? checkSmsRecipient : template.startsWith('psh_') ? checkPushRecipient : checkRecipient;

async function definition(tx: Tx, id: string, version?: number) {
  const [a] = await tx
    .select()
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.id, id), eq(schema.artifacts.type, 'broadcast')));
  if (!a) throw new AppError('not_found', `No broadcast ${id}.`);
  const number = version ?? a.publishedVersion ?? a.latestVersion;
  const [v] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, id), eq(schema.artifactVersions.number, number)));
  return { artifact: a, version: number, def: artifactTypes.broadcast.content.parse(v.content) as BroadcastDefinition };
}

/**
 * Reach of publishing a broadcast version, for the agent policy engine (ADR-0016): the size of its
 * segment now. An upper bound: consent, suppression, topics and frequency caps remove some.
 */
export async function broadcastImpact(tx: Tx, artifactId: string, version: number) {
  const { def } = await definition(tx, artifactId, version);
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.segmentMemberships)
    .where(eq(schema.segmentMemberships.segmentId, def.segment));
  // The template may be unpublished (reviewed in the same bundle): fall back to its latest version.
  const [tpl] = await tx.select({ latest: schema.artifacts.latestVersion }).from(schema.artifacts).where(eq(schema.artifacts.id, def.template));
  const meta = (await purposeOf(tx, def.template)) ?? (tpl ? await purposeOf(tx, def.template, tpl.latest) : undefined);
  const topic = def.topic ?? meta?.topic ?? null;
  const channel = def.template.startsWith('sms_') ? 'sms' : def.template.startsWith('psh_') ? 'push' : 'email';
  return {
    people: n,
    reversible: false,
    summary: `broadcast to ${def.segment}: ${n.toLocaleString('en-US')} people before consent and suppression`,
    touches: {
      segments: [def.segment],
      ...(meta?.purpose ? { purposes: [meta.purpose] } : {}),
      ...(topic ? { topics: [topic] } : {}),
      channels: [channel],
    },
  };
}

/** The template's purpose and topic: of its published version, or of `version` (a template reviewed in the same bundle, #107). */
async function purposeOf(tx: Tx, templateId: string, version?: number) {
  const [row] = await tx
    .select({
      purpose: sql<string>`${schema.artifactVersions.content} ->> 'purpose'`,
      topic: sql<string | null>`${schema.artifactVersions.content} ->> 'topic'`,
    })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        version === undefined
          ? eq(schema.artifactVersions.number, schema.artifacts.publishedVersion)
          : eq(schema.artifactVersions.number, version),
      ),
    )
    .where(eq(schema.artifacts.id, templateId));
  return row ? { purpose: row.purpose, topic: row.topic } : null;
}

/** The published version and purpose of a template, for recording a control-group suppression. */
async function publishedTemplateInfo(tx: Tx, templateId: string): Promise<{ version: number; purpose: string }> {
  const [row] = await tx
    .select({
      version: schema.artifacts.publishedVersion,
      purpose: sql<string | null>`${schema.artifactVersions.content} ->> 'purpose'`,
    })
    .from(schema.artifacts)
    .innerJoin(
      schema.artifactVersions,
      and(
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.number, schema.artifacts.publishedVersion),
      ),
    )
    .where(eq(schema.artifacts.id, templateId));
  return { version: row?.version ?? 0, purpose: row?.purpose ?? 'unknown' };
}

/**
 * Records a broadcast message that was not sent because the person is in the campaign's control
 * group. It is a suppression, like consent or a send window, not a failure: the message log and
 * ClickHouse keep it with the reason, and the run counts it as skipped.
 */
async function suppressForControl(
  tx: Tx,
  deps: BroadcastDeps,
  ws: string,
  broadcastId: string,
  def: BroadcastDefinition,
  info: { version: number; purpose: string },
  profileId: string,
  variant: string | undefined,
  campaignId: string,
): Promise<void> {
  const channel = def.template.startsWith('sms_') ? 'sms' : def.template.startsWith('psh_') ? 'push' : 'email';
  const reason = `holdout_control: campaign ${campaignId} holds this person out of every sending member`;
  const [m] = await tx
    .insert(schema.messages)
    .values({
      workspaceId: ws,
      id: newId('msg'),
      idempotencyKey: `bct:${broadcastId}:${profileId}`,
      channel,
      profileId,
      purpose: info.purpose,
      templateId: def.template,
      templateVersion: info.version,
      journeyId: broadcastId,
      status: 'suppressed',
      reason,
      variant: variant ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.messages.id });
  if (!m) return;
  // Same shape as the gateway's decision event, so reports see one suppressed message per person.
  await deps.events.insertMessageEvents([
    {
      workspaceId: ws,
      messageId: m.id,
      eventId: 'decision:suppressed:holdout',
      type: 'suppressed',
      at: new Date().toISOString(),
      profileId,
      channel,
      purpose: info.purpose,
      provider: '',
      templateId: def.template,
      templateVersion: info.version,
      journeyId: broadcastId,
      variant: variant ?? '',
      reason,
      url: '',
    },
  ]);
}

export const previewBroadcast = defineCommand({
  name: 'broadcasts.preview',
  title: 'Preview a broadcast’s audience',
  description:
    'Who a broadcast (default: its latest version) would reach right now: the segment size and, for up to 2,000 members, how many the send gateway would send to and why it would skip the others (no consent, suppressed, no address). Sends nothing.',
  input: z.object({
    artifactId: BroadcastId,
    version: z.number().int().min(1).optional(),
    templateVersion: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "The template version to assume, e.g. the one reviewed in the same approval bundle; default: the template's published version",
      ),
  }),
  output: z.object({
    audience: z.number(),
    checked: z.number(),
    wouldSend: z.number(),
    wouldSkip: z.record(z.string(), z.number()).describe('Reason → people'),
    sendAt: z.string().nullable(),
    sendWindow: z
      .object({
        start: z.string(),
        end: z.string(),
        days: z.array(z.string()).optional(),
        maxDelay: z.string(),
      })
      .nullable()
      .describe('Each reader is only sent to inside this window in their own time zone'),
    subjectTest: z
      .object({
        subjects: z.array(z.string()),
        samplePercent: z.number(),
        metric: z.enum(['click', 'open']),
        decideAfter: z.string(),
      })
      .nullable()
      .describe('Subject variants A–D, tried on a sample before the winner goes to the rest'),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const { def } = await definition(ctx.tx, input.artifactId, input.version);
    const templateMeta = await purposeOf(ctx.tx, def.template, input.templateVersion);
    const purpose = templateMeta?.purpose;
    if (!purpose)
      throw new AppError(
        'conflict',
        input.templateVersion
          ? `${def.template} has no version ${input.templateVersion}.`
          : `${def.template} has no published version yet; pass templateVersion to preview with a draft.`,
      );
    const topic = def.topic ?? templateMeta.topic ?? null;
    const [{ n }] = await ctx.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.segmentMemberships)
      .where(eq(schema.segmentMemberships.segmentId, def.segment));
    const members = await ctx.tx
      .select({ profileId: schema.segmentMemberships.profileId })
      .from(schema.segmentMemberships)
      .where(eq(schema.segmentMemberships.segmentId, def.segment))
      .limit(2000);
    let wouldSend = 0;
    const wouldSkip: Record<string, number> = {};
    for (const m of members) {
      const v = await checkFor(def.template)(ctx.tx, ctx.principal.workspaceId, ctx.services.keyProvider, m.profileId, purpose, topic);
      if (v.ok) wouldSend++;
      else {
        const reason = v.reason.split(':')[0];
        wouldSkip[reason] = (wouldSkip[reason] ?? 0) + 1;
      }
    }
    return {
      audience: n,
      checked: members.length,
      wouldSend,
      wouldSkip,
      sendAt: def.sendAt ?? null,
      sendWindow: def.sendWindow ?? null,
      subjectTest: def.subjectTest ?? null,
    };
  },
});

export const sendTestBroadcast = defineCommand({
  name: 'broadcasts.sendTest',
  title: 'Send a test broadcast',
  description:
    'Send a broadcast’s e-mail to members of this workspace or the admin-configured seed list (workspace.setSeedList), at most 10 per call, with "[Test]" in the subject. Uses the broadcast version you name (default: its latest draft), and the template version the broadcast would send (the template’s published version, or its latest draft while it has none) through the marketing provider. Purpose/consent checks are skipped, suppressions still apply, and each copy is recorded as a test message (never counted in reporting) and an audit entry. No profile or consent is written; agents drafting newsletters can run it with the artifacts:write scope. Approvers may run it without `to`, sending to themselves only.',
  input: z.object({
    artifactId: BroadcastId,
    version: z.number().int().min(1).optional().describe('Default: the latest draft, else the latest version'),
    templateVersion: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "The template version to send, e.g. the one reviewed in the same approval bundle; default: the template's published version, else its latest",
      ),
    to: testRecipientsInput,
  }),
  output: testSendOutput,
  permission: 'artifacts:write',
  // Same self-service rule as templates.sendTest: an approver may only test to their own address.
  selfService: { permission: 'artifacts:approve', allows: (input) => input.to === undefined },
  effect: 'write',
  actionClass: 'draft',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const [artifact] = await ctx.tx
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.id, input.artifactId), eq(schema.artifacts.type, 'broadcast')));
    if (!artifact) throw new AppError('not_found', `No broadcast ${input.artifactId}.`);
    let version: number;
    if (input.version) version = input.version;
    else {
      const [draft] = await ctx.tx
        .select({ number: schema.artifactVersions.number })
        .from(schema.artifactVersions)
        .where(and(eq(schema.artifactVersions.artifactId, input.artifactId), eq(schema.artifactVersions.state, 'draft')))
        .orderBy(desc(schema.artifactVersions.number))
        .limit(1);
      version = draft?.number ?? artifact.latestVersion;
    }
    const [bv] = await ctx.tx
      .select({ content: schema.artifactVersions.content })
      .from(schema.artifactVersions)
      .where(and(eq(schema.artifactVersions.artifactId, input.artifactId), eq(schema.artifactVersions.number, version)));
    if (!bv) throw new AppError('not_found', `No broadcast ${input.artifactId} version ${version}.`);
    const def = artifactTypes.broadcast.content.parse(bv.content) as BroadcastDefinition;
    if (!def.template.startsWith('eml_'))
      throw new AppError('invalid_input', 'broadcasts.sendTest sends e-mail only; this broadcast uses an SMS or push template.');

    // A real broadcast sends the template's published version. Before the first approval round
    // there is none yet, so a test uses the template's latest version (its draft).
    const [template] = await ctx.tx
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.id, def.template), eq(schema.artifacts.type, 'email_template')));
    if (!template) throw new AppError('not_found', `No e-mail template ${def.template}.`);
    const templateVersion = input.templateVersion ?? template.publishedVersion ?? template.latestVersion;
    const [tv] = await ctx.tx
      .select({ content: schema.artifactVersions.content })
      .from(schema.artifactVersions)
      .where(and(eq(schema.artifactVersions.artifactId, def.template), eq(schema.artifactVersions.number, templateVersion)));
    if (!tv) throw new AppError('conflict', `Version ${templateVersion} of ${def.template} is missing.`);
    const t = tv.content as EmailTemplate;
    return sendTestMessages(ctx, {
      templateId: def.template,
      templateVersion,
      template: t,
      purpose: t.purpose,
      stream: 'marketing',
      journeyId: input.artifactId,
      to: input.to,
    });
  },
});

interface VariantResult {
  variant: string;
  subject: string;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
}

/** Per-variant sends and events for a broadcast. Opens are counted because a provider may report them. */
async function variantResults(
  tx: Tx,
  events: EventStore,
  workspaceId: string,
  broadcastId: string,
  subjects: string[],
): Promise<VariantResult[]> {
  const rows = await tx
    .select({ id: schema.messages.id, variant: schema.messages.variant, status: schema.messages.status })
    .from(schema.messages)
    .where(and(eq(schema.messages.journeyId, broadcastId), isNotNull(schema.messages.variant)));
  const delivered = new Map<string, Set<string>>();
  const opened = new Map<string, Set<string>>();
  const clicked = new Map<string, Set<string>>();
  if (rows.length) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const evts = await events.messageEventsOf(workspaceId, { messageIds: rows.map((r) => r.id) }, 100_000);
    for (const e of evts) {
      const variant = byId.get(e.messageId)?.variant;
      if (!variant) continue;
      const target = e.type === 'delivered' ? delivered : e.type === 'opened' ? opened : e.type === 'clicked' ? clicked : null;
      if (!target) continue;
      const set = target.get(variant) ?? new Set<string>();
      set.add(e.messageId);
      target.set(variant, set);
    }
  }
  return subjects.map((subject, i) => {
    const variant = String.fromCharCode(65 + i);
    const mine = rows.filter((r) => r.variant === variant);
    const deliveredNow = mine.filter((r) => r.status === 'delivered');
    return {
      variant,
      subject,
      sent: mine.filter((r) => ['sent', 'delivered', 'bounced', 'complained'].includes(r.status)).length,
      delivered: new Set([...deliveredNow.map((r) => r.id), ...(delivered.get(variant) ?? [])]).size,
      opened: opened.get(variant)?.size ?? 0,
      clicked: clicked.get(variant)?.size ?? 0,
    };
  });
}

/** The winner by the test's metric; ties and too little data go to A, the control. */
function pickWinner(metric: 'click' | 'open', variants: VariantResult[]): { winner: string; reason: string } {
  const value = (v: VariantResult) => (metric === 'click' ? v.clicked : v.opened);
  if (variants.some((v) => v.sent < MIN_VARIANT_SENDS)) return { winner: 'A', reason: 'no clear winner: fewer than 20 sends in a variant' };
  const total = variants.reduce((n, v) => n + value(v), 0);
  if (!total) return { winner: 'A', reason: `no clear winner: no ${metric} events` };
  const ranked = [...variants].sort((a, b) => value(b) - value(a));
  if (value(ranked[0]) === value(ranked[1])) return { winner: 'A', reason: `no clear winner: tie on ${metric} (${value(ranked[0])})` };
  return { winner: ranked[0].variant, reason: `${ranked[0].variant} won on ${metric}: ${value(ranked[0])} vs ${value(ranked[1])}` };
}

const Run = z.object({
  status: z.enum(['not_scheduled', 'scheduled', 'running', 'done', 'cancelled', 'failed']),
  version: z.number().nullable(),
  sendAt: z.string().nullable(),
  recipients: z.number(),
  queued: z.number(),
  skipped: z.number(),
  windowSkipped: z.number().describe('Skipped because their next send-window opening was beyond maxDelay'),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
});

const Test = z.object({
  state: z.enum(['sampling', 'deciding', 'winner_sent']),
  metric: z.enum(['click', 'open']),
  samplePercent: z.number(),
  decideAfter: z.string(),
  decideAt: z.string().nullable().describe('When the sample is judged and the winner goes out'),
  decidedAt: z.string().nullable(),
  restAt: z.string().nullable().describe('When the rest of the audience gets the winner'),
  winner: z.string().nullable(),
  reason: z.string().nullable().describe('Why this winner, or why there was no clear winner'),
  variants: z.array(
    z.object({
      variant: z.string(),
      subject: z.string(),
      sent: z.number(),
      delivered: z.number(),
      opened: z.number(),
      clicked: z.number(),
      clickRate: z.number().nullable().describe('Percent of sent messages with a click'),
      openRate: z.number().nullable(),
    }),
  ),
});

export const broadcastStatus = defineCommand({
  name: 'broadcasts.status',
  title: 'Broadcast status and results',
  description:
    'Where a broadcast is (scheduled, running, done, cancelled) with how many people it reached and skipped, and what became of the e-mails: sent, delivered, bounced, complained, clicked, unsubscribed. A subject test reports its state, the variants with counts and rates, the winner and when the rest goes out.',
  input: z.object({ artifactId: BroadcastId }),
  output: z.object({ run: Run, messages: z.record(z.string(), z.number()), test: Test.nullable() }),
  permission: 'artifacts:read',
  effect: 'read',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const [r] = await ctx.tx.select().from(schema.broadcastRuns).where(eq(schema.broadcastRuns.broadcastId, input.artifactId));
    const { def } = await definition(ctx.tx, input.artifactId, r?.version);
    const [t] = await ctx.tx.select().from(schema.broadcastTests).where(eq(schema.broadcastTests.broadcastId, input.artifactId));
    const messages = r
      ? await ctx.services.events.messageStats(ctx.principal.workspaceId, { since: r.createdAt, journeyId: input.artifactId })
      : {};
    let test: z.output<typeof Test> | null = null;
    if (t) {
      const variants = await variantResults(ctx.tx, ctx.services.events, ctx.principal.workspaceId, input.artifactId, t.subjects);
      const rate = (n: number, sent: number) => (sent ? Math.round((n / sent) * 10_000) / 100 : null);
      test = {
        state: t.state,
        metric: t.metric,
        samplePercent: t.samplePercent,
        decideAfter: def.subjectTest?.decideAfter ?? 'PT4H',
        decideAt: t.decideAt?.toISOString() ?? null,
        decidedAt: t.decidedAt?.toISOString() ?? null,
        restAt: t.state === 'winner_sent' ? (t.decidedAt?.toISOString() ?? null) : (t.decideAt?.toISOString() ?? null),
        winner: t.winner,
        reason: t.reason,
        variants: variants.map((v) => ({
          ...v,
          clickRate: rate(v.clicked, v.sent),
          openRate: rate(v.opened, v.sent),
        })),
      };
    }
    return {
      run: {
        status: r?.status ?? 'not_scheduled',
        version: r?.version ?? null,
        sendAt: r?.sendAt.toISOString() ?? null,
        recipients: r?.recipients ?? 0,
        queued: r?.queued ?? 0,
        skipped: r?.skipped ?? 0,
        windowSkipped: r?.windowSkipped ?? 0,
        startedAt: r?.startedAt?.toISOString() ?? null,
        finishedAt: r?.finishedAt?.toISOString() ?? null,
        error: r?.error ?? null,
      },
      messages,
      test,
    };
  },
});

export const cancelBroadcast = defineCommand({
  name: 'broadcasts.cancel',
  title: 'Cancel a broadcast',
  description: 'Stop a scheduled or running broadcast. People already sent to keep their e-mail; nobody else gets it. Cannot be undone.',
  input: z.object({ artifactId: BroadcastId }),
  output: z.object({ status: z.literal('cancelled'), queued: z.number() }),
  permission: 'messages:send',
  effect: 'write',
  actionClass: 'draft',
  target: (i) => i.artifactId,
  handler: async (input, ctx) => {
    const { artifact, version, def } = await definition(ctx.tx, input.artifactId);
    const [r] = await ctx.tx
      .select()
      .from(schema.broadcastRuns)
      .where(eq(schema.broadcastRuns.broadcastId, input.artifactId))
      .for('update');
    if (r && !['scheduled', 'running'].includes(r.status)) throw new AppError('conflict', `The broadcast is already ${r.status}.`);
    if (r)
      await ctx.tx
        .update(schema.broadcastRuns)
        .set({ status: 'cancelled', finishedAt: new Date(), leaseUntil: null })
        .where(eq(schema.broadcastRuns.broadcastId, input.artifactId));
    else
      await ctx.tx.insert(schema.broadcastRuns).values({
        workspaceId: ctx.principal.workspaceId,
        broadcastId: artifact.id,
        version,
        status: 'cancelled',
        sendAt: def.sendAt ? new Date(def.sendAt) : new Date(),
        finishedAt: new Date(),
      });
    return { status: 'cancelled' as const, queued: r?.queued ?? 0 };
  },
});

export const broadcastCommands = [previewBroadcast, sendTestBroadcast, broadcastStatus, cancelBroadcast] as const;

export interface BroadcastDeps {
  db: Db;
  kp: KeyProvider;
  events: EventStore;
}

/** Schedules runs for newly published broadcasts. */
async function schedule(db: Db) {
  const { rows } = await db.admin.query<{ workspace_id: string; id: string; version: number; content: BroadcastDefinition }>(
    `SELECT a.workspace_id, a.id, a.published_version AS version, v.content FROM artifacts a
     JOIN artifact_versions v ON v.workspace_id = a.workspace_id AND v.artifact_id = a.id AND v.number = a.published_version
     LEFT JOIN broadcast_runs r ON r.workspace_id = a.workspace_id AND r.broadcast_id = a.id
     WHERE a.type = 'broadcast' AND a.published_version IS NOT NULL AND a.archived = false AND r.broadcast_id IS NULL LIMIT 100`,
  );
  for (const r of rows) {
    const def = artifactTypes.broadcast.content.parse(r.content) as BroadcastDefinition;
    await db.withWorkspace(r.workspace_id, async (tx) => {
      const inserted = await tx
        .insert(schema.broadcastRuns)
        .values({
          workspaceId: r.workspace_id,
          broadcastId: r.id,
          version: r.version,
          status: 'scheduled',
          sendAt: def.sendAt ? new Date(def.sendAt) : new Date(),
        })
        .onConflictDoNothing()
        .returning({ broadcastId: schema.broadcastRuns.broadcastId });
      // The test row follows its run, so status can show the plan before the first send.
      if (inserted.length && def.subjectTest)
        await tx
          .insert(schema.broadcastTests)
          .values({
            workspaceId: r.workspace_id,
            broadcastId: r.id,
            subjects: def.subjectTest.subjects,
            samplePercent: def.subjectTest.samplePercent,
            metric: def.subjectTest.metric,
            state: 'sampling',
          })
          .onConflictDoNothing();
    });
  }
}

/** Sends one batch of a due run. Returns whether the run has more to do. */
async function sendBatch(db: Db, ws: string, broadcastId: string, deps: BroadcastDeps): Promise<boolean> {
  const out = await db.withWorkspace(ws, async (tx) => {
    const [run] = await tx
      .select()
      .from(schema.broadcastRuns)
      .where(and(eq(schema.broadcastRuns.broadcastId, broadcastId), inArray(schema.broadcastRuns.status, ['scheduled', 'running'])))
      .for('update', { skipLocked: true });
    if (!run) return { more: false, holdout: [] as JourneyEvent[] };
    const { def } = await definition(tx, broadcastId, run.version);
    // A broadcast sends for at most one published campaign. When that campaign has a control
    // group, the arm belongs to the campaign, so a second member cannot randomise the person again.
    const campaign = await campaignWithControlForMember(tx, broadcastId);
    const controlTemplate = campaign ? await publishedTemplateInfo(tx, def.template) : null;
    const holdoutEvents: JourneyEvent[] = [];
    let [test] = await tx.select().from(schema.broadcastTests).where(eq(schema.broadcastTests.broadcastId, broadcastId));
    // A run made before the test row existed (or by an older version) grows one here.
    if (!test && def.subjectTest) {
      [test] = await tx
        .insert(schema.broadcastTests)
        .values({
          workspaceId: ws,
          broadcastId,
          subjects: def.subjectTest.subjects,
          samplePercent: def.subjectTest.samplePercent,
          metric: def.subjectTest.metric,
          state: 'sampling',
        })
        .onConflictDoNothing()
        .returning();
      if (!test) [test] = await tx.select().from(schema.broadcastTests).where(eq(schema.broadcastTests.broadcastId, broadcastId));
    }

    const now = new Date();
    let cursor = run.cursor;
    // The sample has run: judge it and let the rest of the audience follow in this same pass.
    if (test?.state === 'deciding' && (!test.decideAt || test.decideAt.getTime() <= now.getTime())) {
      const variants = await variantResults(tx, deps.events, ws, broadcastId, test.subjects);
      const picked = pickWinner(test.metric, variants);
      await tx
        .update(schema.broadcastTests)
        .set({ state: 'winner_sent', winner: picked.winner, reason: picked.reason, decidedAt: now })
        .where(eq(schema.broadcastTests.broadcastId, broadcastId));
      // The rest starts from the top, and the audience is rebuilt now; do both in this
      // transaction so a crash cannot leave the winner marked sent but the rest unsent.
      await tx.update(schema.broadcastRuns).set({ cursor: '' }).where(eq(schema.broadcastRuns.broadcastId, broadcastId));
      test = { ...test, state: 'winner_sent', winner: picked.winner, reason: picked.reason, decidedAt: now };
      cursor = '';
    }
    if (test?.state === 'deciding') {
      // Not due yet: parking the lease on decideAt is what wakes the run then.
      await tx
        .update(schema.broadcastRuns)
        .set({ status: 'running', leaseUntil: test.decideAt ?? new Date(now.getTime() + LEASE_MS) })
        .where(eq(schema.broadcastRuns.broadcastId, broadcastId));
      return { more: false, holdout: holdoutEvents };
    }

    const members = await tx
      .select({ profileId: schema.segmentMemberships.profileId })
      .from(schema.segmentMemberships)
      .where(and(eq(schema.segmentMemberships.segmentId, def.segment), gt(schema.segmentMemberships.profileId, cursor)))
      .orderBy(asc(schema.segmentMemberships.profileId))
      .limit(BATCH);
    const ids = members.map((m) => m.profileId);
    // In the rest pass, everyone the sample already touched is left alone; the retry-safe
    // idempotency key would prevent a second message, but skipping them keeps the counts honest.
    const already = new Set(
      test?.state === 'winner_sent' && ids.length
        ? (
            await tx
              .select({ profileId: schema.messages.profileId })
              .from(schema.messages)
              .where(and(eq(schema.messages.journeyId, broadcastId), inArray(schema.messages.profileId, ids)))
          ).flatMap((r) => (r.profileId ? [r.profileId] : []))
        : [],
    );
    const traits =
      def.sendWindow && ids.length
        ? new Map(
            (
              await tx
                .select({ id: schema.profiles.id, traits: schema.profiles.traits })
                .from(schema.profiles)
                .where(inArray(schema.profiles.id, ids))
            ).map((p) => [p.id, p.traits]),
          )
        : new Map<string, Record<string, unknown>>();
    const policy = def.sendWindow ? await deliveryPolicy(tx) : null;
    const maxDelay = def.sendWindow ? durationSeconds(def.sendWindow.maxDelay) : 0;

    let queued = 0;
    let recipients = 0;
    let skipped = 0;
    let windowSkipped = 0;
    let sampleStartsAt: Date | null = null;
    for (const m of members) {
      if (test?.state === 'sampling' && !subjectAssignment(m.profileId, broadcastId, test.samplePercent, test.subjects.length)) continue;
      if (test?.state === 'winner_sent' && already.has(m.profileId)) continue;
      const variant =
        test?.state === 'sampling'
          ? (subjectAssignment(m.profileId, broadcastId, test.samplePercent, test.subjects.length) ?? undefined)
          : (test?.winner ?? undefined);
      // The first time this person is about to get anything from a sending member, record their
      // campaign arm. Later members read the same row.
      const holdout = campaign
        ? await assignHoldout(tx, ws, { type: 'campaign', id: campaign.id }, campaign.content.controlGroup, m.profileId)
        : null;
      if (campaign && holdout?.created)
        holdoutEvents.push({
          workspaceId: ws,
          journeyId: campaign.id,
          version: campaign.version,
          participantId: holdoutParticipantId(m.profileId),
          profileId: m.profileId,
          node: '',
          type: 'holdout_assigned',
          seq: 0,
          at: now.toISOString(),
          detail: holdoutDetail(holdout.assignment, campaign.id),
        });
      recipients++;
      // Control gets no message from any of the campaign's sending members. A suppression with
      // its own reason keeps the decision visible without counting it as a failed send.
      if (campaign && controlTemplate && holdout?.assignment.arm === 'control') {
        await suppressForControl(tx, deps, ws, broadcastId, def, controlTemplate, m.profileId, variant, campaign.id);
        skipped++;
        continue;
      }
      const subject = variant && test ? test.subjects[variant.charCodeAt(0) - 65] : undefined;

      let notBefore: Date | undefined;
      let windowSkip = false;
      let windowReason = '';
      if (def.sendWindow && policy) {
        const traitsOf = traits.get(m.profileId);
        const zone = validZone(traitsOf?.timezone) ? (traitsOf?.timezone as string) : policy.timezone;
        const hold = sendWindowHold(now, def.sendWindow, zone, run.sendAt, maxDelay);
        if (hold.skip) {
          windowSkip = true;
          windowReason = `outside_send_window: the next opening in ${zone} is ${hold.next?.toISOString() ?? 'beyond maxDelay'} (${def.sendWindow.start}–${def.sendWindow.end})`;
        } else if (hold.next) {
          notBefore = hold.next;
        }
      }
      const d = await requestFor(def.template)(tx, ws, deps.kp, deps.events, {
        profileId: m.profileId,
        templateId: def.template,
        topic: def.topic,
        idempotencyKey: `bct:${broadcastId}:${m.profileId}`,
        // Messages record the journey or broadcast that sent them.
        journeyId: broadcastId,
        variant,
        subject,
        notBefore,
      });
      if (test?.state === 'sampling' && d.status === 'queued' && !windowSkip) {
        const at = notBefore ?? now;
        if (!sampleStartsAt || at < sampleStartsAt) sampleStartsAt = at;
      }
      if (windowSkip && d.status === 'queued') {
        // The gateway queues only eligible people; a window skip is a separate refusal.
        await tx
          .update(schema.messages)
          .set({ status: 'suppressed', reason: windowReason, notBefore: null })
          .where(eq(schema.messages.id, d.messageId));
        skipped++;
        windowSkipped++;
      } else if (d.status === 'queued') {
        queued++;
        if (notBefore)
          await tx
            .update(schema.messages)
            .set({ reason: `send_window: held until ${notBefore.toISOString()}` })
            .where(eq(schema.messages.id, d.messageId));
      } else skipped++;
    }

    if (test?.state === 'sampling' && !test.decideAt) {
      const decideAt = new Date((sampleStartsAt ?? now).getTime() + durationSeconds(def.subjectTest?.decideAfter ?? 'PT4H') * 1000);
      await tx.update(schema.broadcastTests).set({ decideAt }).where(eq(schema.broadcastTests.broadcastId, broadcastId));
      test = { ...test, decideAt };
    }

    const finished = members.length < BATCH;
    const sampling = test?.state === 'sampling';
    const last = members.at(-1)?.profileId ?? run.cursor;
    await tx
      .update(schema.broadcastRuns)
      .set({
        status: finished && !sampling ? 'done' : 'running',
        // A finished sample starts the rest from the top: the audience is rebuilt then.
        cursor: sampling && finished ? '' : last,
        recipients: run.recipients + recipients,
        queued: run.queued + queued,
        skipped: run.skipped + skipped,
        windowSkipped: run.windowSkipped + windowSkipped,
        startedAt: run.startedAt ?? now,
        finishedAt: finished && !sampling ? now : null,
        leaseUntil: sampling
          ? (test?.decideAt ?? new Date(now.getTime() + LEASE_MS))
          : finished
            ? null
            : new Date(now.getTime() + LEASE_MS),
      })
      .where(eq(schema.broadcastRuns.broadcastId, broadcastId));
    if (sampling && finished) {
      await tx.update(schema.broadcastTests).set({ state: 'deciding' }).where(eq(schema.broadcastTests.broadcastId, broadcastId));
      return { more: false, holdout: holdoutEvents };
    }
    return { more: !finished, holdout: holdoutEvents };
  });
  // ClickHouse is outside the transaction, as for journeys: an assignment that committed still
  // measures from the table, and a lost event only affects the timeline.
  if (out.holdout.length)
    await deps.events.insertJourneyEvents(out.holdout).catch((err) => logger.warn({ err }, 'holdout events not stored'));
  return out.more;
}

/** One scheduler tick: schedule new broadcasts, then work through the due ones. */
export async function runBroadcastsOnce(deps: BroadcastDeps) {
  await schedule(deps.db);
  const { rows } = await deps.db.admin.query<{ workspace_id: string; broadcast_id: string }>(
    `SELECT workspace_id, broadcast_id FROM broadcast_runs
     WHERE send_at <= now() AND (status = 'scheduled' OR (status = 'running' AND (lease_until IS NULL OR lease_until < now()))) LIMIT 20`,
  );
  for (const r of rows) {
    try {
      while (await sendBatch(deps.db, r.workspace_id, r.broadcast_id, deps));
    } catch (err) {
      logger.error({ err, broadcast: r.broadcast_id }, 'broadcast batch failed; it resumes on the next tick');
    }
  }
}

export async function runBroadcasts(deps: BroadcastDeps, signal: AbortSignal, tickMs = 5000) {
  while (!signal.aborted) {
    await runBroadcastsOnce(deps).catch((err) => logger.error({ err }, 'broadcast tick failed'));
    await new Promise<void>((r) => {
      const timer = setTimeout(r, tickMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          r();
        },
        { once: true },
      );
    });
  }
}

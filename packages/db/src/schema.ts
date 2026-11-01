import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  approvalPolicy: text('approval_policy').$type<ApprovalPolicy>().notNull(),
  /** IANA time zone used to display dates in the UI. */
  timeZone: text('time_zone').notNull().default('UTC'),
  /** Addresses (besides members) that admins allow test e-mails to. */
  seedList: text('seed_list').array().notNull().default([]),
  /** Autonomy ceilings and switch for agents (ADR-0016); empty means the defaults. */
  autonomy: jsonb('autonomy').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').$type<Role>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const invitations = pgTable(
  'invitations',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    email: text('email').notNull(),
    role: text('role').$type<Role>().notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedBy: text('invited_by').notNull(),
    status: text('status').$type<'pending' | 'accepted' | 'revoked'>().notNull().default('pending'),
    acceptedBy: text('accepted_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    decidedAt: ts('decided_at'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const artifacts = pgTable(
  'artifacts',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    latestVersion: integer('latest_version').notNull(),
    publishedVersion: integer('published_version'),
    archived: boolean('archived').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const artifactVersions = pgTable(
  'artifact_versions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    artifactId: text('artifact_id').notNull(),
    number: integer('number').notNull(),
    state: text('state').$type<VersionState>().notNull(),
    content: jsonb('content').notNull(),
    contentHash: text('content_hash').notNull(),
    basedOn: integer('based_on'),
    authorType: text('author_type').$type<'user' | 'agent'>().notNull(),
    authorId: text('author_id').notNull(),
    authorClient: text('author_client'),
    note: text('note'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.artifactId, t.number] })],
);

/** Canvas positions, separate from the versioned content so moving a step is not a draft (issue #117). */
export const artifactLayout = pgTable(
  'artifact_layout',
  {
    workspaceId: uuid('workspace_id').notNull(),
    artifactId: text('artifact_id').notNull(),
    layout: jsonb('layout').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    updatedBy: text('updated_by').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.artifactId] })],
);

export const approvalRequests = pgTable(
  'approval_requests',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    artifactId: text('artifact_id').notNull(),
    version: integer('version').notNull(),
    status: text('status').$type<'pending' | 'approved' | 'rejected' | 'withdrawn'>().notNull(),
    requestedByType: text('requested_by_type').$type<'user' | 'agent'>().notNull(),
    requestedById: text('requested_by_id').notNull(),
    requestedByClient: text('requested_by_client'),
    note: text('note').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
    /** Requests reviewed and published together (#107); null for a single request. */
    bundleId: text('bundle_id'),
    /** A held agent change (level 2, ADR-0016) runs at this time unless a person rejects it first. */
    holdUntil: ts('hold_until'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/** Low-risk workspace settings an agent proposed for a person to approve (#106). */
export const workspaceProposals = pgTable(
  'workspace_proposals',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    changes: jsonb('changes').notNull(),
    note: text('note').notNull(),
    status: text('status').$type<'pending' | 'approved' | 'rejected' | 'superseded'>().notNull(),
    requestedByType: text('requested_by_type').$type<'user' | 'agent'>().notNull(),
    requestedById: text('requested_by_id').notNull(),
    requestedByClient: text('requested_by_client'),
    decidedBy: text('decided_by'),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const auditLog = pgTable('audit_log', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  at: ts('at').notNull().defaultNow(),
  principalType: text('principal_type').notNull(),
  principalId: text('principal_id').notNull(),
  clientId: text('client_id'),
  surface: text('surface').notNull(),
  command: text('command').notNull(),
  effect: text('effect').notNull(),
  target: text('target'),
  inputHash: text('input_hash').notNull(),
  ok: boolean('ok').notNull(),
  error: text('error'),
  prevHash: text('prev_hash'),
  hash: text('hash').notNull(),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    workspaceId: uuid('workspace_id').notNull(),
    key: text('key').notNull(),
    command: text('command').notNull(),
    inputHash: text('input_hash').notNull(),
    response: jsonb('response').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

export const dataKeys = pgTable(
  'data_keys',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    kekId: text('kek_id').notNull(),
    wrappedKey: bytea('wrapped_key').notNull(),
    active: boolean('active').notNull().default(true),
    purpose: text('purpose').$type<'secrets' | 'identity' | 'matching'>().notNull().default('secrets'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const secrets = pgTable(
  'secrets',
  {
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    dataKeyId: text('data_key_id').notNull(),
    iv: bytea('iv').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    authTag: bytea('auth_tag').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.name] })],
);

export const sources = pgTable(
  'sources',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<'browser' | 'server'>().notNull(),
    keyHash: text('key_hash').notNull(),
    publicKey: text('public_key'),
    keyHint: text('key_hint').notNull(),
    allowedOrigins: text('allowed_origins').array().notNull().default([]),
    requiredPurpose: text('required_purpose'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const profiles = pgTable(
  'profiles',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    mergedInto: text('merged_into'),
    traits: jsonb('traits').$type<Record<string, unknown>>().notNull().default({}),
    pii: bytea('pii'),
    firstSeen: ts('first_seen').notNull().defaultNow(),
    lastSeen: ts('last_seen').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const profileKeys = pgTable(
  'profile_keys',
  {
    workspaceId: uuid('workspace_id').notNull(),
    profileId: text('profile_id').notNull(),
    dataKeyId: text('data_key_id').notNull(),
    wrappedKey: bytea('wrapped_key').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.profileId] })],
);

export type IdentifierType = 'anonymous_id' | 'user_id' | 'email' | 'phone' | ClickIdType;
export type ClickIdType = 'gclid' | 'gbraid' | 'wbraid' | 'fbc' | 'fbp' | 'msclkid' | 'li_fat_id' | 'ttclid' | 'ttp' | 'epik';
export const identifiers = pgTable(
  'identifiers',
  {
    workspaceId: uuid('workspace_id').notNull(),
    type: text('type').$type<IdentifierType>().notNull(),
    value: text('value').notNull(),
    profileId: text('profile_id').notNull(),
    valueEnc: bytea('value_enc'),
    firstSeen: ts('first_seen').notNull().defaultNow(),
    lastSeen: ts('last_seen').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.type, t.value] })],
);

export const profileMerges = pgTable(
  'profile_merges',
  {
    workspaceId: uuid('workspace_id').notNull(),
    fromId: text('from_id').notNull(),
    intoId: text('into_id').notNull(),
    reason: text('reason').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.fromId] })],
);

export type ConsentStatus = 'granted' | 'denied' | 'withdrawn' | 'objected';
export type ConsentSource = 'sdk' | 'form' | 'import' | 'api' | 'unsubscribe' | 'agent';
export const consentRecords = pgTable(
  'consent_records',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: bigserial('id', { mode: 'number' }).notNull(),
    profileId: text('profile_id').notNull(),
    purpose: text('purpose').notNull(),
    channel: text('channel').notNull().default(''),
    status: text('status').$type<ConsentStatus>().notNull(),
    basis: text('basis').notNull(),
    source: text('source').$type<ConsentSource>().notNull(),
    proof: jsonb('proof').$type<Record<string, unknown>>().notNull().default({}),
    messageId: text('message_id'),
    recordedAt: ts('recorded_at').notNull().defaultNow(),
    recordedBy: text('recorded_by'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const consentState = pgTable(
  'consent_state',
  {
    workspaceId: uuid('workspace_id').notNull(),
    profileId: text('profile_id').notNull(),
    purpose: text('purpose').notNull(),
    channel: text('channel').notNull().default(''),
    status: text('status').$type<ConsentStatus>().notNull(),
    basis: text('basis').notNull(),
    source: text('source').$type<ConsentSource>().notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.profileId, t.purpose, t.channel] })],
);

export const suppressions = pgTable(
  'suppressions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    channel: text('channel').notNull(),
    valueHash: text('value_hash').notNull(),
    reason: text('reason').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.channel, t.valueHash] })],
);

export type TopicStatus = 'subscribed' | 'unsubscribed';
export type TopicPreferenceSource = 'preference_center' | 'unsubscribe_link' | 'api' | 'agent' | 'import' | 'form' | 'sdk';
/** Current topic choice per person; the topic's default applies when a person has no row. */
export const topicPreferences = pgTable(
  'topic_preferences',
  {
    workspaceId: uuid('workspace_id').notNull(),
    profileId: text('profile_id').notNull(),
    topic: text('topic').notNull(),
    status: text('status').$type<TopicStatus>().notNull(),
    source: text('source').$type<TopicPreferenceSource>().notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.profileId, t.topic] })],
);

/** Append-only topic decisions, with the purpose they sat under and the evidence. */
export const topicPreferenceHistory = pgTable(
  'topic_preference_history',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: bigserial('id', { mode: 'number' }).notNull(),
    profileId: text('profile_id').notNull(),
    topic: text('topic').notNull(),
    purpose: text('purpose').notNull(),
    status: text('status').$type<TopicStatus>().notNull(),
    source: text('source').$type<TopicPreferenceSource>().notNull(),
    note: text('note'),
    proof: jsonb('proof').$type<Record<string, unknown>>().notNull().default({}),
    recordedAt: ts('recorded_at').notNull().defaultNow(),
    recordedBy: text('recorded_by'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export const erasures = pgTable(
  'erasures',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    profileIds: text('profile_ids').array().notNull(),
    requestedBy: text('requested_by').notNull(),
    reason: text('reason').notNull(),
    counts: jsonb('counts').$type<Record<string, number>>().notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/**
 * Keyed hashes of an erased person's identifiers (#210): an event naming one of them inside the
 * grace window after the erasure is dropped instead of creating a new profile. Never raw values.
 */
export const erasureTombstones = pgTable(
  'erasure_tombstones',
  {
    workspaceId: uuid('workspace_id').notNull(),
    identHash: text('ident_hash').notNull(),
    erasedAt: ts('erased_at').notNull(),
    erasureId: text('erasure_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.identHash] })],
);

export const emailProviders = pgTable(
  'email_providers',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    adapter: text('adapter').$type<'smtp' | 'ses' | 'postmark' | 'brevo' | 'cloudflare' | 'log'>().notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    secrets: bytea('secrets'),
    secretsKeyId: text('secrets_key_id'),
    fromEmail: text('from_email').notNull(),
    fromName: text('from_name').notNull().default(''),
    replyTo: text('reply_to'),
    useFor: text('use_for').array().$type<('transactional' | 'marketing')[]>().notNull().default([]),
    webhookTokenHash: text('webhook_token_hash').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export type MessageStatus = 'queued' | 'sending' | 'sent' | 'suppressed' | 'failed' | 'delivered' | 'bounced' | 'complained';
export const messages = pgTable(
  'messages',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    channel: text('channel').notNull().default('email'),
    profileId: text('profile_id'),
    purpose: text('purpose').notNull(),
    /** The topic the message was sent under, if any; kept so delivery re-checks the same choice. */
    topic: text('topic'),
    templateId: text('template_id'),
    templateVersion: integer('template_version'),
    journeyId: text('journey_id'),
    providerId: text('provider_id'),
    providerMessageId: text('provider_message_id'),
    status: text('status').$type<MessageStatus>().notNull(),
    reason: text('reason'),
    recipientHash: text('recipient_hash'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    attempts: integer('attempts').notNull().default(0),
    /** Held back until then (quiet hours, a paused stream). */
    notBefore: ts('not_before'),
    /** When a queued retry becomes claimable; null keeps the old updated_at-based backoff. */
    nextAttemptAt: ts('next_attempt_at'),
    /** The subject variant of a broadcast test (A, B, …), for counting results per subject. */
    variant: text('variant'),
    /** SMS segments used. */
    segments: integer('segments'),
    /** A test send: sent for checking, never counted in reporting or delivery policy. */
    test: boolean('test').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const smsProviders = pgTable(
  'sms_providers',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    adapter: text('adapter').$type<'twilio' | 'log'>().notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    secrets: bytea('secrets'),
    secretsKeyId: text('secrets_key_id'),
    /** Phone number (E.164), alphanumeric sender id, or messaging service id. */
    sender: text('sender').notNull(),
    useFor: text('use_for').array().$type<('transactional' | 'marketing')[]>().notNull().default([]),
    webhookTokenHash: text('webhook_token_hash').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const pushProviders = pgTable(
  'push_providers',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    adapter: text('adapter').$type<'webpush' | 'fcm' | 'apns' | 'log'>().notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    secrets: bytea('secrets'),
    secretsKeyId: text('secrets_key_id'),
    useFor: text('use_for').array().$type<('transactional' | 'marketing')[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    kind: text('kind').$type<'web' | 'fcm' | 'apns'>().notNull(),
    anonymousId: text('anonymous_id'),
    userId: text('user_id'),
    tokenHash: text('token_hash').notNull(),
    secrets: bytea('secrets').notNull(),
    secretsKeyId: text('secrets_key_id').notNull(),
    sourceId: text('source_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    lastSentAt: ts('last_sent_at'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const audienceMembers = pgTable(
  'audience_members',
  {
    workspaceId: uuid('workspace_id').notNull(),
    syncId: text('sync_id').notNull(),
    platform: text('platform').$type<'meta' | 'google'>().notNull(),
    profileId: text('profile_id').notNull(),
    /** What was sent: the platform's hashes of e-mail and phone (needed to remove the person again). */
    hashes: jsonb('hashes').$type<{ email?: string; phone?: string }>().notNull(),
    addedAt: ts('added_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.syncId, t.platform, t.profileId] })],
);

export const audienceSyncState = pgTable(
  'audience_sync_state',
  {
    workspaceId: uuid('workspace_id').notNull(),
    syncId: text('sync_id').notNull(),
    platform: text('platform').$type<'meta' | 'google'>().notNull(),
    status: text('status').$type<'ok' | 'error'>().notNull(),
    error: text('error'),
    members: integer('members').notNull().default(0),
    added: integer('added').notNull().default(0),
    removed: integer('removed').notNull().default(0),
    lastRunAt: ts('last_run_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.syncId, t.platform] })],
);

export const segmentMemberships = pgTable(
  'segment_memberships',
  {
    workspaceId: uuid('workspace_id').notNull(),
    segmentId: text('segment_id').notNull(),
    profileId: text('profile_id').notNull(),
    since: ts('since').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.segmentId, t.profileId] })],
);

/** Static list membership: the source of truth that is copied into segment_memberships on change (#83). */
export const segmentListMembers = pgTable(
  'segment_list_members',
  {
    workspaceId: uuid('workspace_id').notNull(),
    segmentId: text('segment_id').notNull(),
    profileId: text('profile_id').notNull(),
    addedAt: ts('added_at').notNull().defaultNow(),
    addedBy: text('added_by'),
    source: text('source').$type<'manual' | 'api' | 'csv' | 'snapshot'>().notNull().default('manual'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.segmentId, t.profileId] })],
);

/** Provenance of list changes. `unmatched` holds row numbers and reasons only, never personal data. */
export const segmentListImports = pgTable(
  'segment_list_imports',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    segmentId: text('segment_id').notNull(),
    fileName: text('file_name'),
    fileSha256: text('file_sha256'),
    rows: integer('rows').notNull(),
    matched: integer('matched').notNull(),
    added: integer('added').notNull(),
    unmatched: jsonb('unmatched').$type<{ row: number; reason: string }[]>().notNull().default([]),
    actor: text('actor'),
    source: text('source').$type<'csv' | 'snapshot'>().notNull().default('csv'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const segmentRuns = pgTable(
  'segment_runs',
  {
    workspaceId: uuid('workspace_id').notNull(),
    segmentId: text('segment_id').notNull(),
    version: integer('version').notNull(),
    members: integer('members').notNull(),
    entered: integer('entered').notNull(),
    exited: integer('exited').notNull(),
    tookMs: integer('took_ms').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.segmentId] })],
);

export type ParticipantStatus = 'ready' | 'waiting' | 'completed' | 'exited' | 'failed';
export const journeyParticipants = pgTable(
  'journey_participants',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: bigserial('id', { mode: 'number' }).notNull(),
    journeyId: text('journey_id').notNull(),
    version: integer('version').notNull(),
    profileId: text('profile_id').notNull(),
    entryKey: text('entry_key').notNull(),
    node: text('node').notNull(),
    status: text('status').$type<ParticipantStatus>().notNull(),
    seq: integer('seq').notNull().default(0),
    dueAt: ts('due_at'),
    waitingEvent: text('waiting_event'),
    /** waitUntil's absolute timeout; dueAt is the next check, not the deadline. */
    waitingUntil: ts('waiting_until'),
    matched: boolean('matched').notNull().default(false),
    converted: boolean('converted').notNull().default(false),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    error: text('error'),
    enteredAt: ts('entered_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/** Why event-triggered entries were suppressed (#93); shown in journeys.stats. */
export const journeyEntrySkips = pgTable(
  'journey_entry_skips',
  {
    workspaceId: uuid('workspace_id').notNull(),
    journeyId: text('journey_id').notNull(),
    duplicatesSkipped: integer('duplicates_skipped').notNull().default(0),
    missingKeySkipped: integer('missing_key_skipped').notNull().default(0),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.journeyId] })],
);

export type EnrollmentJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
/**
 * A chunked, resumable enrollment of a segment into a journey (#148). The scheduler scans one
 * chunk per tick from `cursor` (the last profile id it looked at) and commits the participants
 * with the cursor, so a crash resumes without enrolling anyone twice.
 */
export const enrollmentJobs = pgTable(
  'enrollment_jobs',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    journeyId: text('journey_id').notNull(),
    segmentId: text('segment_id').notNull(),
    /** The journey's published version when the job started; null on jobs from before #324 until their next chunk. */
    journeyVersion: integer('journey_version'),
    /** The segment's published version when the job started; null on jobs from before #324 until their next chunk. */
    segmentVersion: integer('segment_version'),
    status: text('status').$type<EnrollmentJobStatus>().notNull().default('queued'),
    /** How many members the job may try; null means the whole segment. */
    limit: integer('limit'),
    /** The last profile id scanned, not the last one enrolled. */
    cursor: text('cursor'),
    /** People in the segment when the job was requested, capped by `limit` (the impact estimate). */
    people: integer('people').notNull().default(0),
    entered: integer('entered').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    /** Why people were skipped: a reason code (reentry, no_lawful_basis, suppressed…) → people. */
    skipReasons: jsonb('skip_reasons').$type<Record<string, number>>().notNull().default({}),
    requestedByType: text('requested_by_type').$type<'user' | 'agent'>().notNull(),
    requestedById: text('requested_by_id').notNull(),
    reason: text('reason').notNull(),
    idempotencyKey: text('idempotency_key'),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/**
 * A person's arm in a holdout scope (#67). The row is the source of truth: it survives re-entry,
 * restarts and profile merges, and gives measurement a stable population per scope version.
 */
export const holdoutAssignments = pgTable(
  'holdout_assignments',
  {
    workspaceId: uuid('workspace_id').notNull(),
    scopeType: text('scope_type').$type<'journey' | 'campaign'>().notNull(),
    scopeId: text('scope_id').notNull(),
    hashVersion: text('hash_version').notNull(),
    profileId: text('profile_id').notNull(),
    arm: text('arm').$type<'control' | 'treatment'>().notNull(),
    assignedAt: ts('assigned_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.scopeType, t.scopeId, t.hashVersion, t.profileId] })],
);

export type AiUse = 'journeys' | 'copilot';
export const aiProviders = pgTable(
  'ai_providers',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<'openai-compatible' | 'anthropic-compatible'>().notNull(),
    baseUrl: text('base_url').notNull(),
    models: jsonb('models').$type<{ default: string; fast?: string }>().notNull(),
    structuredOutputs: boolean('structured_outputs').notNull().default(true),
    useFor: text('use_for').array().$type<AiUse[]>().notNull().default([]),
    monthlyTokenBudget: bigint('monthly_token_budget', { mode: 'number' }),
    region: text('region').notNull().default(''),
    secrets: bytea('secrets'),
    secretsKeyId: text('secrets_key_id'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export type AiCallKind = 'decide' | 'generate' | 'copilot' | 'test' | 'classify' | 'check' | 'hosted';

export const aiTokenReservations = pgTable(
  'ai_token_reservations',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    providerId: text('provider_id').notNull(),
    tokens: integer('tokens').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);
export type AiCallStatus = 'pending' | 'running' | 'done' | 'fallback' | 'failed';
export const aiCalls = pgTable(
  'ai_calls',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    kind: text('kind').$type<AiCallKind>().notNull(),
    status: text('status').$type<AiCallStatus>().notNull(),
    leaseUntil: ts('lease_until'),
    attempts: integer('attempts').notNull().default(0),
    idempotencyKey: text('idempotency_key'),
    providerId: text('provider_id'),
    model: text('model'),
    promptId: text('prompt_id'),
    promptVersion: integer('prompt_version'),
    journeyId: text('journey_id'),
    participantId: bigint('participant_id', { mode: 'number' }),
    node: text('node'),
    seq: integer('seq'),
    profileId: text('profile_id'),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb('output').$type<unknown>(),
    rationale: text('rationale'),
    error: text('error'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms'),
    principalId: text('principal_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    cached: boolean('cached').notNull().default(false),
    reviewStatus: text('review_status').$type<'pending' | 'reviewed'>(),
    reviewVerdict: text('review_verdict').$type<'good' | 'bad'>(),
    reviewNote: text('review_note'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const aiTextCache = pgTable(
  'ai_text_cache',
  {
    workspaceId: uuid('workspace_id').notNull(),
    promptId: text('prompt_id').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    cacheKey: text('cache_key').notNull(),
    slots: jsonb('slots').$type<Record<string, string>>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.promptId, t.promptVersion, t.cacheKey] })],
);

export const copilotConversations = pgTable(
  'copilot_conversations',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    userId: text('user_id').notNull(),
    title: text('title').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const copilotTurns = pgTable(
  'copilot_turns',
  {
    workspaceId: uuid('workspace_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    n: integer('n').notNull(),
    messages: jsonb('messages').$type<unknown[]>().notNull(),
    events: jsonb('events').$type<unknown[]>().notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.conversationId, t.n] })],
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenHint: text('token_hint').notNull(),
    scopes: text('scopes').array().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const apiTokenChanges = pgTable(
  'api_token_changes',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    tokenId: text('token_id').notNull(),
    changedBy: text('changed_by').notNull(),
    changedAt: ts('changed_at').notNull().defaultNow(),
    changes: jsonb('changes').$type<Record<string, unknown>>().notNull(),
    steppedUp: boolean('stepped_up').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export type InputWarningPrincipal = 'user' | 'token' | 'oauth_client';

/** Unknown command-input keys a client sent, so strict mode can be rolled out on evidence (#124). */
export const inputWarnings = pgTable(
  'input_warnings',
  {
    workspaceId: uuid('workspace_id').notNull(),
    principalType: text('principal_type').$type<InputWarningPrincipal>().notNull(),
    principalId: text('principal_id').notNull(),
    clientLabel: text('client_label').notNull(),
    command: text('command').notNull(),
    keyPath: text('key_path').notNull(),
    firstSeen: ts('first_seen').notNull().defaultNow(),
    lastSeen: ts('last_seen').notNull().defaultNow(),
    count: integer('count').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.principalType, t.principalId, t.command, t.keyPath] })],
);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    events: text('events').array().notNull().default([]),
    purpose: text('purpose'),
    secrets: bytea('secrets').notNull(),
    secretsKeyId: text('secrets_key_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const connections = pgTable(
  'connections',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    connector: text('connector').notNull(),
    name: text('name').notNull(),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    secrets: bytea('secrets'),
    secretsKeyId: text('secrets_key_id'),
    tokenHash: text('token_hash'),
    oauthStatus: text('oauth_status').$type<'pending' | 'connected' | 'error'>(),
    oauthError: text('oauth_error'),
    /** The authorization in progress: hash of the state, PKCE verifier, redirect URI. */
    oauthPending: jsonb('oauth_pending').$type<{ stateHash: string; verifier: string; redirectUri: string; at: string }>(),
    tokenExpiresAt: ts('token_expires_at'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export type DeliveryStatus = 'pending' | 'running' | 'done' | 'failed' | 'dead';
export const deliveries = pgTable(
  'deliveries',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    kind: text('kind').$type<'webhook' | 'action' | 'ad_conversion'>().notNull(),
    targetId: text('target_id').notNull(),
    action: text('action'),
    payload: jsonb('payload').$type<unknown>().notNull(),
    status: text('status').$type<DeliveryStatus>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    leaseUntil: ts('lease_until'),
    idempotencyKey: text('idempotency_key').notNull(),
    statusCode: integer('status_code'),
    response: jsonb('response').$type<unknown>(),
    error: text('error'),
    durationMs: integer('duration_ms'),
    participantId: bigint('participant_id', { mode: 'number' }),
    node: text('node'),
    seq: integer('seq'),
    profileId: text('profile_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export type BroadcastStatus = 'scheduled' | 'running' | 'done' | 'cancelled' | 'failed' | 'stopped';
export const broadcastRuns = pgTable(
  'broadcast_runs',
  {
    workspaceId: uuid('workspace_id').notNull(),
    broadcastId: text('broadcast_id').notNull(),
    version: integer('version').notNull(),
    status: text('status').$type<BroadcastStatus>().notNull(),
    sendAt: ts('send_at').notNull(),
    leaseUntil: ts('lease_until'),
    cursor: text('cursor').notNull().default(''),
    recipients: integer('recipients').notNull().default(0),
    queued: integer('queued').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    /** Skipped because the next opening of the broadcast's send window was too far away. */
    windowSkipped: integer('window_skipped').notNull().default(0),
    error: text('error'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.broadcastId] })],
);

export type BroadcastTestState = 'sampling' | 'deciding' | 'winner_sent';

/**
 * A subject test on a broadcast: 2–4 subjects go to a deterministic sample; after `decideAt` the
 * winner goes to the rest. The state machine survives crashes because the run's cursor and this
 * row change in one transaction.
 */
export const broadcastTests = pgTable(
  'broadcast_tests',
  {
    workspaceId: uuid('workspace_id').notNull(),
    broadcastId: text('broadcast_id').notNull(),
    subjects: jsonb('subjects').$type<string[]>().notNull(),
    samplePercent: integer('sample_percent').notNull(),
    metric: text('metric').$type<'click' | 'open'>().notNull(),
    state: text('state').$type<BroadcastTestState>().notNull().default('sampling'),
    /** When the decision happens: the first sample send plus the test's decideAfter. */
    decideAt: ts('decide_at'),
    winner: text('winner'),
    reason: text('reason'),
    decidedAt: ts('decided_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.broadcastId] })],
);

export type BroadcastStageName = 'canary_sending' | 'canary_waiting' | 'checking' | 'sending_rest' | 'stopped' | 'done';

/**
 * A staged send on a broadcast (#254): the canary share goes first, after `checkAt` its bounce,
 * complaint and unsubscribe rates are judged, and only then does the rest go out. The row is the
 * durable state machine: the run's cursor and this row change in one transaction, so a crash
 * resumes at the same stage. Canary counts are kept apart from the run's totals so the check can
 * be explained long after the rest went out.
 */
export const broadcastStages = pgTable(
  'broadcast_stages',
  {
    workspaceId: uuid('workspace_id').notNull(),
    broadcastId: text('broadcast_id').notNull(),
    stage: text('stage').$type<BroadcastStageName>().notNull().default('canary_sending'),
    canaryPercent: integer('canary_percent').notNull(),
    /** When the wait is over and the canary is judged: the first canary send plus the wait. */
    checkAt: ts('check_at'),
    checkedAt: ts('checked_at'),
    /** True when the canary was smaller than minCanary: too little to judge, so the rest went out. */
    checkSkipped: boolean('check_skipped').notNull().default(false),
    canaryRecipients: integer('canary_recipients').notNull().default(0),
    canaryQueued: integer('canary_queued').notNull().default(0),
    canarySkipped: integer('canary_skipped').notNull().default(0),
    /** Base counts from the canary's message events at check time. */
    sent: integer('sent').notNull().default(0),
    bounced: integer('bounced').notNull().default(0),
    complained: integer('complained').notNull().default(0),
    unsubscribed: integer('unsubscribed').notNull().default(0),
    bounceRate: doublePrecision('bounce_rate'),
    complaintRate: doublePrecision('complaint_rate'),
    unsubscribeRate: doublePrecision('unsubscribe_rate'),
    stopReason: text('stop_reason'),
    stoppedAt: ts('stopped_at'),
    /** When a person sent the rest after a stop. */
    resumedAt: ts('resumed_at'),
    completedAt: ts('completed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.broadcastId] })],
);

export type AlertKind = 'deliverability' | 'signup_drop' | 'journey_errors';
export type AlertChannel = { type: 'webhook'; webhookId: string } | { type: 'email'; userIds: string[] };
export type AlertNotification = {
  event: 'firing' | 'resolved' | 'test';
  channel: 'webhook' | 'email';
  target: string;
  at: string;
  status: 'sent' | 'failed';
  deliveryId?: string;
  error?: string;
};

/** A threshold rule over the metric layer; `config` is kind-specific and validated by the alerts package. */
export const alertRules = pgTable(
  'alert_rules',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<AlertKind>().notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    channels: jsonb('channels').$type<AlertChannel[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: text('created_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/**
 * One firing episode. The open row (resolved_at null) is the dedupe key: the scheduler finds it
 * instead of notifying again. Resolving updates the same row, so history keeps fired_at.
 */
export const alertEvents = pgTable(
  'alert_events',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    ruleId: text('rule_id').notNull(),
    state: text('state').$type<'firing' | 'resolved'>().notNull(),
    value: doublePrecision('value').notNull(),
    threshold: doublePrecision('threshold').notNull(),
    window: text('window').notNull(),
    firedAt: ts('fired_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
    notified: jsonb('notified').$type<AlertNotification[]>().notNull().default([]),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export type ApprovalPolicy = 'none' | 'agent_changes' | 'all_publishes';
export type Role = 'owner' | 'admin' | 'marketer' | 'approver' | 'viewer';
export type VersionState = 'draft' | 'in_review' | 'published' | 'superseded' | 'rejected';

export type WarehouseDataset = 'profiles' | 'identifiers' | 'consent' | 'segment_memberships' | 'events' | 'message_events';
export const warehouseExports = pgTable(
  'warehouse_exports',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<'postgres' | 's3'>().notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    secrets: bytea('secrets'),
    secretsKeyId: text('secrets_key_id'),
    datasets: text('datasets').array().$type<WarehouseDataset[]>().notNull(),
    everyMinutes: integer('every_minutes').notNull().default(60),
    enabled: boolean('enabled').notNull().default(true),
    cursors: jsonb('cursors').$type<Record<string, string>>().notNull().default({}),
    runRequested: boolean('run_requested').notNull().default(false),
    lastRunAt: ts('last_run_at'),
    lastStatus: text('last_status').$type<'ok' | 'failed'>(),
    lastError: text('last_error'),
    lastCounts: jsonb('last_counts').$type<Record<string, number>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const assets = pgTable(
  'assets',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    width: integer('width'),
    height: integer('height'),
    altText: text('alt_text').notNull().default(''),
    createdBy: text('created_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/** The file bytes, apart from the metadata so assets.list never reads them. */
export const assetBlobs = pgTable(
  'asset_blobs',
  {
    workspaceId: uuid('workspace_id').notNull(),
    assetId: text('asset_id').notNull(),
    data: bytea('data').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.assetId] })],
);

/** A second stored object for formats e-mail cannot use: today only an SVG's PNG rendition. */
export const assetRenditions = pgTable(
  'asset_renditions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    assetId: text('asset_id').notNull(),
    kind: text('kind').$type<'png'>().notNull(),
    contentType: text('content_type').$type<'image/png'>().notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    data: bytea('data').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.assetId, t.kind] })],
);

export const edgeTargets = pgTable('edge_targets', {
  workspaceId: uuid('workspace_id').primaryKey(),
  provider: text('provider').$type<'cloudflare'>().notNull().default('cloudflare'),
  accountId: text('account_id').notNull(),
  namespaceId: text('namespace_id').notNull(),
  apiBase: text('api_base'),
  secrets: bytea('secrets'),
  secretsKeyId: text('secrets_key_id'),
  snapshots: boolean('snapshots').notNull().default(true),
  enabled: boolean('enabled').notNull().default(true),
  bundleHash: text('bundle_hash'),
  pushedKeys: text('pushed_keys').array().$type<string[]>().notNull().default([]),
  backfillCursor: text('backfill_cursor'),
  lastSyncAt: ts('last_sync_at'),
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export type AgentStatus = 'active' | 'paused' | 'revoked';
export type AgentCredentialKind = 'api_token' | 'oauth_client' | 'hosted';
export type HostedAgentRunStatus = 'ok' | 'failed' | 'skipped';
export type PolicyDecision = 'allow' | 'hold' | 'ask' | 'deny';

/** Agents as first-class principals (ADR-0016): a sponsor, a status and the credentials they act with. */
export const agents = pgTable(
  'agents',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    sponsorUserId: text('sponsor_user_id').notNull(),
    status: text('status').$type<AgentStatus>().notNull().default('active'),
    statusReason: text('status_reason'),
    statusChangedBy: text('status_changed_by'),
    statusChangedAt: ts('status_changed_at'),
    /** Reserved for multi-brand (#184): null means the whole workspace. */
    brand: text('brand'),
    /** The guardian's cap on the agent until a person clears it (#253); null when it has not acted. */
    guard: jsonb('guard').$type<AgentGuardState>(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const agentCredentials = pgTable(
  'agent_credentials',
  {
    workspaceId: uuid('workspace_id').notNull(),
    kind: text('kind').$type<AgentCredentialKind>().notNull(),
    credentialId: text('credential_id').notNull(),
    agentId: text('agent_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.kind, t.credentialId] })],
);

/**
 * How to reverse an agent action (ADR-0016 §5.4, #255). Recorded in the ledger when the action
 * runs; `none` says plainly why it cannot be undone (a message that was already sent).
 */
export type AgentUndo =
  | { kind: 'republish'; artifactId: string; previousVersion: number | null; publishedVersion?: number }
  | { kind: 'cancel_send'; broadcastId: string }
  | { kind: 'group'; items: AgentUndo[] }
  | { kind: 'none'; reason: string };

/** The agent action ledger: every agent write with its policy decision (#218). */
export const agentActions = pgTable(
  'agent_actions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: bigserial('id', { mode: 'number' }).notNull(),
    agentId: text('agent_id').notNull(),
    command: text('command').notNull(),
    actionClass: text('action_class').notNull(),
    decision: text('decision').$type<PolicyDecision>().notNull(),
    reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
    impact: jsonb('impact').$type<Record<string, unknown>>().notNull().default({}),
    ok: boolean('ok').notNull(),
    error: text('error'),
    target: text('target'),
    surface: text('surface').notNull(),
    mandateId: text('mandate_id'),
    mandateVersion: integer('mandate_version'),
    intent: text('intent'),
    /** Shadow mode (#256): what the mandate would have decided; `decision` is what applied. */
    shadow: jsonb('shadow').$type<{
      decision: PolicyDecision;
      level?: number;
      reasons: string[];
      mandateId: string;
      mandateVersion: number;
    }>(),
    /** How to reverse it (#255); null when there is nothing to reverse (or the action was refused). */
    undo: jsonb('undo').$type<AgentUndo | null>(),
    undoneAt: ts('undone_at'),
    undoneBy: text('undone_by'),
    undoResult: text('undo_result'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/** The guardian's cap on an agent (#253): levels capped at `cap`, irreversible classes at `irreversibleCap`. */
export interface AgentGuardState {
  cap: number;
  irreversibleCap?: number;
  reason: string;
  since: string;
  episodeIds: string[];
}

/** One time the guardian acted on an agent, with its evidence, until a person clears it (#253). */
export const guardianEvents = pgTable(
  'guardian_events',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    agentId: text('agent_id').notNull(),
    kind: text('kind').$type<'guardrail' | 'anomaly' | 'probing' | 'loop' | 'errors'>().notNull(),
    action: text('action').$type<'cap' | 'hold' | 'pause'>().notNull(),
    reason: text('reason').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    suspendedHolds: integer('suspended_holds').notNull().default(0),
    at: ts('at').notNull().defaultNow(),
    clearedAt: ts('cleared_at'),
    clearedBy: text('cleared_by'),
    clearedNote: text('cleared_note'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/**
 * A hosted agent (#258, #86): an agent the platform runs itself on a schedule, under the agent's
 * mandate like any other. The schedule is `hourly`, `daily:HH:MM` or `weekly:mon:07:00`, read in
 * the workspace's time zone; `nextRunAt` is the absolute next start.
 */
export const hostedAgents = pgTable(
  'hosted_agents',
  {
    workspaceId: uuid('workspace_id').notNull(),
    agentId: text('agent_id').notNull(),
    instructions: text('instructions').notNull(),
    schedule: text('schedule').notNull(),
    scopes: text('scopes').array().$type<string[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    maxTokensPerRun: integer('max_tokens_per_run').notNull().default(20_000),
    maxToolCallsPerRun: integer('max_tool_calls_per_run').notNull().default(20),
    /** An optional AI provider id; null uses the workspace's copilot provider. */
    modelProviderId: text('model_provider_id'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastRunAt: ts('last_run_at'),
    nextRunAt: ts('next_run_at'),
    runningRunId: text('running_run_id'),
    runningStartedAt: ts('running_started_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.agentId] })],
);

/** One hosted agent run: a fresh copilot session, its budgets, its summary and its outcome. */
export const hostedAgentRuns = pgTable(
  'hosted_agent_runs',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    agentId: text('agent_id').notNull(),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
    status: text('status').$type<HostedAgentRunStatus>().notNull(),
    summary: text('summary').notNull().default(''),
    toolCalls: integer('tool_calls').notNull().default(0),
    tokens: integer('tokens').notNull().default(0),
    error: text('error'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/**
 * How far agent notifications (#226) have read the ledger, when the sponsor last received a daily
 * digest, and which mandate expiries were already announced (artifactId:version:validUntil).
 */
export const agentNotificationCursor = pgTable('agent_notification_cursor', {
  workspaceId: uuid('workspace_id').primaryKey(),
  lastActionId: bigint('last_action_id', { mode: 'number' }).notNull().default(0),
  lastDigestAt: ts('last_digest_at'),
  expiryNotified: jsonb('expiry_notified').$type<Record<string, string>>().notNull().default({}),
});

/**
 * One row per agent action and recipient that already received its notification (#276). The batch
 * an e-mail contains can change between sweeps, so this is what makes a retry send only what that
 * recipient has not seen instead of re-sending a new batch.
 */
export const agentNotificationDeliveries = pgTable(
  'agent_notification_deliveries',
  {
    workspaceId: uuid('workspace_id').notNull(),
    actionId: bigint('action_id', { mode: 'number' }).notNull(),
    userId: text('user_id').notNull(),
    deliveredAt: ts('delivered_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.actionId, t.userId] })],
);

/**
 * A conclusion with its evidence (#311, agentic-autonomy §6): what a person or an agent learned
 * from subject tests, journey or campaign holdouts and experiences. Agents read the active ones as
 * the MCP resource learnings://current; a person can retract one with a reason.
 */
export type LearningStatus = 'active' | 'retracted';
export type LearningScope = {
  /** Audience segment ids the learning applies to. */
  segmentIds?: string[];
  /** Channel, e.g. "email". */
  channel?: string;
  /** Topic under a purpose. */
  topic?: string;
  /** Purpose key. */
  purpose?: string;
};
export type LearningEvidence = {
  kind: 'subject_test' | 'journey_holdout' | 'campaign_holdout' | 'experience';
  /** The broadcast, journey, campaign or experience the result came from. */
  id: string;
  summary: string;
  /** The measured numbers, e.g. { wins: 3, tests: 4, liftPts: 2.1 }. */
  numbers: Record<string, number>;
};
export const learnings = pgTable(
  'learnings',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    statement: text('statement').notNull(),
    scope: jsonb('scope').$type<LearningScope>().notNull().default({}),
    evidence: jsonb('evidence').$type<LearningEvidence[]>().notNull().default([]),
    authorType: text('author_type').$type<'user' | 'agent'>().notNull(),
    authorId: text('author_id').notNull(),
    agentId: text('agent_id'),
    status: text('status').$type<LearningStatus>().notNull().default('active'),
    retractedBy: text('retracted_by'),
    retractedAt: ts('retracted_at'),
    retractReason: text('retract_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export type ContentTopicStatus = 'idea' | 'scored' | 'brief' | 'approved' | 'drafting' | 'published' | 'archived';

/**
 * Why a topic surfaced (#141). `content_item` ids are plain strings on purpose: the content library
 * (#140) owns its own table, and the backlog must merge without depending on it.
 */
export type ContentTopicSignal = {
  kind: 'content_item' | 'community' | 'manual' | 'past_post';
  id?: string;
  title?: string;
  url?: string;
  relevance?: 'high' | 'medium' | 'low';
  comments?: number;
  /** Points this signal adds to the topic's score. */
  weight?: number;
};

/**
 * The editorial backlog (#141): one row per topic, workspace-scoped. Briefs are artifacts, not rows
 * here; a topic only names its brief and (once published) the canonical URL.
 */
export const contentTopics = pgTable(
  'content_topics',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    title: text('title').notNull(),
    angle: text('angle').notNull().default(''),
    audience: text('audience').notNull().default(''),
    readerRole: text('reader_role').notNull().default(''),
    keyword: text('keyword'),
    tags: text('tags').array().notNull().default([]),
    status: text('status').$type<ContentTopicStatus>().notNull().default('idea'),
    score: integer('score').notNull().default(0),
    signals: jsonb('signals').$type<ContentTopicSignal[]>().notNull().default([]),
    ownerId: text('owner_id'),
    ownerName: text('owner_name'),
    targetDate: date('target_date'),
    canonicalUrl: text('canonical_url'),
    campaignId: text('campaign_id'),
    broadcastId: text('broadcast_id'),
    dedupeKey: text('dedupe_key').notNull(),
    similarTopicIds: text('similar_topic_ids').array().notNull().default([]),
    briefArtifactId: text('brief_artifact_id'),
    createdByType: text('created_by_type').$type<'user' | 'agent'>().notNull(),
    createdById: text('created_by_id').notNull(),
    agentId: text('agent_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export type AgentEventType =
  | 'hold.ran'
  | 'hold.vetoed'
  | 'hold.needs_person'
  | 'approval.decided'
  | 'guardian.episode'
  | 'guardrail.breach'
  | 'experiment.significant'
  | 'alert.fired';

/**
 * An agent's event subscription (#312): which event types it wants, an optional filter on the
 * event's subject ids, and an optional outbound webhook to deliver them to. Without a webhook the
 * events are recorded for `agents.events`, the polling fallback.
 */
export const agentSubscriptions = pgTable(
  'agent_subscriptions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    agentId: text('agent_id').notNull(),
    eventTypes: text('event_types').array().$type<AgentEventType[]>().notNull(),
    filter: jsonb('filter').$type<Record<string, string | string[]>>().notNull().default({}),
    webhookId: text('webhook_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/** How far each event source has been read for agent subscriptions (#312). */
export const agentEventCursor = pgTable('agent_event_cursor', {
  workspaceId: uuid('workspace_id').primaryKey(),
  lastActionId: bigint('last_action_id', { mode: 'number' }).notNull().default(0),
  lastApprovalAt: ts('last_approval_at'),
  lastGuardianAt: ts('last_guardian_at'),
  lastAlertAt: ts('last_alert_at'),
  lastExperimentAt: ts('last_experiment_at'),
});

/** One delivered event per subscription: what `agents.events` pages through and what keeps a re-derived event silent. */
export const agentEvents = pgTable(
  'agent_events',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: bigserial('id', { mode: 'number' }).notNull(),
    agentId: text('agent_id').notNull(),
    subscriptionId: text('subscription_id').notNull(),
    type: text('type').$type<AgentEventType>().notNull(),
    eventKey: text('event_key').notNull(),
    summary: text('summary').notNull(),
    subject: jsonb('subject').$type<Record<string, unknown>>().notNull().default({}),
    at: ts('at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    uniqueIndex('agent_events_subscription_key').on(t.workspaceId, t.subscriptionId, t.eventKey),
  ],
);

// Content sources (#140): the workspace's RSS/Atom/JSON feeds, the normalised articles they
// produced, and versioned selections of those articles for an issue or brief.

export type ContentSourceKind = 'rss' | 'atom' | 'json';
export type ContentSourceCategory = 'platform' | 'publication' | 'vendor' | 'community' | 'open source' | 'thought leader' | 'other';
export type ContentItemStatus = 'new' | 'selected' | 'ignored' | 'used';
export type ContentSelectionStatus = 'draft' | 'approved';
export type ContentAuthorType = 'user' | 'agent';

/** One part of an item's relevance score, so a person can see why it ranked. */
export type ContentScoreComponent = {
  kind: 'keyword' | 'authority' | 'recency' | 'section' | 'category';
  label: string;
  points: number;
  detail: string;
};

/** The score a fetch calculated, stored with the item (issue #140: explainable and deterministic). */
export type ContentScoreExplanation = {
  policyVersion: string;
  total: number;
  matchedKeywords: string[];
  section: string;
  components: ContentScoreComponent[];
  /** A one-line human summary, e.g. "score 41: 2 high keywords, authority 4, published 6 h ago". */
  summary: string;
};

/** A selected item as it looked when the selection was saved: pruning the library keeps history. */
export type ContentSelectionItem = {
  itemId: string;
  sourceId: string;
  sourceName: string;
  title: string;
  url: string;
  excerpt: string;
  author: string | null;
  publishedAt: string | null;
  score: number;
  section: string;
};

export type ContentSelectionSection = {
  name: string;
  note: string | null;
  items: ContentSelectionItem[];
};

export const contentSources = pgTable(
  'content_sources',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    kind: text('kind').$type<ContentSourceKind>().notNull(),
    url: text('url').notNull(),
    name: text('name').notNull(),
    category: text('category').$type<ContentSourceCategory>().notNull().default('other'),
    authority: integer('authority').notNull().default(3),
    language: text('language').notNull().default('en'),
    enabled: boolean('enabled').notNull().default(true),
    fetchIntervalMinutes: integer('fetch_interval_minutes').notNull().default(360),
    lastFetchAt: ts('last_fetch_at'),
    etag: text('etag'),
    lastModified: text('last_modified'),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdByType: text('created_by_type').$type<ContentAuthorType>().notNull(),
    createdById: text('created_by_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] }), uniqueIndex('content_sources_url').on(t.workspaceId, t.url)],
);

export const contentItems = pgTable(
  'content_items',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    sourceId: text('source_id').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    title: text('title').notNull(),
    excerpt: text('excerpt').notNull(),
    author: text('author'),
    publishedAt: ts('published_at'),
    fetchedAt: ts('fetched_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    titleKey: text('title_key').notNull(),
    language: text('language').notNull().default('en'),
    section: text('section').notNull(),
    status: text('status').$type<ContentItemStatus>().notNull().default('new'),
    relevanceScore: integer('relevance_score').notNull().default(0),
    scoreExplanation: jsonb('score_explanation')
      .$type<ContentScoreExplanation>()
      .notNull()
      .default({} as ContentScoreExplanation),
    policyVersion: text('policy_version').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] }), uniqueIndex('content_items_dedupe').on(t.workspaceId, t.dedupeKey)],
);

export const contentSelections = pgTable(
  'content_selections',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    issueDate: date('issue_date', { mode: 'string' }).notNull(),
    version: integer('version').notNull().default(1),
    status: text('status').$type<ContentSelectionStatus>().notNull().default('draft'),
    sections: jsonb('sections').$type<ContentSelectionSection[]>().notNull().default([]),
    policyVersion: text('policy_version').notNull(),
    createdByType: text('created_by_type').$type<ContentAuthorType>().notNull(),
    createdById: text('created_by_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] }), uniqueIndex('content_selections_version').on(t.workspaceId, t.name, t.version)],
);

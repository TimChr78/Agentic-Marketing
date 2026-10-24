import { bigint, bigserial, boolean, customType, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
    matched: boolean('matched').notNull().default(false),
    converted: boolean('converted').notNull().default(false),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    error: text('error'),
    enteredAt: ts('entered_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
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

export type AiCallKind = 'decide' | 'generate' | 'copilot' | 'test' | 'classify';

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

export type BroadcastStatus = 'scheduled' | 'running' | 'done' | 'cancelled' | 'failed';
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
    error: text('error'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.broadcastId] })],
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

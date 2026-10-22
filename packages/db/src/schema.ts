import { bigserial, boolean, customType, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  approvalPolicy: text('approval_policy').$type<ApprovalPolicy>().notNull(),
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

export type IdentifierType = 'anonymous_id' | 'user_id' | 'email' | 'phone';
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
    adapter: text('adapter').$type<'smtp' | 'ses' | 'postmark' | 'brevo' | 'log'>().notNull(),
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
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export type ApprovalPolicy = 'none' | 'agent_changes' | 'all_publishes';
export type Role = 'owner' | 'admin' | 'marketer' | 'approver' | 'viewer';
export type VersionState = 'draft' | 'in_review' | 'published' | 'superseded' | 'rejected';

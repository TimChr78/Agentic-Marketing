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

export type ApprovalPolicy = 'none' | 'agent_changes' | 'all_publishes';
export type Role = 'owner' | 'admin' | 'marketer' | 'approver' | 'viewer';
export type VersionState = 'draft' | 'in_review' | 'published' | 'superseded' | 'rejected';

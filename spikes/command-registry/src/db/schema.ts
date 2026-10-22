import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid, bigserial, boolean } from 'drizzle-orm/pg-core';

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  approvalPolicy: text('approval_policy').notNull().default('agent_changes'),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const artifacts = pgTable(
  'artifacts',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: text('id').notNull(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    publishedVersion: integer('published_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const artifactVersions = pgTable(
  'artifact_versions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    artifactId: text('artifact_id').notNull(),
    number: integer('number').notNull(),
    state: text('state').notNull(),
    content: jsonb('content').notNull(),
    contentHash: text('content_hash').notNull(),
    authorType: text('author_type').notNull(),
    authorId: text('author_id').notNull(),
    authorClient: text('author_client'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.artifactId, t.number] })],
);

export const auditLog = pgTable('audit_log', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  principalType: text('principal_type').notNull(),
  principalId: text('principal_id').notNull(),
  clientId: text('client_id'),
  surface: text('surface').notNull(),
  command: text('command').notNull(),
  effect: text('effect').notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

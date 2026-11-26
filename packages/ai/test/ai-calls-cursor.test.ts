import { newId } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { listAiCalls } from '../src/commands';

// #1243: `ai.calls` paged with a strict `created_at < before` on a millisecond value and no id
// tie-breaker, while sorting by (created_at DESC, id DESC). Rows written by one statement share
// created_at (a prompt test run, a batch of journey steps), so a page boundary inside a group
// dropped the rest of it. The list must offer the full-precision cursor with an id tie-breaker.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws = '';
const ids = [newId('aic'), newId('aic'), newId('aic')].sort();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_calls_cursor');
  ws = d.workspace;
  // One statement, one now(): what prompts.test writes for a three-case run.
  await d.db.admin.query(
    `INSERT INTO ai_calls (workspace_id, id, kind, status, created_at)
     SELECT $1, unnest($2::text[]), 'test', 'done', now()`,
    [ws, ids],
  );
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const page = (input: { limit: number; before?: string; cursor?: string }) =>
  d.db.withWorkspace(ws, (tx) => listAiCalls.handler(input as never, { tx, principal: { workspaceId: ws } } as never));

describe.skipIf(!hasTestDatabase())('ai.calls pages every row that shares a timestamp (#1243)', () => {
  it('follows nextCursor through a same-timestamp group without dropping a row', async () => {
    const first = await page({ limit: 2 });
    // Newest first: id DESC inside the shared timestamp.
    expect(first.calls.map((c) => c.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).toBeTruthy();

    const second = await page({ limit: 2, cursor: first.nextCursor! });
    expect(second.calls.map((c) => c.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
  }, 60_000);

  it('still accepts the existing `before` input', async () => {
    const first = await page({ limit: 2 });
    const older = await page({ limit: 2, before: first.calls[1]!.createdAt });
    // The legacy boundary stays a strict timestamp comparison; it must not throw or change shape.
    expect(Array.isArray(older.calls)).toBe(true);
  }, 60_000);
});

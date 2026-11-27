import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #1262 review: `content.topics.list` must report the real backlog size and page with a keyset
// cursor, so an archive between two pages never skips or repeats a topic that is still there.

const PORT = testPort(2598);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';

const api = () => t.api(owner);
const list = (input: Record<string, unknown>) => api().call('content.topics.list', input);

const create = async (title: string, tag: string) => (await api().call('content.topics.create', { title, score: 50, tags: [tag] })).topic;

/** Give every topic in the tag one score and timestamp, so only the id tie-break orders them. */
const freeze = (tag: string) =>
  t.srv.db.admin.query(
    `UPDATE content_topics SET updated_at = '2026-11-04 12:34:56.123456+00' WHERE workspace_id = $1 AND $2 = ANY(tags)`,
    [ws, tag],
  );

beforeAll(async () => {
  t = await startTestServer('test_content_topics_paging', PORT);
  owner = await t.signUp(`owner-topics-paging-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'all_publishes');
}, 60_000);

afterAll(() => t?.close());

describe('content.topics.list paging (#1262)', () => {
  it('reports a real total and pages with a keyset cursor over a stable order', async () => {
    const tag = `paging-${Date.now()}`;
    const created = [];
    for (let i = 0; i < 5; i++) created.push(await create(`Paging topic ${i} ${tag}`, tag));
    await freeze(tag);

    const first = await list({ tag, limit: 2 });
    expect(first.count).toBe(2);
    expect(first.total).toBe(5);
    expect(first.nextCursor).toEqual(expect.any(String));

    const seen = first.topics.map((topic: { id: string }) => topic.id);
    let cursor = first.nextCursor;
    let pages = 1;
    while (cursor) {
      const page = await list({ tag, limit: 2, cursor });
      expect(page.total).toBe(5);
      seen.push(...page.topics.map((topic: { id: string }) => topic.id));
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect(new Set(seen)).toEqual(new Set(created.map((topic) => topic.id)));
  });

  it('does not skip or repeat the remaining topics when one is archived between pages', async () => {
    const tag = `archive-${Date.now()}`;
    const created = [];
    for (let i = 0; i < 5; i++) created.push(await create(`Archive topic ${i} ${tag}`, tag));
    await freeze(tag);

    const first = await list({ tag, limit: 2 });
    const removed = first.topics[0]!;
    await api().call('content.topics.archive', { topicId: removed.id });

    // The first page was read before the archive; every later page must still see each remaining
    // topic once. Offset paging would have skipped one because the backlog shrank by one.
    const seen = first.topics.map((topic: { id: string }) => topic.id);
    // The rows of the first page that are not the archived one were read before it changed.
    const after = first.topics.filter((topic: { id: string }) => topic.id !== removed.id).map((topic: { id: string }) => topic.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await list({ tag, limit: 2, cursor });
      seen.push(...page.topics.map((topic: { id: string }) => topic.id));
      after.push(...page.topics.map((topic: { id: string }) => topic.id));
      cursor = page.nextCursor;
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(created.map((topic) => topic.id)));
    expect(after).not.toContain(removed.id);
    expect(new Set(after)).toEqual(new Set(created.map((topic) => topic.id).filter((id) => id !== removed.id)));
    expect((await list({ tag, limit: 2 })).total).toBe(4);
  });

  it('rejects a malformed cursor instead of restarting', async () => {
    await expect(list({ cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

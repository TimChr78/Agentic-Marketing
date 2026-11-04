import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testPort, type User } from './harness';

// #382: artifacts.list must page past its 200-row maximum and report the true total. The UI follows
// nextCursor; this only needs to prove the command's keyset boundary never skips or repeats a row.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_artifact_pages', testPort(3510));
  owner = await t.signUp(`pages-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']]);
  const api = t.api(owner);
  for (let i = 0; i < 201; i++) {
    await api.call('artifacts.create', { type: 'note', name: `Numbered note ${i}`, content: { title: `Note ${i}`, body: 'Body' } });
  }
}, 120_000);
afterAll(() => t?.close());

describe('artifacts.list pagination (#382)', () => {
  it('reaches every artifact and reports the server total, not the page length', async () => {
    const api = t.api(owner);

    const first = await api.call('artifacts.list', { type: 'note', limit: 200 });
    expect(first.artifacts).toHaveLength(200);
    expect(first.total).toBe(201);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await api.call('artifacts.list', { type: 'note', limit: 200, cursor: first.nextCursor! });
    expect(second.artifacts).toHaveLength(1);
    expect(second.total).toBe(201);
    expect(second.nextCursor).toBeNull();

    const ids = new Set([...first.artifacts, ...second.artifacts].map((a) => a.id));
    expect(ids.size).toBe(201);
  });

  it('filters the total by type and rejects a malformed cursor instead of restarting', async () => {
    const api = t.api(owner);
    const notes = await api.call('artifacts.list', { type: 'note', limit: 1 });
    expect(notes.total).toBe(201);
    expect((await api.call('artifacts.list', { type: 'segment', limit: 1 })).total).toBe(0);

    const bad = await rejects(api.call('artifacts.list', { cursor: 'not-a-cursor' }));
    expect(bad.code).toBe('invalid_input');
  });
});

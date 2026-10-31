import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runContentFetchOnce } from '@agentic-marketing/content';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, rejects, startTestServer, testPort, type User } from './harness';

// Wave 4, Phase 20 (#140): RSS/Atom/JSON sources, a normalised and deduplicated library with an
// explainable score, conditional GET and failure tracking, and versioned selections.
//
// The feed server listens on loopback and the harness allows 127.0.0.1, so the real egress guard
// runs; no production allow list is weakened.

const PORT = testPort(3472);

const rssFeed = (origin: string) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Test martech feed</title>
    <item>
      <title>Agentic marketing platforms raise a funding round</title>
      <link>${origin}/a?utm_source=rss</link>
      <description><![CDATA[<p>The <b>martech</b> vendor closed a series a round.</p>]]></description>
      <content:encoded><![CDATA[${'Full article body that must never be stored. '.repeat(30)}]]></content:encoded>
      <dc:creator>Dana Writer</dc:creator>
      <pubDate>${new Date(Date.now() - 2 * 3_600_000).toUTCString()}</pubDate>
    </item>
    <item>
      <title>The agent playbook for marketing teams</title>
      <link>${origin}/b</link>
      <description>How agents change the weekly workflow.</description>
      <pubDate>${new Date(Date.now() - 26 * 3_600_000).toUTCString()}</pubDate>
    </item>
  </channel>
</rss>`;

const atomFeed = (origin: string) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test signals</title>
  <entry>
    <title>The agent playbook for marketing teams</title>
    <link rel="alternate" href="${origin}/b-alt"/>
    <summary>The same story, re-posted with another link.</summary>
    <published>${new Date(Date.now() - 5 * 3_600_000).toISOString()}</published>
    <author><name>Sam Editor</name></author>
  </entry>
  <entry>
    <title>Open source martech tools to watch</title>
    <link rel="alternate" href="${origin}/c"/>
    <summary>A github repository with a permissive license.</summary>
    <published>${new Date(Date.now() - 4 * 3_600_000).toISOString()}</published>
  </entry>
</feed>`;

const jsonFeed = (origin: string) =>
  JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'Test JSON feed',
    items: [
      {
        id: 'a-repost',
        url: `${origin}/a?utm_campaign=json`,
        title: 'Agentic marketing platforms raise a funding round',
        summary: 'The same funding story from a second feed.',
        date_published: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      },
      {
        id: 'd',
        url: `${origin}/d`,
        title: 'A new AI agent launches in beta',
        content_text: 'The assistant is now available for marketing teams.',
        date_published: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ],
  });

const scheduledFeed = (origin: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Scheduled</title>
  <item><title>Community webinar for martech teams</title><link>${origin}/e</link>
  <description>A community event for the newsletter.</description>
  <pubDate>${new Date(Date.now() - 3_600_000).toUTCString()}</pubDate></item>
</channel></rss>`;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let agent: Awaited<ReturnType<typeof connectAgent>>;
let feed: Server;
let origin = '';
const hits = new Map<string, number>();
let rssId = '';
let failureId = '';
let monitoredId = '';

beforeAll(async () => {
  feed = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://feed').pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/rss+xml', ...headers });
      res.end(body);
    };
    if (path === '/rss.xml') {
      if (req.headers['if-none-match'] === '"rss-1"') return send(304, '', { etag: '"rss-1"' });
      return send(200, rssFeed(origin), { etag: '"rss-1"' });
    }
    if (path === '/atom.xml') return send(200, atomFeed(origin), { 'content-type': 'application/atom+xml' });
    if (path === '/feed.json') return send(200, jsonFeed(origin), { 'content-type': 'application/feed+json' });
    if (path === '/scheduled.xml') return send(200, scheduledFeed(origin));
    if (path === '/broken.xml') return send(500, 'upstream exploded');
    return send(404, 'not found');
  });
  await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(feed.address() as AddressInfo).port}`;

  t = await startTestServer('test_content_sources', PORT);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  agent = await connectAgent(t.base, owner, ['artifacts:read', 'artifacts:write']);
}, 60_000);

afterAll(async () => {
  await t?.close();
  await new Promise<void>((resolve) => feed?.close(() => resolve()));
});

const api = () => t.api(owner);

describe('content sources (#140)', () => {
  it('adds a source, fetches it and normalises items with excerpts', async () => {
    const source = await api().call('content.sources.create', {
      kind: 'rss',
      url: `${origin}/rss.xml`,
      name: 'Test martech feed',
      category: 'publication',
      authority: 4,
    });
    rssId = source.id;
    expect(source).toMatchObject({ kind: 'rss', enabled: true, consecutiveFailures: 0, lastError: null });

    const result = await api().call('content.sources.fetch', { id: rssId });
    expect(result).toMatchObject({ status: 'ok', itemsAdded: 2, itemsUpdated: 0, error: null });

    const { items } = await api().call('content.items.list', { sourceId: rssId });
    expect(items).toHaveLength(2);
    const funding = items.find((i) => i.title.startsWith('Agentic marketing'))!;
    expect(funding).toMatchObject({
      sourceName: 'Test martech feed',
      canonicalUrl: `${origin}/a`,
      author: 'Dana Writer',
      section: 'Big moves',
      status: 'new',
    });
    expect(funding.excerpt).toContain('martech');
    expect(funding.excerpt).not.toContain('Full article body');
    expect(funding.excerpt.length).toBeLessThanOrEqual(401);
    expect(funding.scoreExplanation.total).toBe(funding.relevanceScore);
    expect(funding.scoreExplanation.components.map((c) => c.kind)).toEqual(
      expect.arrayContaining(['keyword', 'authority', 'recency', 'category', 'section']),
    );
    expect(funding.scoreExplanation.summary).toContain(`score ${funding.relevanceScore}`);
    expect(funding.scoreExplanation.policyVersion).toBe('1');
  });

  it('deduplicates across sources by canonical URL and by title', async () => {
    const atom = await api().call('content.sources.create', {
      kind: 'atom',
      url: `${origin}/atom.xml`,
      name: 'Test signals',
      category: 'thought leader',
      authority: 3,
    });
    const atomResult = await api().call('content.sources.fetch', { id: atom.id });
    expect(atomResult).toMatchObject({ status: 'ok', itemsAdded: 1, itemsUpdated: 1 });

    const json = await api().call('content.sources.create', {
      kind: 'json',
      url: `${origin}/feed.json`,
      name: 'Test JSON feed',
      category: 'vendor',
      authority: 2,
    });
    const jsonResult = await api().call('content.sources.fetch', { id: json.id });
    expect(jsonResult).toMatchObject({ status: 'ok', itemsAdded: 1, itemsUpdated: 1 });

    const { items } = await api().call('content.items.list', { limit: 200 });
    expect(items).toHaveLength(4);
    expect(items.filter((i) => i.title === 'The agent playbook for marketing teams')).toHaveLength(1);
    expect(items.filter((i) => i.canonicalUrl === `${origin}/a`)).toHaveLength(1);
  });

  it('handles a 304 with an ETag without adding items', async () => {
    const before = (await api().call('content.items.list', { limit: 200 })).items.length;
    const result = await api().call('content.sources.fetch', { id: rssId });
    expect(result).toMatchObject({ status: 'not_modified', itemsAdded: 0, itemsUpdated: 0, error: null });
    expect(hits.get('/rss.xml')).toBe(2);
    expect((await api().call('content.items.list', { limit: 200 })).items.length).toBe(before);
    const source = (await api().call('content.sources.list', {})).sources.find((s) => s.id === rssId)!;
    expect(source).toMatchObject({ etag: '"rss-1"', consecutiveFailures: 0, lastError: null });
  });

  it('records a failing source without failing the others', async () => {
    const broken = await api().call('content.sources.create', {
      kind: 'rss',
      url: 'http://127.0.0.1:1/feed.xml',
      name: 'Broken feed',
      fetchIntervalMinutes: 60,
    });
    failureId = broken.id;
    for (const expected of [1, 2]) {
      const result = await api().call('content.sources.fetch', { id: failureId });
      expect(result.status).toBe('failed');
      expect(result.error).toBeTruthy();
      const source = (await api().call('content.sources.list', {})).sources.find((s) => s.id === failureId)!;
      expect(source.consecutiveFailures).toBe(expected);
      expect(source.lastError).toBeTruthy();
      expect(source.lastFetchAt).not.toBeNull();
    }
    // The healthy sources are untouched by the failure.
    expect((await api().call('content.sources.list', {})).sources.find((s) => s.id === rssId)!.consecutiveFailures).toBe(0);
  });

  it('refuses a private-address source through the egress guard', async () => {
    const error = await rejects(
      api().call('content.sources.create', { kind: 'rss', url: 'http://192.168.1.20/feed.xml', name: 'Internal' }),
    );
    expect(error.message).toMatch(/private address|not allowed/i);
  });

  it('fetches due sources from the scheduler sweep', async () => {
    const source = await api().call('content.sources.create', {
      kind: 'rss',
      url: `${origin}/scheduled.xml`,
      name: 'Scheduled feed',
      fetchIntervalMinutes: 60,
    });
    monitoredId = source.id;
    const summary = await runContentFetchOnce(
      { db: t.srv.db, egress: t.srv.egress, hostGapMs: 0, retryDelaysMs: [0] },
      new Date(Date.now() + 2 * 3_600_000),
    );
    expect(summary.sources).toBeGreaterThanOrEqual(1);
    expect(summary.itemsAdded).toBeGreaterThanOrEqual(1);
    expect(summary.failed).toBe(0);
    const { items } = await api().call('content.items.list', { sourceId: monitoredId });
    expect(items.map((i) => i.canonicalUrl)).toContain(`${origin}/e`);
  });

  it('creates a versioned selection with a snapshot an agent can read back', async () => {
    const { items } = await api().call('content.items.list', { limit: 200 });
    const funding = items.find((i) => i.canonicalUrl === `${origin}/a`)!;
    const playbook = items.find((i) => i.title === 'The agent playbook for marketing teams')!;

    const created = await api().call('content.selections.create', {
      name: 'Weekly issue',
      issueDate: '2026-10-31',
      sections: [
        { name: 'Big moves', note: 'Lead story', itemIds: [funding.id] },
        { name: 'Agent playbook', itemIds: [playbook.id] },
      ],
    });
    expect(created).toMatchObject({ name: 'Weekly issue', issueDate: '2026-10-31', version: 1, status: 'draft' });
    expect(created.sections[0]).toMatchObject({
      name: 'Big moves',
      note: 'Lead story',
      items: [{ itemId: funding.id, title: funding.title, url: `${origin}/a`, excerpt: funding.excerpt }],
    });

    const read = await api().call('content.selections.get', { id: created.id });
    expect(read.sections[1]!.items[0]).toMatchObject({ itemId: playbook.id, sourceName: 'Test martech feed' });

    const again = await api().call('content.selections.create', { name: 'Weekly issue', sections: [{ name: 'Big moves', itemIds: [] }] });
    expect(again.version).toBe(2);
    const listed = await api().call('content.selections.list', { name: 'Weekly issue' });
    expect(listed.selections.map((s) => s.version).sort()).toEqual([1, 2]);

    const byAgent = (await agent.client.callTool({
      name: 'content.selections.create',
      arguments: { name: 'Agent proposal', sections: [{ name: 'Big moves', itemIds: [funding.id] }] },
    })) as { content: { text: string }[] };
    expect(byAgent.content[0]!.text).toContain('Agent proposal');
  });

  it('does not let an agent add a source', async () => {
    await expect(
      agent.client.callTool({ name: 'content.sources.create', arguments: { kind: 'rss', url: `${origin}/agent.xml`, name: 'Agent feed' } }),
    ).rejects.toThrow();
  });

  it('keeps workspaces apart', async () => {
    const other = await t.signUp(`other-${Date.now()}@example.com`);
    await t.workspaceWith([[other, 'owner']], 'none');
    const otherApi = t.api(other);
    expect((await otherApi.call('content.sources.list', {})).sources).toEqual([]);
    expect((await otherApi.call('content.items.list', {})).items).toEqual([]);
    expect((await otherApi.call('content.selections.list', {})).selections).toEqual([]);
  });
});

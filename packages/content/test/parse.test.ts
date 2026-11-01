import { describe, expect, it } from 'vitest';
import { EXCERPT_MAX, excerptOf, parseFeed } from '../src/parse';
import { canonicalUrl, titleKey, titleSimilarity } from '../src/urls';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Martech Weekly</title>
    <item>
      <title><![CDATA[Agentic marketing platforms raise a funding round]]></title>
      <link>https://example.com/a?utm_source=rss&amp;utm_medium=feed</link>
      <description><![CDATA[<p>The <b>agentic</b> vendor raised money &amp; hired a team.</p>]]></description>
      <content:encoded><![CDATA[${'The full article text that must never be stored. '.repeat(40)}]]></content:encoded>
      <dc:creator>Dana Writer</dc:creator>
      <pubDate>Tue, 27 Oct 2026 09:00:00 GMT</pubDate>
      <category>funding</category>
    </item>
    <item>
      <title>No link here</title>
      <description>Dropped</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Agentic Signals</title>
  <entry>
    <title>The agent playbook for small teams</title>
    <link rel="alternate" type="text/html" href="https://example.org/playbook"/>
    <summary type="html">&lt;p&gt;How &lt;em&gt;agents&lt;/em&gt; change the weekly workflow.&lt;/p&gt;</summary>
    <published>2026-10-28T12:30:00Z</published>
    <author><name>Sam Editor</name></author>
  </entry>
  <entry>
    <title>Open source martech tools to watch</title>
    <link rel="alternate" href="https://example.org/oss"/>
    <content type="html">${'<p>Long body text about open source tools.</p>'.repeat(30)}</content>
    <updated>2026-10-29T08:00:00Z</updated>
  </entry>
</feed>`;

const JSON_FEED = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'JSON Signals',
  items: [
    {
      id: '1',
      url: 'https://example.net/launch?fbclid=abc',
      title: 'A new feature launches',
      summary: 'Short summary of the launch.',
      date_published: '2026-10-30T10:00:00Z',
      author: { name: 'JSON Author' },
      tags: ['launch'],
    },
  ],
});

const RSS_RELATIVE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Relative RSS</title>
    <item><title>Root relative</title><link>/post/1</link></item>
    <item><title>Path relative</title><link>post/2</link></item>
    <item><title>Absolute</title><link>https://example.com/absolute</link></item>
    <item><title>Script</title><link>javascript:alert(1)</link></item>
    <item><title>Data</title><link>data:text/html,hello</link></item>
  </channel>
</rss>`;

const ATOM_RELATIVE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Relative Atom</title>
  <entry><title>Root relative</title><link rel="alternate" href="/post/1"/></entry>
  <entry><title>Path relative</title><link rel="alternate" href="post/2"/></entry>
  <entry><title>Absolute</title><link rel="alternate" href="https://example.com/absolute"/></entry>
  <entry><title>Script</title><link rel="alternate" href="javascript:alert(1)"/></entry>
  <entry><title>Data</title><link rel="alternate" href="data:text/html,hello"/></entry>
</feed>`;

const JSON_FEED_RELATIVE = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'Relative JSON Signals',
  items: [
    { id: '1', title: 'Root relative', url: '/post/1' },
    { id: '2', title: 'Path relative', url: 'post/2' },
    { id: '3', title: 'Absolute', url: 'https://example.com/absolute' },
    { id: '4', title: 'Script', url: 'javascript:alert(1)' },
    { id: '5', title: 'Data', url: 'data:text/html,hello' },
  ],
});

describe('feed parsing', () => {
  it('normalises RSS items and keeps the description, never content:encoded', () => {
    const feed = parseFeed('rss', RSS, 'https://feed.example.com/rss.xml');
    expect(feed.title).toBe('Martech Weekly');
    expect(feed.items).toHaveLength(1);
    const [item] = feed.items;
    expect(item!.title).toBe('Agentic marketing platforms raise a funding round');
    expect(item!.url).toBe('https://example.com/a');
    expect(item!.author).toBe('Dana Writer');
    expect(item!.excerpt).not.toContain('full article');
    expect(item!.excerpt).toContain('agentic');
    expect(item!.excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(item!.publishedAt?.toISOString()).toBe('2026-10-27T09:00:00.000Z');
    expect(item!.categories).toEqual(['funding']);
  });

  it('normalises Atom entries by their alternate link and truncates content to an excerpt', () => {
    const feed = parseFeed('atom', ATOM, 'https://feed.example.com/atom.xml');
    expect(feed.items).toHaveLength(2);
    const [playbook, oss] = feed.items;
    expect(playbook!.url).toBe('https://example.org/playbook');
    expect(playbook!.author).toBe('Sam Editor');
    expect(playbook!.excerpt).toBe('How agents change the weekly workflow.');
    expect(oss!.excerpt.endsWith('…')).toBe(true);
    expect(oss!.excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(oss!.excerpt).not.toContain('Long body'.repeat(4));
  });

  it('parses a JSON Feed', () => {
    const feed = parseFeed('json', JSON_FEED, 'https://feed.example.com/feed.json');
    expect(feed.title).toBe('JSON Signals');
    expect(feed.items[0]).toMatchObject({
      title: 'A new feature launches',
      url: 'https://example.net/launch',
      author: 'JSON Author',
      categories: ['launch'],
    });
  });

  it('resolves relative RSS links against the feed URL (#326)', () => {
    const feed = parseFeed('rss', RSS_RELATIVE, 'https://feeds.example.com/rss/feed.xml');
    expect(feed.items.map((item) => item.url)).toEqual([
      'https://feeds.example.com/post/1',
      'https://feeds.example.com/rss/post/2',
      'https://example.com/absolute',
    ]);
  });

  it('resolves relative Atom links against the feed URL (#326)', () => {
    const feed = parseFeed('atom', ATOM_RELATIVE, 'https://feeds.example.com/atom/feed.xml');
    expect(feed.items.map((item) => item.url)).toEqual([
      'https://feeds.example.com/post/1',
      'https://feeds.example.com/atom/post/2',
      'https://example.com/absolute',
    ]);
  });

  it('resolves relative JSON Feed links against the feed URL (#326)', () => {
    const feed = parseFeed('json', JSON_FEED_RELATIVE, 'https://feeds.example.com/feed.json');
    expect(feed.items.map((item) => item.url)).toEqual([
      'https://feeds.example.com/post/1',
      'https://feeds.example.com/post/2',
      'https://example.com/absolute',
    ]);
  });

  it('drops javascript: and data: links in every format (#326)', () => {
    for (const [kind, body] of [
      ['rss', RSS_RELATIVE],
      ['atom', ATOM_RELATIVE],
      ['json', JSON_FEED_RELATIVE],
    ] as const) {
      const titles = parseFeed(kind, body, 'https://feeds.example.com/feed').items.map((item) => item.title);
      expect(titles).not.toContain('Script');
      expect(titles).not.toContain('Data');
    }
  });

  it('honours an Atom xml:base over the feed URL (#326)', () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://cdn.example.com/blog/">
      <title>Based</title>
      <entry><title>Nested</title><link rel="alternate" href="post/3"/></entry>
    </feed>`;
    expect(parseFeed('atom', atom, 'https://feeds.example.com/atom.xml').items[0]!.url).toBe('https://cdn.example.com/blog/post/3');
  });

  it('refuses a document that is not a feed', () => {
    expect(() => parseFeed('rss', '<html><body>nope</body></html>', 'https://x.example/feed')).toThrow(/not an RSS or Atom feed/);
    expect(() => parseFeed('json', '{"not":"a feed"}', 'https://x.example/feed')).toThrow(/not a JSON Feed/);
  });
});

describe('canonical links and title dedupe', () => {
  it('strips tracking parameters, the fragment and a trailing slash', () => {
    expect(canonicalUrl('https://Example.com/story/?utm_source=x&b=2&a=1#top')).toBe('https://example.com/story?a=1&b=2');
  });

  it('treats a re-titled re-post as the same story but keeps different stories apart', () => {
    expect(titleKey('  The Agent Playbook — for marketers! ')).toBe('the agent playbook for marketers');
    expect(titleSimilarity('The agent playbook for marketing teams', 'The agent playbook for marketing teams')).toBe(1);
    expect(titleSimilarity('The agent playbook for marketing teams', 'Agent playbook: marketing teams')).toBeGreaterThan(0.9);
    expect(titleSimilarity('The agent playbook for marketing teams', 'Open source martech tools to watch')).toBeLessThan(0.2);
  });

  it('cuts an excerpt at a word boundary', () => {
    const excerpt = excerptOf('word '.repeat(200));
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX + 1);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

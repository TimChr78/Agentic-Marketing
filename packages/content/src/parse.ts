import type { ContentSourceKind } from '@agentic-marketing/db';
import { parseDocument } from 'htmlparser2';
import { canonicalUrl } from './urls';

// Feed parsing (#140): RSS 2.0 (and RSS 1.0/RDF), Atom 1.0 and JSON Feed 1.0/1.1. Only the fields
// the library needs are taken: the title, the canonical link, an excerpt, the author and the date.
// `content:encoded` and Atom `content` are never stored whole; at most an excerpt is kept.

/** The longest excerpt stored, so an item never becomes a copy of the article. */
export const EXCERPT_MAX = 400;

export interface ParsedFeedItem {
  title: string;
  url: string;
  excerpt: string;
  author: string | null;
  publishedAt: Date | null;
  categories: string[];
}

export interface ParsedFeed {
  title: string | null;
  items: ParsedFeedItem[];
}

interface XmlNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: XmlNode[];
}

const isElement = (node: XmlNode): boolean => node.type === 'tag' || node.type === 'script' || node.type === 'style';

const localName = (node: XmlNode): string => {
  const name = (node.name ?? '').toLowerCase();
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
};

const children = (node: XmlNode): XmlNode[] => node.children ?? [];

function textOf(node: XmlNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.data ?? '';
  // htmlparser2 represents a CDATA section as a node with a text child, not as text itself.
  return children(node).map(textOf).join('');
}

function attr(node: XmlNode, name: string): string | undefined {
  const found = Object.entries(node.attribs ?? {}).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}

function direct(node: XmlNode, name: string): XmlNode | undefined {
  const wanted = name.toLowerCase();
  return children(node).find((child) => isElement(child) && localName(child) === wanted);
}

function directAll(node: XmlNode, name: string): XmlNode[] {
  const wanted = name.toLowerCase();
  return children(node).filter((child) => isElement(child) && localName(child) === wanted);
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Visible text of an HTML fragment, with entities decoded and tags removed. */
function plainText(value: string): string {
  if (!value) return '';
  return clean(textOf(parseDocument(value) as unknown as XmlNode));
}

/** An excerpt at most EXCERPT_MAX characters, cut on a word boundary where possible. */
export function excerptOf(value: string | undefined | null): string {
  const text = plainText(value ?? '');
  if (text.length <= EXCERPT_MAX) return text;
  const cut = text.slice(0, EXCERPT_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > EXCERPT_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function toDate(value: string | undefined | null): Date | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time) : null;
}

function categoryOf(node: XmlNode): string[] {
  return directAll(node, 'category')
    .map((c) => clean(attr(c, 'term') ?? textOf(c)))
    .filter(Boolean);
}

function xmlRoot(body: string): XmlNode {
  // `recognizeCDATA` is not implied by xmlMode: without it a <![CDATA[…]]> section is dropped,
  // and many feeds put the title and description there.
  const doc = parseDocument(body, { xmlMode: true, recognizeCDATA: true }) as unknown as XmlNode;
  const root = children(doc).find(isElement);
  if (!root) throw new Error('the feed is empty or not XML');
  return root;
}

function parseRss(root: XmlNode, feedUrl: string): ParsedFeed {
  // RSS 2.0 nests items under <channel>; RSS 1.0 (RDF) puts them beside <channel>.
  const channel = direct(root, 'channel');
  const itemNodes = channel ? directAll(channel, 'item') : directAll(root, 'item');
  if (!channel && !itemNodes.length) throw new Error('not an RSS feed: no channel or items');
  const items: ParsedFeedItem[] = [];
  for (const node of itemNodes) {
    const title = clean(textOf(direct(node, 'title')));
    const link = clean(textOf(direct(node, 'link'))) || clean(textOf(direct(node, 'guid')));
    if (!title || !/^https?:\/\//i.test(link)) continue;
    items.push({
      title,
      url: canonicalUrl(link, feedUrl),
      // `content:encoded` is deliberately not read: never store the full article.
      excerpt: excerptOf(textOf(direct(node, 'description')) || textOf(direct(node, 'encoded')) || textOf(direct(node, 'summary'))),
      author: clean(textOf(direct(node, 'author')) || textOf(direct(node, 'creator')) || textOf(direct(node, 'name'))) || null,
      publishedAt: toDate(textOf(direct(node, 'pubDate')) || textOf(direct(node, 'date')) || textOf(direct(node, 'published'))),
      categories: categoryOf(node),
    });
  }
  return { title: channel ? clean(textOf(direct(channel, 'title'))) || null : null, items };
}

function parseAtom(root: XmlNode, feedUrl: string): ParsedFeed {
  const entries = directAll(root, 'entry');
  const items: ParsedFeedItem[] = [];
  for (const entry of entries) {
    const title = clean(textOf(direct(entry, 'title')));
    const links = directAll(entry, 'link');
    const alternate = links.find((l) => (attr(l, 'rel') ?? 'alternate').toLowerCase() === 'alternate') ?? links[0];
    const href = alternate ? clean(attr(alternate, 'href') ?? '') : '';
    const fallback = clean(textOf(direct(entry, 'id')));
    const link = /^https?:\/\//i.test(href) ? href : fallback;
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const authorNode = direct(entry, 'author');
    items.push({
      title,
      url: canonicalUrl(link, feedUrl),
      excerpt: excerptOf(textOf(direct(entry, 'summary')) || textOf(direct(entry, 'content'))),
      author: clean(authorNode ? textOf(direct(authorNode, 'name')) || textOf(authorNode) : '') || null,
      publishedAt: toDate(textOf(direct(entry, 'published')) || textOf(direct(entry, 'updated'))),
      categories: categoryOf(entry),
    });
  }
  return { title: clean(textOf(direct(root, 'title'))) || null, items };
}

interface JsonFeedItem {
  id?: string;
  url?: string;
  external_url?: string;
  title?: string;
  summary?: string;
  content_text?: string;
  content_html?: string;
  date_published?: string;
  date_modified?: string;
  author?: { name?: string };
  authors?: { name?: string }[];
  tags?: string[];
}

function parseJsonFeed(body: string, feedUrl: string): ParsedFeed {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('the feed is not valid JSON');
  }
  const feed = data as { version?: string; title?: string; items?: JsonFeedItem[] };
  if (!feed || typeof feed !== 'object' || !Array.isArray(feed.items)) throw new Error('not a JSON Feed: no items array');
  const items: ParsedFeedItem[] = [];
  for (const item of feed.items) {
    const title = clean(item.title ?? '');
    const link = clean(item.url ?? item.external_url ?? item.id ?? '');
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const author = clean(item.author?.name ?? item.authors?.[0]?.name ?? '') || null;
    items.push({
      title,
      url: canonicalUrl(link, feedUrl),
      excerpt: excerptOf(item.summary ?? item.content_text ?? item.content_html ?? ''),
      author,
      publishedAt: toDate(item.date_published ?? item.date_modified),
      categories: (item.tags ?? []).map(clean).filter(Boolean),
    });
  }
  return { title: clean(feed.title ?? '') || null, items };
}

/**
 * Parse a feed body. `kind` chooses JSON Feed; for XML the root element decides between RSS and
 * Atom, so a source configured as `rss` still accepts an Atom document and vice versa.
 */
export function parseFeed(kind: ContentSourceKind, body: string, feedUrl: string): ParsedFeed {
  if (kind === 'json') return parseJsonFeed(body, feedUrl);
  const root = xmlRoot(body);
  const name = localName(root);
  if (name === 'feed') return parseAtom(root, feedUrl);
  if (name === 'rss' || name === 'rdf') return parseRss(root, feedUrl);
  throw new Error(`not an RSS or Atom feed: root element is <${root.name ?? 'unknown'}>`);
}

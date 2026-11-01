# Content sources

The input side of the newsletter loop (#140): workspace-owned RSS, Atom and JSON Feeds, a
normalised article library with an explainable score, and versioned selections that a newsletter
issue or a content brief is built from. Everything is a command, so people and agents use the same
paths over REST, MCP and the admin API.

## Sources

A source is workspace configuration:

- `kind`: `rss`, `atom` or `json` (JSON Feed 1.0/1.1). Reddit and Hacker News RSS feeds work as
  `rss`/`atom`; a site's own `.json` feed works as `json`.
- `url`, `name`, `category` (`platform`, `publication`, `vendor`, `community`, `open source`,
  `thought leader`, `other`), `authority` 1–5, `language`, `enabled` and a fetch interval in
  minutes (5 minutes to 7 days, default 6 hours).
- Fetch state: last fetch, ETag and Last-Modified for conditional GET, the last error and the
  number of consecutive failures.

`content.sources.create` and `content.sources.update` are people-only (`workspace:admin`), like
connector configuration: an agent cannot add or change a feed. `content.sources.list` is readable
with `artifacts:read`. A failing source stays in the list with its error and failure count; it does
not disappear and it does not fail the other sources.

The URL is checked when the source is created and on every fetch through the existing egress guard
([integrations.md](integrations.md)): only public http/https addresses, no credentials in the URL,
and no redirects, so a source cannot be used for SSRF. A homelab feed must be allowed explicitly
with `EGRESS_ALLOWED_HOSTS`.

## Fetching

- The scheduler role sweeps due sources every five minutes (each source keeps its own interval).
- `content.sources.fetch` fetches one source on demand, outside its interval.
- Requests use conditional GET (`If-None-Match`/`If-Modified-Since`), a descriptive user agent, a
  10 second deadline and a 1 MiB response limit. A 304 is a success and adds no items.
- Network errors, timeouts, 429 and 5xx are retried with a short backoff. A failed run records the
  error, increments `consecutiveFailures` and stretches the next due time exponentially (up to
  16× the interval), so a broken feed is not hammered.
- One sweep fetches sources sequentially with a per-host gap; at most 20 sources per workspace and
  100 items per fetch.
- Only an excerpt (at most 400 characters) and the canonical link are stored. RSS
  `content:encoded` and a long Atom `content` are never stored whole.

## Items and scoring

`content.items.list` returns normalised items: source, canonical URL, title, excerpt, author,
published time, fetched time, section, status, relevance score and the score's explanation.

Dedupe is deterministic: the canonical link (no fragment, no tracking parameters, stable query
order, no trailing slash) is hashed into a dedupe key, and a re-fetch updates the item. Across
sources, an item with the same normalised title — or 90% title-word overlap within the last 14
days — is the same story and updates the existing row.

The score is a fixed policy (`CONTENT_POLICY_VERSION = "1"`) and every item stores its components:

- keyword groups: high (12 points each, capped at 36), medium (6, capped at 24) and other (3,
  capped at 12);
- source authority: 0–20 points for authority 1–5;
- recency: 20 points within 24 hours, 12 within 3 days, 6 within 7 days, else 0;
- category tie-breaker: 0–6 points;
- section: the rule with the most matching keywords among Big moves, Tools & launches, Agent
  playbook, Deep dive, Open source and Community (ties follow that order).

The stored `scoreExplanation` has the policy version, the matched keywords, each component's
points and detail, and a one-line summary. Re-fetching with the same inputs and clock produces the
same score. Agents cite the policy version when they explain a selection.

## Selections

`content.selections.create` saves a named, dated set of items per section, with an optional note per
section. Each item is snapshotted (title, source, URL, excerpt, author, date, score), so pruning or
editing the library later does not change history. Creating another selection with the same name
increments its version; every version is kept. `content.selections.get` and
`content.selections.list` read them back, filtered by name to see a selection's history.

Creating a selection requires `artifacts:write` and is classed as a `draft`: an agent can propose
one for a person to review. There is no approve command yet, so a selection's status stays `draft`;
the issue that uses it is reviewed and published through the normal artifact flow.

## Commands

| Command | Permission | Who | Effect |
|---|---|---|---|
| `content.sources.list` | `artifacts:read` | people and agents | read |
| `content.sources.create` | `workspace:admin` | people only | write |
| `content.sources.update` | `workspace:admin` | people only | write |
| `content.sources.fetch` | `artifacts:write` | people and agents | write (`data.write`) |
| `content.items.list` | `artifacts:read` | people and agents | read |
| `content.selections.create` | `artifacts:write` | people and agents | write (`draft`) |
| `content.selections.get` | `artifacts:read` | people and agents | read |
| `content.selections.list` | `artifacts:read` | people and agents | read |

## Not in this release

- YouTube sources, the policy editor/artifact (`content.policy.*`) and AI summaries
  (`content.items.summarize`).
- `content.sources.delete`, `content.items.select`/`ignore`, and selection `update`/`submit`/approve.
- Retention pruning, robots.txt checks and the UI screens. Selections already keep their snapshots,
  so retention can be added without changing them.

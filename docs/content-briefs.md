# Editorial topics and content briefs

The editorial backlog turns signals into a queue of topics, and a topic into a versioned brief.
It replaces the ad-hoc "blog topic suggestion" workflow: ideas are stored once, deduplicated, scored
with the evidence behind them, and linked to the brief that is approved and published.

It is a queue, not a calendar. A topic stores a target date so a later marketing calendar (#78) can
show it without duplicating the schedule.

## The pipeline

```
idea → scored → brief → approved → drafting → published
                                  ↘ archived (at any point)
```

- **idea**: a person or agent proposed it, manually or from a selection of content items.
- **scored**: it carries a score and the signals behind it.
- **brief**: `content.topics.toBrief` created a `content_brief` draft artifact and linked it.
- **approved**: a person approved the brief and it was published as an artifact version. The
  approval policy applies as for any artifact; an agent cannot approve its own brief.
- **drafting**: the piece is being written (the CMS itself stays outside the platform).
- **published**: the topic stores the canonical URL. It cannot be marked published without one.
- **archived**: out of the backlog; the brief, its versions and the published URL stay.

Publishing a brief moves a topic from `idea`, `scored` or `brief` to `approved`. A topic already
`drafting` or `published` is not moved back, and an archived topic stays archived.

## Topics are rows, briefs are artifacts

A topic is a workspace-scoped table row (`content_topics`, migration `0059_content_topics.sql`) with
status, score, signals, owner, target date, canonical URL, campaign/broadcast links and a dedupe key.

A brief is a `content_brief` **artifact**: it gets the same drafts, versions, diffs, approval drawer,
publish and audit as a journey or an e-mail template. The brief content holds the thesis, audience,
angle, why now, outline, key points, sources, do-nots, risks, the Monday test, success measure,
voice, CTA, keyword/intent and word count.

A brief cannot be published without:

- a **thesis** (the argument, not a summary);
- an **audience**;
- a **Monday test**: what a marketing ops person does differently after reading it;
- at least one **source**, or an explicit `noSourcesReason`.

Sources cite content-item ids as plain strings and canonical URLs. The content library (#140) owns
its own table; the backlog does not depend on it, so the two can be merged independently. Never
invent a URL, quote or statistic.

## Signals and dedupe

A signal is one of:

- `content_item`: a source item from the content library, with an optional id, relevance and URL;
- `community`: Reddit/HN demand, with optional comments/upvotes;
- `manual`: a person's or agent's idea;
- `past_post`: an earlier post worth revisiting.

Each signal has a weight (5 points by default); a topic's score is the sum, clamped to 0–100. The
list page shows why a topic surfaced ("2 source items, 1 high-relevance, 1 community thread (120
comments)"), not only the number.

Dedupe normalises the title and keyword (case, accents, punctuation and spacing). A near-duplicate
is advisory, never blocking: `content.topics.create` still creates the topic but returns
`duplicateOf` and links both topics' `similarTopicIds`, so a deliberate re-topic is possible and an
accident is visible.

## Commands

| Command | Who | What |
|---|---|---|
| `content.topics.list` | people and agents | The backlog, filtered by status, owner, tag, score range and target date. Archived topics are hidden unless asked for. |
| `content.topics.create` | people and agents | Add a topic with signals, score, tags, target date and campaign/broadcast links. Agents cannot assign an owner or create an approved/published topic. |
| `content.topics.update` | people and agents | Edit fields or status. Marking published needs a canonical URL. People set approval, publication, archive and owner; agents stay within idea/scored/drafting. |
| `content.topics.score` | people and agents | Replace the signals and/or set the score; an idea becomes scored. |
| `content.topics.archive` | people (destructive class) | Take it out of the backlog without deleting the brief or URL. |
| `content.topics.toBrief` | people and agents | Create the `content_brief` draft seeded from the topic and its content-item signals. |

Briefs use the normal artifact commands (`artifacts.create`, `artifacts.updateDraft`,
`artifacts.requestPublish`, `approvals.approve`) with `type: "content_brief"`. In the admin UI they
open in the artifact editor; the backlog does not have a second editor.

## Guardrails

- Agents may read the backlog, propose and score topics, and draft briefs.
- Agents cannot approve a brief, mark a topic published, assign an owner, set the published URL or
  delete a topic.
- A proposed topic may be a manual idea; the signals list shows that it is one.
- Approvals follow the existing artifact policy; an independent person approves, and an agent
  cannot approve its own brief.
- Everything is workspace-scoped with row-level security; there is no cross-workspace read.
- Editorial work uses public sources, not personal data from the CDP.

## Not in this release

- AI drafting (`content.briefs.generate`) and the prompt artifacts for proposing topics/generating
  briefs, including recorded prompt version, model and tokens.
- `content.topics.get`, `content.topics.fromSelection`/`fromSignals` and the `content.briefs.*`
  aliases: create/score/toBrief and the artifact commands cover the same work for now.
- Search Console / SEO-query signals, trigram or embedding similarity, and rank tracking.
- Calendar views (#78), the similar-topics explorer, and performance links once the metric layer
  covers published posts.
- Auto-publishing to the site; the site or its agent publishes and the topic stores the URL.
- Extending `config.export` with the topics table (briefs are already exported as artifacts), and
  emitting the topic/brief lifecycle events.

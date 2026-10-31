import { FileText, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { api, errText } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { navigate } from '../../app/router';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { type TopicRow, TopicsTable, topicStatus } from '../../features/content/TopicsTable';
import { Button, Field, Input, Modal, PageHeader, Select, TableFrame, Textarea, useToast } from '../../ui';
import { pageWidth } from '../../ui/layout';

// Build → Topics (#141): the editorial backlog. A queue, not a calendar: the target date is stored
// so #78 can show it later, but this page groups by status and score. Briefs open in the normal
// artifact editor, so their versions, diffs and approvals are the same as every other artifact.

const STATUS_FILTERS = ['', 'idea', 'scored', 'brief', 'approved', 'drafting', 'published', 'archived'] as const;
const SCORE_FILTERS = ['', '25', '50', '75', '90'] as const;

interface Draft {
  title: string;
  angle: string;
  audience: string;
  keyword: string;
  tags: string;
  targetDate: string;
  signals: string;
}

const EMPTY: Draft = { title: '', angle: '', audience: '', keyword: '', tags: '', targetDate: '', signals: '' };

export default function TopicsPage() {
  useCrumbs([{ label: 'Topics' }]);
  const { can } = useSession();
  const toast = useToast();
  const canWrite = can('artifacts:write');

  const [status, setStatus] = useState('');
  const [owner, setOwner] = useState('');
  const [tag, setTag] = useState('');
  const [minScore, setMinScore] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);

  const list = useApi(
    () =>
      api.call('content.topics.list', {
        status: status ? (status as TopicRow['status']) : undefined,
        owner: owner.trim() || undefined,
        tag: tag.trim() || undefined,
        minScore: minScore ? Number(minScore) : undefined,
      }),
    [status, owner, tag, minScore],
  );
  const topics = list.data?.topics ?? [];

  const set = (key: keyof Draft) => (event: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: event.target.value }));

  const create = async () => {
    if (!draft.title.trim()) return;
    setSaving(true);
    try {
      const lines = draft.signals
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const result = await api.call('content.topics.create', {
        title: draft.title.trim(),
        angle: draft.angle.trim(),
        audience: draft.audience.trim(),
        keyword: draft.keyword.trim() || undefined,
        tags: draft.tags
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        targetDate: draft.targetDate || undefined,
        signals: lines.map((title) => ({ kind: 'manual' as const, title, weight: 5 })),
      });
      if (result.duplicateOf) toast.info(`Linked to the similar topic “${result.duplicateOf.title}”.`);
      else toast.success(`Added “${result.topic.title}” to the backlog.`);
      setCreating(false);
      setDraft(EMPTY);
      void list.reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const brief = async (topic: TopicRow) => {
    try {
      const result = await api.call('content.topics.toBrief', { topicId: topic.id });
      toast.success(`Drafted a brief for “${topic.title}”.`);
      navigate(`/artifacts/${result.artifactId}`);
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const archive = async (topic: TopicRow) => {
    try {
      await api.call('content.topics.archive', { topicId: topic.id });
      toast.success(`Archived “${topic.title}”. Its brief and published URL stay.`);
      void list.reload();
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title="Topics"
        description="The editorial backlog: ideas and signals become scored topics, a topic becomes a brief, and the brief’s approval moves it forward. A queue, not a calendar."
        actions={
          canWrite && (
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
              New topic
            </Button>
          )
        }
      />

      <TableFrame
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        isEmpty={topics.length === 0}
        columns={7}
        toolbar={
          <>
            <div className="relative w-full max-w-[240px]">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" aria-hidden />
              <Input
                compact
                aria-label="Filter by owner"
                placeholder="Owner"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                className="pl-8"
              />
            </div>
            <Input
              compact
              aria-label="Filter by tag"
              placeholder="Tag"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              className="max-w-[160px]"
            />
            <Select compact aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUS_FILTERS.map((value) => (
                <option key={value || 'all'} value={value}>
                  {value ? topicStatus(value).label : 'Every status'}
                </option>
              ))}
            </Select>
            <Select compact aria-label="Minimum score" value={minScore} onChange={(e) => setMinScore(e.target.value)}>
              {SCORE_FILTERS.map((value) => (
                <option key={value || 'any'} value={value}>
                  {value ? `Score ${value}+` : 'Any score'}
                </option>
              ))}
            </Select>
            <span className="ml-auto text-[12px] text-muted">
              {topics.length} topic{topics.length === 1 ? '' : 's'}
            </span>
          </>
        }
      >
        <TopicsTable topics={topics} onCreateBrief={brief} onArchive={archive} canWrite={canWrite} canArchive={canWrite} />
      </TableFrame>

      <p className="mt-3 text-[12px] text-muted">
        <FileText size={12} className="mr-1 inline" aria-hidden />
        Briefs edit in the artifact editor, with versions, diffs and the normal approval policy. An agent can propose and draft; only a
        person approves, publishes and assigns. Archiving keeps the brief and the URL.
      </p>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New topic"
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" loading={saving} disabled={!draft.title.trim()} onClick={() => void create()}>
              Add topic
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Title" required>
            <Input autoFocus value={draft.title} onChange={set('title')} placeholder="What the piece is about" />
          </Field>
          <Field label="Angle" hint="One line: the specific take, not the whole argument.">
            <Input value={draft.angle} onChange={set('angle')} />
          </Field>
          <Field label="Audience">
            <Input value={draft.audience} onChange={set('audience')} placeholder="Who it is for" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Keyword" hint="Optional primary keyword or intent.">
              <Input value={draft.keyword} onChange={set('keyword')} />
            </Field>
            <Field label="Target date" hint="A target, not a calendar entry.">
              <Input type="date" value={draft.targetDate} onChange={set('targetDate')} />
            </Field>
          </div>
          <Field label="Tags" hint="Comma separated.">
            <Input value={draft.tags} onChange={set('tags')} placeholder="newsletter, operations" />
          </Field>
          <Field label="Signals" hint="One per line: a source item, a community thread or a manual idea. Each adds 5 points.">
            <Textarea rows={4} value={draft.signals} onChange={set('signals')} />
          </Field>
          <p className="text-[12px] text-muted">
            Near-duplicates are linked to the existing topic instead of being silently created twice.
          </p>
        </div>
      </Modal>
    </div>
  );
}

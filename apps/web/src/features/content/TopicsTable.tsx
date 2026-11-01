import { Archive, FileText, Plus } from 'lucide-react';
import type { Out } from '../../app/api';
import { artifactPath } from '../../app/artifactRoutes';
import { Link } from '../../app/router';
import { Button, EmptyState, StatusPill, Table, TableFrame, Td, THead, Th, type Tone, Tr } from '../../ui';

// The editorial backlog table (#141): a queue of topics with their score, the signals behind it,
// owner, target date and brief. The page owns filters and actions; this stays presentational so it
// can be tested without an API.

export type TopicRow = Out<'content.topics.list'>['topics'][number];

export const TOPIC_STATUS: Record<string, { label: string; tone: Tone }> = {
  idea: { label: 'Idea', tone: 'neutral' },
  scored: { label: 'Scored', tone: 'info' },
  brief: { label: 'Brief', tone: 'warn' },
  approved: { label: 'Approved', tone: 'good' },
  drafting: { label: 'Drafting', tone: 'info' },
  published: { label: 'Published', tone: 'good' },
  archived: { label: 'Archived', tone: 'neutral' },
};

export const topicStatus = (status: string) => TOPIC_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };

/** Why a topic surfaced: "2 source items, 1 high-relevance, 1 community thread (120 comments)". */
export function signalSummary(topic: Pick<TopicRow, 'signals'>): string {
  if (!topic.signals.length) return 'Manual idea';
  const content = topic.signals.filter((signal) => signal.kind === 'content_item').length;
  const community = topic.signals.filter((signal) => signal.kind === 'community');
  const high = topic.signals.filter((signal) => signal.relevance === 'high').length;
  const comments = community.reduce((sum, signal) => sum + (signal.comments ?? 0), 0);
  const parts: string[] = [];
  if (content) parts.push(`${content} source item${content === 1 ? '' : 's'}`);
  if (high) parts.push(`${high} high-relevance`);
  if (community.length)
    parts.push(`${community.length} community thread${community.length === 1 ? '' : 's'}${comments ? ` (${comments} comments)` : ''}`);
  return parts.join(', ') || 'Manual idea';
}

export function TopicsTable({
  topics,
  onCreateBrief,
  onArchive,
  canWrite = true,
  canArchive = false,
}: {
  topics: TopicRow[];
  onCreateBrief?: (topic: TopicRow) => void;
  onArchive?: (topic: TopicRow) => void;
  canWrite?: boolean;
  canArchive?: boolean;
}) {
  return (
    <TableFrame
      isEmpty={topics.length === 0}
      columns={7}
      empty={
        <EmptyState icon={<FileText size={20} />} title="No topics in this view">
          A topic starts as an idea, is scored by its signals, and becomes a brief when it is worth writing. Adjust the filters, or add the
          first topic.
        </EmptyState>
      }
    >
      <Table label="Editorial topics">
        <THead>
          <tr>
            <Th>Topic</Th>
            <Th>Status</Th>
            <Th>Score</Th>
            <Th className="hidden lg:table-cell">Why it surfaced</Th>
            <Th className="hidden md:table-cell">Owner</Th>
            <Th className="hidden md:table-cell">Target</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </THead>
        <tbody>
          {topics.map((topic) => {
            const status = topicStatus(topic.status);
            return (
              <Tr key={topic.id}>
                <Td>
                  <div className="font-medium text-fg">{topic.title}</div>
                  {topic.angle && <div className="mt-0.5 line-clamp-2 max-w-[460px] text-[12px] text-muted">{topic.angle}</div>}
                  {topic.tags.length > 0 && <div className="mt-1 text-[11px] text-muted">{topic.tags.join(' · ')}</div>}
                </Td>
                <Td>
                  <StatusPill tone={status.tone}>{status.label}</StatusPill>
                  {topic.canonicalUrl && (
                    <a
                      href={topic.canonicalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 block max-w-[180px] truncate text-[11px] text-accent hover:underline"
                    >
                      {topic.canonicalUrl}
                    </a>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-[13px]">{topic.score}</Td>
                <Td className="hidden max-w-[260px] text-[12px] text-muted lg:table-cell">{signalSummary(topic)}</Td>
                <Td className="hidden md:table-cell text-[12px]">{topic.ownerName ?? topic.ownerId ?? 'Unassigned'}</Td>
                <Td className="hidden whitespace-nowrap text-[12px] md:table-cell">{topic.targetDate ?? '—'}</Td>
                <Td className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {topic.briefArtifactId ? (
                      <Link
                        to={artifactPath('content_brief', topic.briefArtifactId)}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[12px] font-medium text-fg hover:bg-surface-2"
                      >
                        <FileText size={13} /> Open brief
                      </Link>
                    ) : (
                      canWrite &&
                      onCreateBrief && (
                        <Button size="sm" variant="secondary" icon={<Plus size={13} />} onClick={() => onCreateBrief(topic)}>
                          Brief
                        </Button>
                      )
                    )}
                    {canArchive && topic.status !== 'archived' && onArchive && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Archive ${topic.title}`}
                        title="Archive"
                        onClick={() => onArchive(topic)}
                      >
                        <Archive size={13} />
                      </Button>
                    )}
                  </div>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableFrame>
  );
}

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signalSummary, type TopicRow, TopicsTable, topicStatus } from '../src/features/content/TopicsTable';

afterEach(cleanup);

const topic = (overrides: Partial<TopicRow> = {}): TopicRow => ({
  id: `ctp_${'a'.repeat(32)}`,
  title: 'The quiet cost of a manual newsletter',
  angle: 'Hours spent on a weekly issue, and what to automate first',
  audience: 'Marketing ops leads',
  readerRole: 'marketing ops lead',
  keyword: 'newsletter automation',
  tags: ['newsletter', 'operations'],
  status: 'scored',
  score: 82,
  signals: [
    { kind: 'content_item', id: `cit_${'b'.repeat(32)}`, relevance: 'high', weight: 40 },
    { kind: 'content_item', weight: 42 },
    { kind: 'community', comments: 120, weight: 5 },
  ],
  ownerId: null,
  ownerName: 'Ada',
  targetDate: '2026-11-16',
  canonicalUrl: null,
  campaignId: null,
  broadcastId: null,
  dedupeKey: 'the quiet cost of a manual newsletter|newsletter automation',
  similarTopicIds: [],
  briefArtifactId: null,
  createdBy: { type: 'user', id: 'usr_1' },
  agentId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

describe('editorial backlog page (#141)', () => {
  it('names every status in words and colours, never colour alone', () => {
    expect(topicStatus('idea')).toEqual({ label: 'Idea', tone: 'neutral' });
    expect(topicStatus('brief')).toEqual({ label: 'Brief', tone: 'warn' });
    expect(topicStatus('published')).toEqual({ label: 'Published', tone: 'good' });
    expect(topicStatus('something_new')).toEqual({ label: 'something_new', tone: 'neutral' });
  });

  it('summarises why a topic surfaced', () => {
    expect(signalSummary(topic())).toBe('2 source items, 1 high-relevance, 1 community thread (120 comments)');
    expect(signalSummary(topic({ signals: [] }))).toBe('Manual idea');
    expect(signalSummary(topic({ signals: [{ kind: 'community', comments: 0, weight: 5 }] }))).toBe('1 community thread');
  });

  it('shows the backlog row and creates a brief from a topic without one', async () => {
    const onCreateBrief = vi.fn();
    render(<TopicsTable topics={[topic()]} onCreateBrief={onCreateBrief} canWrite />);

    expect(screen.getByText('The quiet cost of a manual newsletter')).toBeTruthy();
    expect(screen.getByText('Scored')).toBeTruthy();
    expect(screen.getByText('82')).toBeTruthy();
    expect(screen.getByText('2 source items, 1 high-relevance, 1 community thread (120 comments)')).toBeTruthy();
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText('2026-11-16')).toBeTruthy();
    expect(screen.getByText('newsletter · operations')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Brief' }));
    expect(onCreateBrief).toHaveBeenCalledWith(topic());
  });

  it('opens the existing artifact editor for a topic that already has a brief', () => {
    const briefArtifactId = `brf_${'c'.repeat(32)}`;
    render(<TopicsTable topics={[topic({ status: 'brief', briefArtifactId })]} />);
    const link = screen.getByRole('link', { name: /Open brief/ });
    expect(link.getAttribute('href')).toBe(`/artifacts/${briefArtifactId}`);
    expect(screen.queryByRole('button', { name: 'Brief' })).toBeNull();
  });

  it('keeps the archived state visible and offers no archive action for it', () => {
    const onArchive = vi.fn();
    render(
      <TopicsTable
        topics={[topic({ status: 'archived', canonicalUrl: 'https://example.com/blog/post' })]}
        canArchive
        onArchive={onArchive}
      />,
    );
    expect(screen.getByText('Archived')).toBeTruthy();
    expect(screen.getByText('https://example.com/blog/post')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Archive/ })).toBeNull();
  });
});

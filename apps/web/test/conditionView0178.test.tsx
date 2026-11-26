import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #1263: the read-only condition view printed the topic and score leaves as raw JSON to the
// preview and to approvers, while every other leaf read as a sentence. Topic keys now resolve to
// the purposes artifact's names (#1263 review).

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name !== 'purposes.list') throw new Error(`unexpected ${name}`);
        return {
          source: 'published',
          purposes: [
            {
              key: 'marketing_email',
              name: 'Marketing e-mail',
              topics: [{ key: 'weekly_readers', name: 'Weekly readers', description: '', default: 'subscribed' }],
            },
          ],
        };
      }),
    },
  };
});

import { ConditionView } from '../src/features/previews/ConditionView';

afterEach(cleanup);

describe('read-only condition view (#1263)', () => {
  it('renders a topic leaf as a sentence with the topic name, not its key', async () => {
    render(<ConditionView condition={{ topic: 'weekly_readers' }} />);
    expect(screen.getByText(/Subscribed to topic/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Weekly readers')).toBeTruthy());
    expect(document.body.textContent).not.toContain('weekly_readers');
    expect(document.body.textContent).not.toContain('{"topic"');
  });

  it('uses a neutral fallback for a topic the purposes no longer name', async () => {
    render(<ConditionView condition={{ topic: 'retired_topic' }} />);
    await waitFor(() => expect(screen.getByText('Unavailable topic')).toBeTruthy());
    expect(document.body.textContent).not.toContain('retired_topic');
  });

  it('renders a score leaf with its bounds as a sentence', () => {
    render(<ConditionView condition={{ score: { key: 'conversion_propensity', gte: 0.8 } }} />);
    expect(screen.getByText(/Score/)).toBeTruthy();
    expect(document.body.textContent).toContain('conversion_propensity');
    expect(document.body.textContent).toContain('is at least 0.8');
    expect(document.body.textContent).not.toContain('{"score"');

    cleanup();
    render(<ConditionView condition={{ score: { key: 'churn_risk', lte: 0.25 } }} />);
    expect(document.body.textContent).toContain('is at most 0.25');
  });

  it('keeps nested leaves readable inside all/any groups', async () => {
    render(<ConditionView condition={{ all: [{ topic: 'weekly_readers' }, { score: { key: 'conversion_propensity', gte: 0.5 } }] }} />);
    expect(document.body.textContent).toContain('Subscribed to topic');
    expect(document.body.textContent).toContain('is at least 0.5');
    await waitFor(() => expect(screen.getByText('Weekly readers')).toBeTruthy());
  });
});

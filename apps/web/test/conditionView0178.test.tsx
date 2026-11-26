import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConditionView } from '../src/features/previews/ConditionView';

// #1263: the read-only condition view printed the topic and score leaves as raw JSON to the
// preview and to approvers, while every other leaf read as a sentence.

afterEach(cleanup);

describe('read-only condition view (#1263)', () => {
  it('renders a topic leaf as a sentence', () => {
    render(<ConditionView condition={{ topic: 'newsletter' }} />);
    expect(screen.getByText(/Subscribed to topic/)).toBeTruthy();
    expect(document.body.textContent).toContain('newsletter');
    expect(document.body.textContent).not.toContain('{"topic"');
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

  it('keeps nested leaves readable inside all/any groups', () => {
    render(<ConditionView condition={{ all: [{ topic: 'newsletter' }, { score: { key: 'conversion_propensity', gte: 0.5 } }] }} />);
    expect(document.body.textContent).toContain('Subscribed to topic');
    expect(document.body.textContent).toContain('is at least 0.5');
  });
});

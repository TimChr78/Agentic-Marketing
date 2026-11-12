import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HoldoutCard, type HoldoutResult } from './HoldoutCard';

// absoluteLift and ci95 are differences of two conversion rates: percentage points, not percent
// (#794). The same fields are shown with a "pp" unit on the campaign and broadcast holdout panels.

const result: HoldoutResult = {
  controlGroup: { percent: 10, minSampleSize: 100, hashVersion: 'v1' },
  control: { entered: 200, converted: 20, unsubscribed: 0, conversionRate: 0.1, unsubscribeRate: 0 },
  treatment: { entered: 200, converted: 30, unsubscribed: 2, conversionRate: 0.15, unsubscribeRate: 0.01 },
  absoluteLift: 0.05,
  relativeLift: 0.5,
  ci95: [0.01, 0.09],
  minSampleSizeMet: true,
  verdict: 'treatment_better',
  note: 'Treatment is ahead.',
};

const text = () => document.body.textContent ?? '';

describe('holdout card units (#794)', () => {
  it('renders the absolute lift and its interval in percentage points', () => {
    render(<HoldoutCard result={result} />);

    expect(text()).toContain('+5.0 pp');
    expect(text()).toContain('95% CI +1.0 pp to +9.0 pp');
    // The relative lift stays a percent: it is a ratio, not a difference.
    expect(text()).toContain('(50% relative)');
    // The conversion rates are rates, so they keep the percent formatter.
    expect(text()).toContain('15%');
  });

  it('signs a negative lift and keeps a zero lift unsigned in points', () => {
    render(<HoldoutCard result={{ ...result, absoluteLift: -0.05, ci95: [-0.09, -0.01], verdict: 'treatment_worse' }} />);
    expect(text()).toContain('−5.0 pp');
    expect(text()).toContain('95% CI −9.0 pp to −1.0 pp');

    render(<HoldoutCard result={{ ...result, absoluteLift: 0, ci95: [0, 0] }} />);
    expect(text()).toContain('0.0 pp');
  });
});

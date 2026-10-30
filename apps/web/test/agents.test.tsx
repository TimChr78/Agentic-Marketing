import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionBadge } from '../src/features/agents/AgentStatus';
import { AutonomyCard } from '../src/features/agents/AutonomyCard';
import { type Autonomy, decisionBadge } from '../src/features/agents/labels';

afterEach(cleanup);

const defaults: Autonomy = {
  switch: 'on',
  maxLevel: {},
  allowLoops: false,
  audienceThreshold: 1000,
  limits: { changesPerDay: 500, messagesPerDay: 1000 },
};

describe('agent decisions (#213)', () => {
  it('names each policy decision in words, not colour alone', () => {
    expect(decisionBadge('allow')).toEqual({ label: 'Allowed', tone: 'good' });
    expect(decisionBadge('ask')).toEqual({ label: 'Waited for a person', tone: 'warn' });
    expect(decisionBadge('deny')).toEqual({ label: 'Refused', tone: 'bad' });

    render(<DecisionBadge decision="ask" />);
    expect(screen.getByText('Waited for a person')).toBeTruthy();
  });
});

describe('autonomy form (#215)', () => {
  it('renders the defaults and saves only what changed, with levels defaulting to 1', async () => {
    const onSave = vi.fn(async () => {});
    render(<AutonomyCard settings={defaults} canEdit onSave={onSave} />);

    expect(screen.getByRole('radio', { name: /^On/ })).toHaveProperty('checked', true);
    expect(screen.getByLabelText('Audience threshold')).toHaveProperty('value', '1000');
    expect(screen.getByLabelText('Changes per day')).toHaveProperty('value', '500');
    expect(screen.getByLabelText('Messages per day')).toHaveProperty('value', '1000');
    expect(screen.getByLabelText('Allow level 4 (run the loop)')).toHaveProperty('checked', false);
    expect(screen.getByLabelText('Highest level for Broadcast sends')).toHaveProperty('value', '1');
    expect(screen.getByRole('button', { name: 'Save autonomy' })).toHaveProperty('disabled', true);

    const threshold = screen.getByLabelText('Audience threshold');
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '2000');
    await userEvent.selectOptions(screen.getByLabelText('Highest level for Broadcast sends'), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Save autonomy' }));

    expect(onSave).toHaveBeenCalledWith({ audienceThreshold: 2000, maxLevel: { 'send.broadcast': 3 } });
  });

  it('shows the settings read-only to people who cannot change them', () => {
    render(<AutonomyCard settings={defaults} canEdit={false} onSave={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Save autonomy' })).toBeNull();
    expect(screen.getByText('1,000 people')).toBeTruthy();
    expect(screen.getByText(/Only owners and admins can change these/)).toBeTruthy();
  });
});

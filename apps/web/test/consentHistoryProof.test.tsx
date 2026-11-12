import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConsentHistoryTable } from '../src/features/audience/consent';

// #594: the ledger table printed every proof key, so a role without profiles:pii could read the
// IP address, user agent and page the server now withholds. The table shows the withheld state,
// keeps the non-personal evidence it receives, and never prints a hidden field.

describe('ConsentHistoryTable proof privacy (#594)', () => {
  it('shows that the proof is hidden for the role, without any personal field', () => {
    const { container } = render(
      <ConsentHistoryTable
        purposes={[{ key: 'marketing_email', name: 'Marketing e-mail' }]}
        records={[
          {
            purpose: 'marketing_email',
            channel: 'email',
            status: 'granted',
            basis: 'consent',
            source: 'form',
            proof: { messageId: 'msg_594', form_id: 'form_594' },
            proofWithheld: true,
            recordedAt: '2026-11-05T09:00:00.000Z',
            recordedBy: null,
          },
        ]}
      />,
    );
    expect(screen.getByText('Hidden for your role')).toBeTruthy();
    // The evidence a marketing role may see stays on screen.
    expect(container.textContent).toContain('messageId: msg_594');
    expect(container.textContent).not.toMatch(/userAgent|203\.0\.113\.7|preferences\?email/i);
  });

  it('shows only the source and the hidden marker when every proof field was withheld', () => {
    const { container } = render(
      <ConsentHistoryTable
        records={[
          {
            purpose: 'analytics',
            channel: '',
            status: 'denied',
            basis: 'consent',
            source: 'sdk',
            proof: {},
            proofWithheld: true,
            recordedAt: '2026-11-05T09:00:00.000Z',
            recordedBy: null,
          },
        ]}
      />,
    );
    expect(screen.getByText('Hidden for your role')).toBeTruthy();
    expect(screen.getByText('sdk')).toBeTruthy();
    expect(container.textContent).not.toMatch(/\bip:|userAgent/);
  });

  it('renders the fixed import label a role without profiles:pii receives (#672)', () => {
    const { container } = render(
      <ConsentHistoryTable
        records={[
          {
            purpose: 'marketing_email',
            channel: 'email',
            status: 'granted',
            basis: 'consent',
            source: 'import',
            proof: { import_label: 'Imported', import_batch: 'imp_1' },
            proofWithheld: true,
            recordedAt: '2026-11-05T09:00:00.000Z',
            recordedBy: null,
          },
        ]}
      />,
    );
    expect(container.textContent).toContain('import label: Imported');
    expect(screen.getByText('Hidden for your role')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Alice Smith/);
  });

  it('prints the full proof when the role may see it', () => {
    const { container } = render(
      <ConsentHistoryTable
        records={[
          {
            purpose: 'marketing_email',
            channel: 'email',
            status: 'granted',
            basis: 'consent',
            source: 'sdk',
            proof: { messageId: 'msg_594', ip: '203.0.113.7' },
            proofWithheld: false,
            recordedAt: '2026-11-05T09:00:00.000Z',
            recordedBy: null,
          },
        ]}
      />,
    );
    expect(container.textContent).toContain('ip: 203.0.113.7');
    expect(screen.queryByText('Hidden for your role')).toBeNull();
  });
});

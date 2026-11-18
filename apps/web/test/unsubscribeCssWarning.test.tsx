import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #872: CSS the unsubscribe-link check cannot evaluate is a warning the author can see and act on,
// never a blocking finding. It appears in the checks panel and in the template editor's preview.

const MESSAGE = "The unsubscribe link's visibility depends on CSS we can't evaluate (`@media`): check it in a client preview.";

const h = vi.hoisted(() => ({
  check: {
    version: 1,
    findings: [
      {
        id: 'compliance.unsubscribe-css:0a1b2c3d4e',
        severity: 'warning' as const,
        category: 'compliance' as const,
        message: "The unsubscribe link's visibility depends on CSS we can't evaluate (`@media`): check it in a client preview.",
        location: 'mjml',
        fix: 'Check the footer in a mail client, or simplify the styles that decide whether the unsubscribe link shows.',
      },
    ],
    checkedAt: '2026-11-17T10:00:00Z',
    summary: { blocking: 0, warning: 1, info: 0 },
  },
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string) => {
        if (name === 'templates.check') return Promise.resolve(h.check);
        if (name === 'templates.preview')
          return Promise.resolve({
            version: 1,
            subject: 'A calm subject',
            preheader: '',
            html: '<html><body><p>Hi</p></body></html>',
            text: 'Hi',
            warnings: [],
          });
        return Promise.reject(new Error(`unexpected ${name}`));
      }),
    },
  };
});

import { ChecksPanel } from '../src/features/previews/ChecksPanel';
import { EditorPreview } from '../src/features/templates/EditorPreview';

const eml = `eml_${'a'.repeat(32)}`;
const content = {
  subject: 'A calm subject',
  preheader: '',
  mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>',
};

afterEach(cleanup);

describe('the unsubscribe CSS warning is visible and non-blocking (#872)', () => {
  it('shows the warning in the checks panel under Warnings, not Blocking', async () => {
    render(<ChecksPanel artifactId={eml} version={1} />);

    const warnings = await screen.findByRole('region', { name: 'Warnings' });
    expect(warnings.textContent).toContain("depends on CSS we can't evaluate");
    expect(warnings.textContent).toContain('`@media`');
    expect(screen.queryByRole('region', { name: 'Blocking' })).toBeNull();
    expect(screen.getByText(/0 blocking · 1 warnings · 0 notes/)).toBeTruthy();
  });

  it('shows the same warning in the template editor preview', async () => {
    render(<EditorPreview artifactId={eml} version={1} content={content} dirty={false} />);

    expect(await screen.findByText(MESSAGE)).toBeTruthy();
    expect(screen.queryByText(/Blocking \(/)).toBeNull();
  });
});

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 25 review: a preview result is keyed by the exact source it rendered. Moving to another
// artifact/version, or saving a draft in place, must never leave the previous body under the new
// provenance label.

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: Record<string, unknown> }[],
  pending: new Map<number, (value: unknown) => void>(),
  revision: 0,
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        const version = Number(input.version ?? 1);
        if (h.pending.has(version))
          return new Promise((resolve) => {
            h.pending.set(version, (value) => {
              h.pending.delete(version);
              resolve(value);
            });
          });
        if (name === 'templates.check')
          return Promise.resolve({
            version,
            findings: [],
            checkedAt: '2026-11-06T10:32:00Z',
            summary: { blocking: 0, warning: 0, info: 0 },
          });
        if (name === 'blocks.preview') {
          const subject = version === 1 ? 'The previous block' : `The new block ${h.revision}`;
          return Promise.resolve({ version, html: `<html><body>${subject}</body></html>`, warnings: [] });
        }
        const subject = version === 1 ? 'The previous message' : `The new message ${h.revision}`;
        return Promise.resolve({
          version,
          subject,
          preheader: '',
          html: `<html><body><p>${subject}</p></body></html>`,
          text: subject,
          warnings: [],
        });
      }),
    },
  };
});

import { BlockPreview } from '../src/features/previews/BlockPreview';
import { EmailPreview } from '../src/features/previews/EmailPreview';
import { EditorPreview } from '../src/features/templates/EditorPreview';

const eml = `eml_${'a'.repeat(32)}`;
const blk = `blk_${'b'.repeat(32)}`;

const content = (subject: string) => ({
  subject,
  preheader: '',
  mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Body</mj-text></mj-column></mj-section></mj-body></mjml>',
});

beforeEach(() => {
  h.calls.length = 0;
  h.pending.clear();
  h.revision = 0;
  localStorage.clear();
});

afterEach(cleanup);

describe('preview results are keyed by their exact source (#499 review)', () => {
  it('hides the previous e-mail render while the next version loads', async () => {
    const { rerender } = render(<EmailPreview artifactId={eml} version={1} source={{ kind: 'saved', version: 1 }} />);
    expect(await screen.findByText('The previous message')).toBeTruthy();

    h.pending.set(2, () => {});
    h.revision = 2;
    rerender(<EmailPreview artifactId={eml} version={2} source={{ kind: 'saved', version: 2 }} />);

    expect(await screen.findByRole('status', { name: 'Rendering the e-mail' })).toBeTruthy();
    expect(screen.queryByText('The previous message')).toBeNull();

    h.pending.get(2)?.({
      version: 2,
      subject: 'The new message 2',
      preheader: '',
      html: '<html><body><p>The new message 2</p></body></html>',
      text: 'The new message 2',
      warnings: [],
    });
    expect(await screen.findByText('The new message 2')).toBeTruthy();
    expect(screen.queryByText('The previous message')).toBeNull();
  });

  it('hides a saved e-mail render after a save updates the draft in place', async () => {
    const { rerender } = render(<EditorPreview artifactId={eml} version={1} content={content('Before the save')} dirty={false} />);
    expect(await screen.findByText('The previous message')).toBeTruthy();

    h.pending.set(1, () => {});
    rerender(<EditorPreview artifactId={eml} version={1} content={content('After the save')} dirty={false} />);

    expect(await screen.findByRole('status', { name: 'Rendering the e-mail' })).toBeTruthy();
    expect(screen.queryByText('The previous message')).toBeNull();
    // A second read was made for the new saved revision, even though the version number is the same.
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'templates.preview')).toHaveLength(2));
  });

  it('hides the previous block render while the next block version loads', async () => {
    const { rerender } = render(<BlockPreview artifactId={blk} version={1} source={{ kind: 'saved', version: 1 }} />);
    expect(await screen.findByText('Rendered from version 1 with the block’s default parameters.')).toBeTruthy();

    h.pending.set(2, () => {});
    rerender(<BlockPreview artifactId={blk} version={2} source={{ kind: 'saved', version: 2 }} />);
    expect(await screen.findByRole('status', { name: 'Rendering the block' })).toBeTruthy();
    expect(screen.queryByText(/Rendered from version 1/)).toBeNull();
  });
});

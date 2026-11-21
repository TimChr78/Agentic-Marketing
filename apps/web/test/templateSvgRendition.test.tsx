import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TemplateEditor } from '../src/features/templates/TemplateEditor';

// #1172: mail clients strip SVG, so an SVG asset picks its PNG rendition for the inserted image.

const h = vi.hoisted(() => ({ changed: [] as { mjml: string }[] }));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'purposes.list') return { source: 'published', purposes: [] };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/features/templates/VisualMjml', async () => {
  const React = await import('react');
  return { default: React.forwardRef(() => React.createElement('div', { 'data-testid': 'visual-mjml' })) };
});

vi.mock('../src/features/assets/AssetPicker', () => ({
  AssetPicker: ({ onPick }: { onPick: (asset: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        onPick({
          id: `ast_${'a'.repeat(32)}`,
          name: 'Logo',
          url: 'https://cdn.example/logo.svg',
          altText: 'Logo',
          rendition: { url: 'https://cdn.example/logo.png' },
        })
      }
    >
      Pick the logo
    </button>
  ),
}));

afterEach(cleanup);

describe('template image insertion (#1172)', () => {
  it('inserts an SVG asset’s PNG rendition', async () => {
    render(
      <TemplateEditor
        artifact={
          {
            id: `eml_${'a'.repeat(32)}`,
            type: 'email_template',
            latestVersion: 1,
            publishedVersion: null,
            version: { number: 1, state: 'draft', content: { purpose: 'marketing_email', subject: 'Hi', mjml: '<mjml></mjml>' } },
          } as never
        }
        content={{ purpose: 'marketing_email', subject: 'Hi', mjml: '<mjml></mjml>' }}
        onChange={(content) => h.changed.push(content as { mjml: string })}
        readOnly={false}
        errors={{}}
        warnings={[]}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Insert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pick the logo' }));

    await waitFor(() => expect(h.changed.length).toBeGreaterThan(0));
    const mjml = h.changed.at(-1)!.mjml;
    expect(mjml).toContain('https://cdn.example/logo.png');
    expect(mjml).not.toContain('logo.svg');
  });
});

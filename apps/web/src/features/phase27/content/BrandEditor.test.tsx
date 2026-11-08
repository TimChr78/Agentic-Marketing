import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrandContent, BrandEditor } from '../../brand/BrandEditor';
import { DEFAULT_COPY } from '../../brand/defaults';

afterEach(cleanup);

const content: BrandContent = {
  siteName: 'Northstar Journal',
  siteUrl: 'https://example.com',
  language: 'en',
  logoUrl: 'https://example.com/logo.svg',
  logoAlt: 'Northstar Journal',
  logoHeight: 32,
  colors: { accent: '#2457d6', text: '#888888' },
  fontStack: 'Georgia, "Times New Roman", serif',
  radius: 12,
  copy: { confirmTitle: 'Confirm your subscription' },
  archive: {
    enabled: true,
    title: 'The journal',
    slug: 'journal',
    description: 'Every issue in one place.',
    subscribeUrl: 'https://example.com/signup',
  },
};

const renderEditor = (over: Partial<BrandContent> = {}, readOnly = false) => {
  const onChange = vi.fn();
  render(
    <BrandEditor
      artifact={{ version: { content } } as never}
      content={{ ...content, ...over }}
      onChange={onChange}
      readOnly={readOnly}
      errors={{}}
      warnings={[]}
    />,
  );
  return onChange;
};

describe('Brand editor (#526)', () => {
  it('keeps Identity, Appearance, Page wording and Newsletter archive sections', () => {
    renderEditor();
    for (const name of ['Identity', 'Appearance', 'Page wording', 'Newsletter archive']) {
      expect(screen.getByRole('heading', { name })).toBeTruthy();
    }
  });

  it('retains every identity, logo, appearance and archive field', () => {
    renderEditor();
    for (const label of [
      'Site name',
      'Site address',
      'Language',
      'Logo alt text',
      'Logo height',
      'Font',
      'Corner radius',
      'Archive title',
      'Archive address',
      'Description',
      'Subscribe link',
    ])
      expect(screen.getByLabelText(new RegExp(`^${label}`))).toBeTruthy();
    expect(screen.getByLabelText('Publish a newsletter archive')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change logo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    // Seven colour fields, each with a native picker and a hex input.
    for (const colour of ['Page background', 'Card', 'Text', 'Secondary text', 'Button and links', 'Button text', 'Borders'])
      expect(screen.getByLabelText(`${colour} colour picker`)).toBeTruthy();
    expect(screen.getAllByRole('textbox', { name: /^Text$/ }).length).toBeGreaterThan(0);
  });

  it('shows low-contrast warnings with text and a preview swatch', () => {
    renderEditor();
    const alert = screen.getByText('Low contrast').closest('[role="alert"]') ?? screen.getByText('Low contrast').parentElement;
    expect(alert?.textContent).toContain('Text on page background');
    expect(alert?.textContent).toContain('needs 4.5:1');
    expect(alert?.querySelector('[aria-hidden="true"]')?.textContent).toBe('Aa');
  });

  it('retains every copy key, including the back-to-site placeholder', () => {
    renderEditor();
    for (const [key, value] of Object.entries(DEFAULT_COPY)) {
      expect(screen.getAllByText(new RegExp(`Default: “${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)).length).toBeGreaterThan(0);
      if (key === 'backToSite') expect(screen.getAllByText(/becomes the site name/).length).toBeGreaterThan(0);
    }
    expect(screen.getByLabelText('Confirm title')).toBeTruthy();
    expect(screen.getByLabelText('Confirm button')).toBeTruthy();
    expect(screen.getByLabelText('Unsubscribed text')).toBeTruthy();
  });

  it('edits a field through onChange and keeps read-only fields readable', () => {
    const onChange = renderEditor();
    fireEvent.change(screen.getByLabelText(/^Site name/), { target: { value: 'New name' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ siteName: 'New name' }));
    cleanup();
    renderEditor({}, true);
    expect(screen.getByLabelText(/^Site name/)).toHaveProperty('readOnly', true);
    expect(screen.queryByRole('button', { name: 'Change logo' })).toBeNull();
  });
});

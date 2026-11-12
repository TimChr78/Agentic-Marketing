import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FormEditor } from './FormEditor';

// #598: the hosted-page override switch keeps its values in the saved content while it is off, so
// a save (or Ctrl+S) no longer destroys the colours and wording the UI promises to keep.

vi.mock('../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'purposes.list')
          return {
            source: 'default',
            purposes: [
              {
                key: 'marketing_email',
                name: 'Marketing e-mail',
                description: 'News and offers by e-mail.',
                basis: 'consent',
                channels: ['email'],
                requiresDoubleOptIn: true,
                topics: [],
              },
            ],
          };
        if (name === 'hostedPages.preview') return { html: '<p>Confirm your subscription</p>' };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

afterEach(cleanup);

const override = { colors: { accent: '#123456' }, copy: { confirmTitle: 'Our own title' } };
const content = {
  purposes: ['marketing_email'],
  doubleOptIn: false,
  consentText: 'Send me the newsletter.',
  successUrl: 'https://example.com/thanks',
  hostedPages: override,
};

type Draft = Record<string, unknown>;

function Harness({ initial, onDraft }: { initial: Draft; onDraft?: (draft: Draft) => void }) {
  const [draft, setDraft] = useState<Draft>(initial);
  return (
    <FormEditor
      artifact={{ id: `frm_${'a'.repeat(32)}`, latestVersion: 3 } as never}
      content={draft as never}
      onChange={(next) => {
        setDraft(next as Draft);
        onDraft?.(next as Draft);
      }}
      readOnly={false}
      errors={{}}
      warnings={[]}
    />
  );
}

const overrideSwitch = () => screen.getByRole('switch', { name: /different look/ });

describe('the hosted-page override switch (#598)', () => {
  it('keeps the override values in the draft when it is switched off', () => {
    let latest: Draft = {};
    render(<Harness initial={content} onDraft={(d) => (latest = d)} />);
    expect(overrideSwitch().getAttribute('aria-checked')).toBe('true');

    fireEvent.click(overrideSwitch());

    expect(latest.hostedPages).toEqual(override);
    expect(latest.hostedPagesEnabled).toBe(false);
  });

  it('restores them after a save and reload, then switching it back on', () => {
    const saved = { ...content, hostedPagesEnabled: false };
    let latest: Draft = {};
    render(<Harness initial={saved} onDraft={(d) => (latest = d)} />);
    // Saved with the override off: the switch is off, the values are still in the content.
    expect(overrideSwitch().getAttribute('aria-checked')).toBe('false');
    expect(latest).toEqual({});

    fireEvent.click(overrideSwitch());

    expect(latest.hostedPages).toEqual(override);
    expect(latest.hostedPagesEnabled).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Accent colour' }) as HTMLInputElement).value).toBe('#123456');
    expect((screen.getByRole('textbox', { name: 'Confirm page title' }) as HTMLTextAreaElement).value).toBe('Our own title');
  });

  it('starts from an empty override when the form never had one', () => {
    let latest: Draft = {};
    const withoutOverride: Draft = { ...content };
    delete withoutOverride.hostedPages;
    render(<Harness initial={withoutOverride} onDraft={(d) => (latest = d)} />);
    expect(overrideSwitch().getAttribute('aria-checked')).toBe('false');

    fireEvent.click(overrideSwitch());

    expect(latest.hostedPages).toEqual({});
    expect(latest.hostedPagesEnabled).toBe(true);
  });
});

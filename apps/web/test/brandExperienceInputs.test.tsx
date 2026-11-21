import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExperienceEditor } from '../src/features/artifacts/ExperienceEditor';
import { type BrandContent, BrandFields } from '../src/features/brand/BrandEditor';
import { FONT_PRESETS } from '../src/features/brand/defaults';

// #1171: custom font mode is local UI state, variant cards keep their identity while the id is
// edited, and a goal event keeps its spaces until blur.

vi.mock('../src/features/assets/AssetPicker', () => ({ AssetPicker: () => null }));

afterEach(cleanup);

function BrandHarness({ initial }: { initial: BrandContent }) {
  const [value, setValue] = useState(initial);
  return <BrandFields value={value} onChange={setValue} readOnly={false} errors={{}} />;
}

describe('brand editor inputs (#1171)', () => {
  it('offers a custom font stack from any preset', () => {
    render(<BrandHarness initial={{ fontStack: FONT_PRESETS[0]!.value }} />);
    fireEvent.change(screen.getByLabelText('Font'), { target: { value: '__custom' } });
    expect(screen.getByLabelText('Custom font stack')).toBeTruthy();
  });

  it('removes an empty archive slug so the draft can pass validation', () => {
    const onChange = vi.fn();
    render(<BrandFields value={{ archive: { enabled: true, slug: 'signal' } }} onChange={onChange} readOnly={false} errors={{}} />);
    fireEvent.change(screen.getByLabelText(/Archive address/), { target: { value: '' } });
    expect(onChange).toHaveBeenCalled();
    const archive = (onChange.mock.lastCall![0] as BrandContent).archive;
    expect(archive).toBeDefined();
    expect('slug' in archive!).toBe(false);
    expect(archive).toEqual({ enabled: true });
  });
});

function ExperienceHarness({ initial }: { initial: Record<string, unknown> }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ExperienceEditor
        artifact={{ version: { content: initial } } as never}
        content={value as never}
        onChange={(next) => setValue(next as Record<string, unknown>)}
        readOnly={false}
        errors={{}}
        warnings={[]}
      />
      <output data-testid="experience-content">{JSON.stringify(value)}</output>
    </>
  );
}

const experience = (overrides: Record<string, unknown> = {}) => ({
  placement: 'article-footer',
  variants: [{ id: 'a', name: 'Variant A', weight: 100, content: { html: '<p>A</p>' } }],
  ...overrides,
});

describe('experience editor inputs (#1171)', () => {
  it('keeps the same variant input mounted while its id changes', () => {
    const content = experience();
    render(<ExperienceHarness initial={content} />);
    const input = screen.getByLabelText('Id of variant 1') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'ab' } });
    expect(input.value).toBe('ab');
    expect(screen.getByLabelText('Id of variant 1')).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it('types spaces in the goal event and trims them on blur', async () => {
    render(<ExperienceHarness initial={experience()} />);
    const event = screen.getByLabelText('Goal event') as HTMLInputElement;
    await userEvent.type(event, 'Newsletter Signup ');
    expect(event.value).toBe('Newsletter Signup ');
    fireEvent.blur(event);
    expect(event.value).toBe('Newsletter Signup');
    expect(JSON.parse(screen.getByTestId('experience-content').textContent!).goal).toEqual({ event: 'Newsletter Signup' });
  });
});

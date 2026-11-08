import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/ui/Button';

// Phase 28 (#555 review): a button that can show the static progress glyph reserves the glyph slot
// in its idle state, so the busy state never changes the button's width. jsdom lays nothing out, so
// the assertion is on the reserved slot's own box: it must be present and equally sized in both
// states, and only the busy state may hold the progress glyph.

const slot = () => document.querySelector('[data-button-slot]') as HTMLElement | null;

describe('button progress slot (#555 review)', () => {
  it('reserves the same glyph box when idle and busy', () => {
    const { rerender } = render(<Button loading={false}>Save changes</Button>);
    const idle = slot();
    expect(idle).not.toBeNull();
    expect(idle!.style.width).toBe('16px');
    expect(idle!.style.height).toBe('16px');
    expect(idle!.querySelector('svg')).toBeNull();
    expect(screen.getByRole('button').textContent).toBe('Save changes');

    rerender(<Button loading>Save changes</Button>);
    const busy = slot();
    expect(busy).not.toBeNull();
    expect(busy!.style.width).toBe(idle!.style.width);
    expect(busy!.style.height).toBe(idle!.style.height);
    expect(busy!.querySelector('svg.am-progress')).not.toBeNull();
    expect(screen.getByRole('button').textContent).toBe('Save changes');
  });

  it('uses the small glyph box on a small button', () => {
    const { rerender } = render(
      <Button size="sm" loading={false}>
        Save
      </Button>,
    );
    expect(slot()!.style.width).toBe('14px');
    rerender(
      <Button size="sm" loading>
        Save
      </Button>,
    );
    const busy = slot()!;
    expect(busy.style.width).toBe('');
    expect(busy.querySelector('svg.am-progress')?.getAttribute('width')).toBe('14');
    expect(busy.querySelector('svg.am-progress')?.getAttribute('height')).toBe('14');
  });

  it('leaves a button that never shows progress exactly as before', () => {
    render(<Button>Save</Button>);
    expect(slot()).toBeNull();
  });
});

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Input } from '../src/ui/form';

// A search icon inside an input needs its left padding at every width; the responsive default
// padding used to override `pl-8` from 768 px up, so the icon sat on the placeholder.
describe('Input padding', () => {
  it('keeps a caller’s left padding at every breakpoint', () => {
    const { getByLabelText } = render(<Input aria-label="Search" compact className="pl-8" />);
    const cls = getByLabelText('Search').className;
    expect(cls).toContain('pl-8');
    expect(cls).not.toMatch(/(^|\s)(md:)?px-/);
  });

  it('pads both sides by default', () => {
    const { getByLabelText } = render(<Input aria-label="Name" />);
    expect(getByLabelText('Name').className).toMatch(/(^|\s)md:px-2\.5(\s|$)/);
  });
});

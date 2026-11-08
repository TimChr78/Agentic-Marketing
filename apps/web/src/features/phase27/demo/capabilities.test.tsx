import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CapabilitiesProvider, DEMO_CAPABILITIES, DEMO_RESTRICTION_REASON } from '../../../app/capabilities';
import { Button, IconButton } from '../../../ui';

afterEach(cleanup);

describe('shared capability primitives (#530)', () => {
  it('leaves mutation controls enabled by default', () => {
    render(<Button mutation>Save draft</Button>);
    const button = screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('data-demo-blocked')).toBe(false);
  });

  it('disables marked mutation controls in a restricted surface and explains why', () => {
    render(
      <CapabilitiesProvider value={DEMO_CAPABILITIES}>
        <Button mutation>Save draft</Button>
        <IconButton mutation label="Delete provider" icon={<span />} />
      </CapabilitiesProvider>,
    );
    const button = screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe(DEMO_RESTRICTION_REASON);
    expect(button.getAttribute('data-demo-blocked')).toBe('true');
    expect(button.getAttribute('aria-description')).toBe(DEMO_RESTRICTION_REASON);

    const icon = screen.getByRole('button', { name: 'Delete provider' }) as HTMLButtonElement;
    expect(icon.disabled).toBe(true);
    expect(icon.getAttribute('title')).toContain(DEMO_RESTRICTION_REASON);
  });

  it('does not disable a control that does not change data', () => {
    render(
      <CapabilitiesProvider value={DEMO_CAPABILITIES}>
        <Button>Refresh</Button>
      </CapabilitiesProvider>,
    );
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

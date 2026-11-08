import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilitiesProvider, DEMO_CAPABILITIES, DEMO_RESTRICTION_REASON } from '../../../app/capabilities';
import { Button, IconButton, Select } from '../../../ui';

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

  it('keeps a caller-provided aria-description on an unrestricted select', () => {
    render(
      <CapabilitiesProvider value={DEMO_CAPABILITIES}>
        <Select aria-label="Destination" aria-description="Pick where the copy goes">
          <option>Newsletter</option>
        </Select>
      </CapabilitiesProvider>,
    );
    const select = screen.getByRole('combobox', { name: 'Destination' }) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(select.getAttribute('aria-description')).toBe('Pick where the copy goes');
  });

  it('replaces the caller description with the demo reason on a blocked select', () => {
    render(
      <CapabilitiesProvider value={DEMO_CAPABILITIES}>
        <Select mutation aria-label="Role" aria-description="Pick where the copy goes">
          <option>Admin</option>
        </Select>
      </CapabilitiesProvider>,
    );
    const select = screen.getByRole('combobox', { name: 'Role' }) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.getAttribute('aria-description')).toBe(DEMO_RESTRICTION_REASON);
  });

  it('never runs a blocked select onChange, even for a synthetic change event', () => {
    const onChange = vi.fn();
    render(
      <CapabilitiesProvider value={DEMO_CAPABILITIES}>
        <Select mutation aria-label="Role" onChange={onChange}>
          <option value="admin">Admin</option>
          <option value="viewer">Viewer</option>
        </Select>
      </CapabilitiesProvider>,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: 'viewer' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('still runs an unrestricted select onChange', () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Role" onChange={onChange}>
        <option value="admin">Admin</option>
        <option value="viewer">Viewer</option>
      </Select>,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: 'viewer' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

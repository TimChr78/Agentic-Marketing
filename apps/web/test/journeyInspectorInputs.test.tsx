import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Inspector } from '../src/features/journey/Inspector';
import type { JNode } from '../src/features/journey/model';

// #1170: the waitUntil segment mode, raw comma-separated options and a decimal profile value are
// all editable inputs, not values that snap back on the next render.

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'u1' }, workspace: { id: 'ws_1' } }),
}));

vi.mock('../src/features/artifacts/ArtifactSelect', () => ({
  ArtifactSelect: () => <select aria-label="Segment" />,
}));

afterEach(cleanup);

function Harness({ node: initial }: { node: JNode }) {
  const [node, setNode] = useState(initial);
  return (
    <Inspector
      node={node}
      nodes={[node]}
      warnings={[]}
      readOnly={false}
      onChange={setNode}
      onConnect={() => {}}
      onDelete={() => {}}
      onDuplicate={() => {}}
    />
  );
}

const waitUntil = (condition: Record<string, unknown>): JNode => ({
  id: 'n1',
  kind: 'waitUntil',
  label: 'Wait until engaged',
  config: { condition },
});

describe('journey inspector inputs (#1170)', () => {
  it('keeps the waitUntil segment mode when the segment is still empty', () => {
    render(<Harness node={waitUntil({ segment: '' })} />);
    expect(screen.getByRole('radio', { name: 'Is in a segment' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Matches a condition' }).getAttribute('aria-checked')).toBe('false');
  });

  it('keeps a trailing comma in the aiDecide options while typing', () => {
    render(
      <Harness
        node={{
          id: 'n2',
          kind: 'aiDecide',
          label: 'Ask the model',
          config: { options: ['a', 'b'] },
        }}
      />,
    );
    const options = screen.getByLabelText('Options') as HTMLInputElement;
    fireEvent.change(options, { target: { value: 'a, b, ' } });
    expect(options.value).toBe('a, b, ');
  });

  it('keeps decimals and spaces in the updateProfile value until blur', () => {
    render(
      <Harness
        node={{
          id: 'n3',
          kind: 'updateProfile',
          label: 'Set score',
          config: { trait: 'score', value: 1 },
        }}
      />,
    );
    const value = screen.getByLabelText('Value') as HTMLInputElement;
    fireEvent.change(value, { target: { value: '1.' } });
    expect(value.value).toBe('1.');
    fireEvent.blur(value);
    expect(value.value).toBe('1');
    fireEvent.change(value, { target: { value: ' ' } });
    expect(value.value).toBe(' ');
    fireEvent.blur(value);
    expect(value.value).toBe(' ');
  });
});

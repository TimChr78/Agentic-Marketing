import { describe, expect, it } from 'vitest';
import { fieldErrors, formErrors } from '../src/ui/form';

describe('server validation errors on fields (#40)', () => {
  it('maps a treeified zod error to dotted field paths, with an optional prefix', () => {
    // The shape z.treeifyError produces (as returned in ApiError.details).
    const tree = {
      errors: [],
      properties: {
        serverToken: { errors: ['Too small: expected string to have >=10 characters'] },
        nested: { errors: [], properties: { port: { errors: ['Invalid input: expected number'] } } },
        list: { errors: [], items: [{ errors: ['Invalid input: expected string'] }] },
      },
    };
    const errs = fieldErrors(tree, 'secrets');
    expect(Object.keys(errs).sort()).toEqual(['secrets.list.0', 'secrets.nested.port', 'secrets.serverToken']);
    expect(errs['secrets.serverToken']).toMatch(/10/);
  });
  it('returns form-level messages and tolerates unknown shapes', () => {
    expect(formErrors({ errors: ['Give a name'] })).toEqual(['Give a name']);
    expect(fieldErrors(undefined)).toEqual({});
    expect(formErrors('nope')).toEqual([]);
  });
});

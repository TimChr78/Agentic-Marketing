import { describe, expect, it } from 'vitest';
import {
  addVariant,
  moveVariant,
  nextVariantId,
  removeVariant,
  targetingKind,
  triggerFor,
  updateVariant,
  variantWeightTotal,
  type ExperienceVariant,
} from '../src/features/artifacts/ExperienceEditor';
import {
  addPurpose,
  changeBasis,
  isKeyLocked,
  removePurpose,
  updatePurpose,
  type Purpose,
} from '../src/features/artifacts/PurposesEditor';

const variant = (id: string, weight: number): ExperienceVariant => ({ id, name: `Variant ${id}`, weight, content: { html: `<p>${id}</p>` } });

const purpose = (patch: Partial<Purpose> = {}): Purpose => ({
  key: 'marketing_email',
  name: 'Marketing e-mail',
  description: 'News and offers.',
  basis: 'consent',
  channels: ['email'],
  requiresDoubleOptIn: false,
  ...patch,
});

describe('experience editor content (#57)', () => {
  it('shows variant weights as percentages and adds a variant with a free id', () => {
    const variants = [variant('a', 50), variant('b', 30)];
    expect(variantWeightTotal(variants)).toBe(80);
    expect(variantWeightTotal(undefined)).toBe(0);

    const added = addVariant(variants);
    expect(added.map((v) => v.id)).toEqual(['a', 'b', 'c']);
    expect(added[2]).toMatchObject({ name: 'Variant C', weight: 50, content: { html: '' } });
    expect(nextVariantId([variant('a', 10), variant('b', 10)])).toBe('c');
  });

  it('updates, moves and removes variants without touching the others', () => {
    const variants = [variant('a', 50), variant('b', 30), variant('c', 20)];
    expect(updateVariant(variants, 1, { weight: 60 }).map((v) => v.weight)).toEqual([50, 60, 20]);
    expect(moveVariant(variants, 0, 1).map((v) => v.id)).toEqual(['b', 'a', 'c']);
    expect(moveVariant(variants, 2, 1).map((v) => v.id)).toEqual(['a', 'b', 'c']);
    expect(moveVariant(variants, 0, -1).map((v) => v.id)).toEqual(['a', 'b', 'c']);
    expect(removeVariant(variants, 1).map((v) => v.id)).toEqual(['a', 'c']);
  });

  it('drops a trigger value when the trigger does not use one', () => {
    expect(triggerFor('scroll', { type: 'time_on_page', value: 20 })).toEqual({ type: 'scroll', value: 20 });
    expect(triggerFor('time_on_page', undefined)).toEqual({ type: 'time_on_page', value: 15 });
    expect(triggerFor('immediate', { type: 'scroll', value: 50 })).toEqual({ type: 'immediate' });
    expect(triggerFor('exit_intent', { type: 'scroll', value: 50 })).toEqual({ type: 'exit_intent' });
  });

  it('recognises the targeting the form can edit and leaves the rest to JSON', () => {
    expect(targetingKind(undefined)).toBe('everyone');
    expect(targetingKind({ segment: 'seg_00000000000000000000000000000000' })).toBe('segment');
    expect(targetingKind({ page: { pathPrefix: '/blog' } })).toBe('custom');
    expect(targetingKind({ all: [{ device: 'mobile' }] })).toBe('custom');
  });
});

describe('purposes editor content (#57)', () => {
  it('adds a valid starter purpose and keeps the existing ones', () => {
    const added = addPurpose([purpose()]);
    expect(added).toHaveLength(2);
    expect(added[1]).toMatchObject({ key: 'purpose_2', name: 'New purpose', basis: 'consent', channels: [] });
    expect(addPurpose([purpose({ key: 'purpose_2' })])[1].key).toBe('purpose_3');
  });

  it('edits a description and removes a purpose', () => {
    const list = [purpose(), purpose({ key: 'analytics', name: 'Analytics', channels: ['web'] })];
    expect(updatePurpose(list, 0, { description: 'Weekly news and offers.' })[0].description).toBe('Weekly news and offers.');
    expect(updatePurpose(list, 0, { description: 'x' })[1]).toEqual(list[1]);
    expect(removePurpose(list, 0).map((p) => p.key)).toEqual(['analytics']);
  });

  it('keeps an LIA only for legitimate interest and locks keys that are in force', () => {
    const withLia = changeBasis(purpose(), 'legitimate_interest');
    expect(withLia.lia).toEqual({ assessment: '', owner: '', reviewBy: '' });
    expect(changeBasis(withLia, 'contract').lia).toBeUndefined();
    expect(isKeyLocked('marketing_email', ['marketing_email', 'analytics'])).toBe(true);
    expect(isKeyLocked('new_purpose', ['marketing_email'])).toBe(false);
  });
});

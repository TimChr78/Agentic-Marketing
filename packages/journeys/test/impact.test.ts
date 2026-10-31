import { describe, expect, it } from 'vitest';
import { journeyTouchesOf } from '../src/impact';

// #264: what publishing or enrolling into a journey touches, for the agent policy engine. The
// derivation is pure: the definition in, the places it reaches out.

const definition = {
  purpose: 'marketing_email',
  nodes: [
    { id: 'trigger', kind: 'trigger', label: 'Joins a segment', config: { segment: 'seg_a' } },
    { id: 'email', kind: 'email', label: 'Welcome', config: { template: 'eml_a' } },
    {
      id: 'branch',
      kind: 'branch',
      label: 'Is a member?',
      config: { condition: { all: [{ segment: 'seg_b' }, { trait: 'city', op: 'exists' }] } },
      next: [{ to: 'sms' }, { to: 'wait' }],
    },
    { id: 'sms', kind: 'sms', label: 'Ping', config: { template: 'sms_a' } },
    { id: 'wait', kind: 'waitUntil', label: 'Wait for consent', config: { condition: { segment: 'seg_c' }, timeout: 'P1D' } },
    { id: 'done', kind: 'exit', label: 'Done', config: {} },
  ],
};

describe('what a journey touches (#264)', () => {
  it('reports its purpose, message channels, entry and condition segments, and step templates', () => {
    const { touches, templates } = journeyTouchesOf(definition);
    expect(touches.purposes).toEqual(['marketing_email']);
    expect(touches.channels).toEqual(['email', 'sms']);
    expect(touches.segments).toEqual(['seg_a', 'seg_b', 'seg_c']);
    expect(templates).toEqual(['eml_a', 'sms_a']);
    // Topics come from the templates' own content; the definition carries none.
    expect(touches.topics).toEqual([]);
    expect(touches.artifacts).toEqual([]);
  });

  it('deduplicates channels and segments, and reports none for an event trigger', () => {
    const { touches } = journeyTouchesOf({
      purpose: 'onboarding',
      nodes: [
        { id: 'trigger', kind: 'trigger', label: 'Signed up', config: { event: 'Signed Up' } },
        { id: 'first', kind: 'email', label: 'One', config: { template: 'eml_a' } },
        { id: 'second', kind: 'email', label: 'Two', config: { template: 'eml_b' } },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    });
    expect(touches.purposes).toEqual(['onboarding']);
    expect(touches.channels).toEqual(['email']);
    expect(touches.segments).toEqual([]);
  });

  it('reports no purpose, channel or segment for an unreadable definition', () => {
    const { touches } = journeyTouchesOf(undefined);
    expect(touches).toEqual({ segments: [], purposes: [], topics: [], channels: [], artifacts: [] });
  });
});

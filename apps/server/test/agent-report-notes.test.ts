import { AppError } from '@agentic-marketing/core';
import { describe, expect, it } from 'vitest';
import { outcomeNote } from '../src/agents/report';

// #885 round 9: agents.report and agents.compare put a failed journey or goal measurement into the
// response note. An unexpected exception (the event store, a driver) must not reach the caller.
describe('agent outcome notes', () => {
  it('uses a fixed note for an unexpected failure', () => {
    const note = outcomeNote(new Error('driver failure: password=probe-secret'), 'The journey result could not be computed.');
    expect(note).toBe('The journey result could not be computed.');
  });

  it('keeps an expected failure’s message, redacted', () => {
    expect(outcomeNote(new AppError('invalid_input', 'This measure needs a conversion map.'), 'x')).toBe(
      'This measure needs a conversion map.',
    );
    expect(outcomeNote(new AppError('invalid_input', 'bad: password=probe-secret'), 'x')).not.toContain('probe-secret');
  });
});

import { describe, expect, it } from 'vitest';
import { parseVerdict } from '../src/independentCheck';

// The independent check (#231) reads a strict JSON verdict from the model's text.

describe('the independent check verdict', () => {
  it('reads plain JSON and JSON in a Markdown fence', () => {
    expect(parseVerdict('{"match": true, "reason": "It sends the weekly issue."}')).toEqual({
      match: true,
      reason: 'It sends the weekly issue.',
    });
    expect(parseVerdict('```json\n{"match": false, "reason": "Wrong audience."}\n```')).toEqual({
      match: false,
      reason: 'Wrong audience.',
    });
    expect(parseVerdict('Sure:\n{"match": true, "reason": "ok"}')).toEqual({ match: true, reason: 'ok' });
  });

  it('rejects anything that is not the verdict', () => {
    expect(() => parseVerdict('Looks fine to me.')).toThrow('did not answer with a JSON verdict');
    expect(() => parseVerdict('{"match": "yes"}')).toThrow('was not {"match": boolean, "reason": string}');
    expect(() => parseVerdict('{"match": true, "reason": ')).toThrow();
  });

  it('stays fast on long runs of whitespace (no regex over model output)', () => {
    const started = Date.now();
    expect(() => parseVerdict(`\`\`\`${' '.repeat(200_000)}x`)).toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

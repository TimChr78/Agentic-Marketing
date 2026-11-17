import { describe, expect, it } from 'vitest';
import { fakeLlm } from '../src/testing';

describe('fake LLM server (#1014)', () => {
  it('answers malformed JSON with an error instead of leaving the request hanging', async () => {
    const llm = await fakeLlm(() => ({ text: 'unused' }));
    try {
      const res = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
        signal: AbortSignal.timeout(2_000),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { message: 'invalid JSON' } });
      expect(llm.requests).toHaveLength(0);
    } finally {
      await llm.close();
    }
  });
});

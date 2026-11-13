import { AppError } from '@agentic-marketing/core';
import { describe, expect, it } from 'vitest';
import { copilotFailureText } from '../src/http/copilot';

// #885 round 10: a failed copilot turn streamed the exception's text to the browser (any member,
// including a viewer) and stored it with the conversation. Provider errors can echo credentials.
describe('copilot failure text', () => {
  it('uses a fixed text for an unexpected failure', () => {
    expect(copilotFailureText(new Error('provider failure: password=probe-secret'))).toBe('an unexpected error occurred');
  });

  it('reports only the status of a provider HTTP error', () => {
    const err = Object.assign(new Error('Bad Request: password=probe-secret'), { name: 'AI_APICallError', statusCode: 400 });
    const text = copilotFailureText(err);
    expect(text).toBe('the AI provider answered HTTP 400');
  });

  it('keeps an expected failure’s message, redacted', () => {
    expect(copilotFailureText(new AppError('conflict', 'The workspace AI budget is used up.'))).toBe('The workspace AI budget is used up.');
    expect(copilotFailureText(new AppError('conflict', 'bad: password=probe-secret'))).not.toContain('probe-secret');
  });
});

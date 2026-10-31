import type { MandateView, PolicyOutcome } from '@agentic-marketing/commands';
import { describe, expect, it } from 'vitest';
import { checkPrompt, checkSubjectJson, MAX_SUBJECT_CHARS, parseVerdict } from '../src/independentCheck';

// The independent check (#231) reads a strict JSON verdict from the model's text, and (#261)
// shows the model what is published: the content, the diff and the template, scrubbed and capped.

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

const mandate: MandateView = {
  id: 'mnd_0123456789abcdef0123456789abcdef',
  version: 1,
  purpose: 'Send the weekly newsletter',
  scope: { segments: [], purposes: ['marketing_email'], channels: ['email'], topics: [], artifactTypes: [], artifacts: [] },
  limits: {},
  holdWindow: 'PT2H',
  independentCheck: true,
  guardrails: { window: 'P7D', minSent: 100 },
  levels: { 'content.publish': 3 },
};
const policy = {
  decision: 'allow',
  level: 3,
  actionClass: 'content.publish',
  autonomous: true,
  reasons: [],
  impact: {},
} as PolicyOutcome;
const base = {
  principal: { type: 'agent', userId: 'agt_0123456789abcdef0123456789abcdef', workspaceId: 'ws' },
  command: 'artifacts.requestPublish',
  input: { artifactId: 'eml_0123456789abcdef0123456789abcdef', note: 'Send this week’s issue' },
  intent: 'Send this week’s issue',
  policy,
  mandate,
} as never;

describe('the published content in the check prompt (#261)', () => {
  it('shows the content and diff in its own untrusted block', () => {
    const prompt = checkPrompt({
      ...(base as object),
      subject: {
        artifacts: [
          {
            type: 'email_template',
            name: 'Issue 43',
            version: 4,
            publishedVersion: 3,
            content: { subject: 'The signal this week', mjml: '<mjml><mj-body>Hej</mj-body></mjml>' },
            diff: { from: 3, to: 4, changes: [{ path: 'mjml', kind: 'changed', before: 'Old', after: 'New' }] },
          },
        ],
      },
    } as never);
    expect(prompt).toContain('<published-content>');
    expect(prompt).toContain('The signal this week');
    expect(prompt).toContain('"kind":"changed"');
    expect(prompt.indexOf('<action-input>')).toBeLessThan(prompt.indexOf('<published-content>'));
  });

  it('leaves the block out when there is no subject', () => {
    expect(checkPrompt(base)).not.toContain('<published-content>');
  });

  it('scrubs secrets and personal data before the model sees them', () => {
    const json = checkSubjectJson({
      apiKey: 'sk-live-0123456789',
      content: { mjml: 'Write to ada@example.com or call +46 70 123 45 67', note: 'card 4111 1111 1111 1111' },
    });
    expect(json).not.toContain('sk-live-0123456789');
    expect(json).not.toContain('ada@example.com');
    expect(json).not.toContain('4111 1111 1111 1111');
    expect(json).toContain('[redacted]');
    expect(json).toContain('[email]');
  });

  it('keeps a long template and caps the whole subject at 20,000 characters', () => {
    const body = 'x'.repeat(5_000);
    const kept = checkSubjectJson({ content: { mjml: body } });
    expect(kept.length).toBeLessThan(MAX_SUBJECT_CHARS);
    expect(kept).toContain('x'.repeat(5_000));

    const capped = checkSubjectJson({ content: { mjml: 'y'.repeat(50_000) } });
    expect(capped.length).toBeLessThanOrEqual(MAX_SUBJECT_CHARS + 20);
    expect(capped.endsWith('…[truncated]')).toBe(true);
  });
});

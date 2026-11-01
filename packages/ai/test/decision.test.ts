import type { DecisionQuestion } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import { personalDataIn } from '../src/context';
import {
  callSystemOne,
  checkDecisionLimits,
  DecisionError,
  type DecisionProvider,
  MAX_QUESTIONS,
  MAX_REQUEST_TOKENS,
  parseSystemOneAnswers,
  systemOneRequest,
  systemOneUrl,
  wireQuestions,
} from '../src/decision';
import { fakeSystemOne } from '../src/testing';

// The System One mapping and its limits (#194): the request keeps the key out of the model's
// view, the answers are normalised to a probability, and a request outside 100 questions or
// 64K tokens never leaves the server. The response shape is TypeSafe's own, confirmed at
// docs.typesafe.ai/api/system-one.

const noul: DecisionQuestion = { key: 'propensity', type: 'noul', instructions: 'Will this person convert?' };
const choice: DecisionQuestion = {
  key: 'channel',
  type: 'choice',
  instructions: 'Which channel fits?',
  criteria: { email: 'E-mail', sms: 'SMS', push: 'Push' },
};
const score: DecisionQuestion = {
  key: 'intent',
  type: 'score',
  instructions: 'How strong is the intent?',
  criteria: ['Low', 'Medium', 'High'],
};

describe('the System One request', () => {
  it('maps each typed question to the provider shape, keyed by the answer key', () => {
    const body = systemOneRequest('typesafe/jev', { plan: 'pro' }, [noul, choice, score]);
    expect(body).toEqual({
      model: 'typesafe/jev',
      state: { plan: 'pro' },
      questions: {
        propensity: { type: 'noul', instructions: 'Will this person convert?' },
        channel: {
          type: 'choice',
          instructions: 'Which channel fits?',
          criteria: { email: 'E-mail', sms: 'SMS', push: 'Push' },
        },
        intent: { type: 'score', instructions: 'How strong is the intent?', criteria: ['Low', 'Medium', 'High'] },
      },
    });
    expect(wireQuestions([noul]).propensity).not.toHaveProperty('key');
  });

  it('uses the same path on both endpoints', () => {
    expect(systemOneUrl('https://api.commandcode.ai/provider/v1')).toBe('https://api.commandcode.ai/provider/v1/systemone');
    expect(systemOneUrl('https://api.typesafe.ai/v1/')).toBe('https://api.typesafe.ai/v1/systemone');
    expect(systemOneUrl('http://localhost:1234/v1/systemone')).toBe('http://localhost:1234/v1/systemone');
  });

  it('enforces the 100-question limit', () => {
    const many = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({
      key: `q_${i}`,
      type: 'noul' as const,
      instructions: 'Will this happen?',
    }));
    expect(() => checkDecisionLimits('x', many)).toThrow(DecisionError);
    expect(() => checkDecisionLimits('x', many)).toThrow(`At most ${MAX_QUESTIONS}`);
    // The command's input schema refuses it before the adapter is reached.
    expect(() => systemOneRequest('typesafe/jev', 'x', many)).toThrow('<=100');
  });

  it('refuses a state and questions over the 64K-token limit before the request', () => {
    const text = 'x'.repeat(MAX_REQUEST_TOKENS * 4 + 100);
    expect(() => systemOneRequest('typesafe/jev', text, [noul])).toThrow('the limit is 64000');
  });

  it('refuses duplicate answer keys', () => {
    expect(() => systemOneRequest('typesafe/jev', 'x', [noul, { ...noul, instructions: 'Again?' }])).toThrow('Duplicate question key');
  });
});

describe('the System One response', () => {
  it('normalises noul, choice and score answers to a 0–1 probability', () => {
    const r = parseSystemOneAnswers([noul, choice, score], {
      model: 'jev-1.14.0',
      answers: {
        propensity: { type: 'noul', noul: 0.82 },
        channel: { type: 'choice', choice: 'email', confidence: 0.7, probabilities: { email: 0.7, sms: 0.2, push: 0.1 } },
        intent: {
          type: 'score',
          score: 1.5,
          confidence: 0.5,
          legend: { 0: 'Low', 1: 'Medium', 2: 'High' },
          probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 },
        },
      },
    });
    expect(r.model).toBe('jev-1.14.0');
    expect(r.answers[0]).toMatchObject({ key: 'propensity', type: 'noul', probability: 0.82 });
    expect(r.answers[1]).toMatchObject({ key: 'channel', type: 'choice', probability: 0.7, label: 'email' });
    expect(r.answers[2]).toMatchObject({ key: 'intent', type: 'score', probability: 0.75, value: 1.5 });
  });

  it('rejects a missing, mistyped or out-of-range answer', () => {
    expect(() => parseSystemOneAnswers([noul], { model: 'x', answers: {} })).toThrow('is missing');
    expect(() => parseSystemOneAnswers([noul], { model: 'x', answers: { propensity: { type: 'choice', choice: 'a' } } })).toThrow(
      'not a noul',
    );
    expect(() => parseSystemOneAnswers([noul], { model: 'x', answers: { propensity: { type: 'noul', noul: 1.4 } } })).toThrow(
      'outside 0–1',
    );
  });

  it('calls the same endpoint shape over HTTP and reads usage', async () => {
    const fake = await fakeSystemOne((r) => ({
      answers: { propensity: { type: 'noul', noul: r.state === 'hot' ? 0.91 : 0.12 } },
      inputTokens: 137,
      outputTokens: 9,
    }));
    const provider: DecisionProvider = {
      providerId: 'aip_0123456789abcdef0123456789abcdef',
      model: 'typesafe/jev',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test',
      allowPersonalData: false,
    };
    try {
      const r = await callSystemOne(provider, 'hot', [noul]);
      expect(r).toMatchObject({ modelVersion: 'jev-test-1.0.0', inputTokens: 137, outputTokens: 9 });
      expect(r.answers[0].probability).toBe(0.91);
      expect(fake.requests[0]).toMatchObject({ model: 'typesafe/jev', apiKey: 'sk-test', state: 'hot' });
      expect(fake.requests[0].questions.propensity).toMatchObject({ type: 'noul' });
    } finally {
      await fake.close();
    }
  });

  it('turns a provider error into a DecisionError', async () => {
    const fake = await fakeSystemOne(() => ({ status: 422, error: 'zero data retention is not available' }));
    const provider: DecisionProvider = {
      providerId: 'aip_0123456789abcdef0123456789abcdef',
      model: 'typesafe/jev',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-test',
      allowPersonalData: false,
    };
    try {
      await expect(callSystemOne(provider, 'x', [noul])).rejects.toThrow('422: zero data retention is not available');
    } finally {
      await fake.close();
    }
  });
});

describe('the personal-data guard', () => {
  it('finds e-mail, phone and identifier keys in a state', () => {
    expect(personalDataIn({ message: 'write to ada@example.com' })).toBe('email');
    expect(personalDataIn({ note: 'call +45 12 34 56 78' })).toBe('phone');
    expect(personalDataIn({ email: 'not-an-address' })).toBe('identifier');
    expect(personalDataIn({ traits: { plan: 'pro' }, segments: ['seg_1'], eventCounts: { page: 3 } })).toBeNull();
  });
});

describe('systemOneUrl', () => {
  it('appends /systemone once and trims any number of trailing slashes quickly', () => {
    expect(systemOneUrl('https://api.commandcode.ai/provider/v1')).toBe('https://api.commandcode.ai/provider/v1/systemone');
    expect(systemOneUrl('https://api.typesafe.ai/v1///')).toBe('https://api.typesafe.ai/v1/systemone');
    expect(systemOneUrl('https://api.typesafe.ai/v1/systemone/')).toBe('https://api.typesafe.ai/v1/systemone');
    const started = Date.now();
    systemOneUrl(`https://x${'/'.repeat(100_000)}a`);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

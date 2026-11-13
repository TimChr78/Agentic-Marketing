import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DecisionQuestion } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import { personalDataIn } from '../src/context';
import {
  assertStateAllowed,
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

/** The fake provider listens on loopback; the real egress guard allows it when asked to. */
const local = { allowedHosts: ['127.0.0.1'] };

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

  it('rejects out-of-range probabilities, confidences and distributions (#353)', () => {
    const choiceAnswer = (over: Record<string, unknown>) => ({
      model: 'x',
      answers: { channel: { type: 'choice', choice: 'email', probabilities: { email: 0.7, sms: 0.3 }, ...over } },
    });
    expect(() => parseSystemOneAnswers([choice], choiceAnswer({ confidence: 5 }))).toThrow('confidence is outside 0–1');
    expect(() => parseSystemOneAnswers([choice], choiceAnswer({ confidence: -1 }))).toThrow('confidence is outside 0–1');
    expect(() =>
      parseSystemOneAnswers([choice], {
        model: 'x',
        answers: { channel: { type: 'choice', choice: 'email', probabilities: { email: 1.7, sms: -0.7 } } },
      }),
    ).toThrow('probability for email is outside 0–1');
  });

  it('rejects prototype keys instead of returning a function-valued probability (#361)', () => {
    for (const label of ['constructor', 'toString', '__proto__']) {
      expect(() =>
        parseSystemOneAnswers([choice], {
          model: 'x',
          answers: { channel: { type: 'choice', choice: label, probabilities: { email: 0.9, sms: 0.1 } } },
        }),
      ).toThrow('chose an unknown label');
    }
  });

  it('returns ordinary probability records that Drizzle can serialise as JSONB', () => {
    const r = parseSystemOneAnswers([choice], {
      model: 'x',
      answers: { channel: { type: 'choice', choice: 'email', probabilities: { email: 0.7, sms: 0.3 } } },
    });
    expect(Object.getPrototypeOf(r.answers[0].probabilities)).toBe(Object.prototype);
    expect(Object.hasOwn(r.answers[0].probabilities, 'email')).toBe(true);
  });

  it('rejects negative, fractional or non-finite token usage instead of corrupting the budget', async () => {
    const provider = (baseUrl: string): DecisionProvider => ({
      providerId: 'aip_0123456789abcdef0123456789abcdef',
      model: 'typesafe/jev',
      baseUrl,
      apiKey: 'sk-test',
      allowPersonalData: false,
    });
    const negative = await fakeSystemOne(() => ({
      answers: { propensity: { type: 'noul', noul: 0.91 } },
      inputTokens: -100,
      outputTokens: 9,
    }));
    try {
      await expect(callSystemOne(provider(negative.baseUrl), 'hot', [noul], { egress: local })).rejects.toThrow('invalid input_tokens');
    } finally {
      await negative.close();
    }
    const fractional = await fakeSystemOne(() => ({
      answers: { propensity: { type: 'noul', noul: 0.91 } },
      inputTokens: 1.5,
      outputTokens: 9,
    }));
    try {
      await expect(callSystemOne(provider(fractional.baseUrl), 'hot', [noul], { egress: local })).rejects.toThrow('invalid input_tokens');
    } finally {
      await fractional.close();
    }
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
      const r = await callSystemOne(provider, 'hot', [noul], { egress: local });
      expect(r).toMatchObject({ modelVersion: 'jev-test-1.0.0', inputTokens: 137, outputTokens: 9 });
      expect(r.answers[0].probability).toBe(0.91);
      expect(fake.requests[0]).toMatchObject({ model: 'typesafe/jev', apiKey: 'sk-test', state: 'hot' });
      expect(fake.requests[0].questions.propensity).toMatchObject({ type: 'noul' });
    } finally {
      await fake.close();
    }
  });

  it('refuses a private target before any socket opens and never sends the API key', async () => {
    const fake = await fakeSystemOne(() => ({ answers: { propensity: { type: 'noul', noul: 0.5 } } }));
    const provider: DecisionProvider = {
      providerId: 'aip_0123456789abcdef0123456789abcdef',
      model: 'typesafe/jev',
      // localhost is internal even though 127.0.0.1 is allowed below.
      baseUrl: fake.url.replace('127.0.0.1', 'localhost'),
      apiKey: 'sk-must-not-leave',
      allowPersonalData: false,
    };
    try {
      await expect(callSystemOne(provider, 'x', [noul], { egress: local })).rejects.toThrow(/localhost is an internal address/);
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it('aborts an oversized response at the reading bound', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'jev-test-1.0.0', answers: {}, padding: 'x'.repeat(64 * 1024) }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const provider: DecisionProvider = {
      providerId: 'aip_0123456789abcdef0123456789abcdef',
      model: 'typesafe/jev',
      baseUrl: url,
      apiKey: 'sk-test',
      allowPersonalData: false,
    };
    try {
      await expect(callSystemOne(provider, 'x', [noul], { egress: local, maxBytes: 1024 })).rejects.toThrow('response exceeds 1024 bytes');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
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
      await expect(callSystemOne(provider, 'x', [noul], { egress: local })).rejects.toThrow('422: zero data retention is not available');
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

  it('finds an e-mail nine or more levels down, where the old depth cap stopped (#352)', () => {
    let deep: Record<string, unknown> = { email: 'ada@example.com' };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    expect(personalDataIn(deep)).toBe('identifier');
    expect(personalDataIn({ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 'ada@example.com' } } } } } } } } } })).toBe('email');
  });

  it('sweeps the question text as well as the state', () => {
    const provider = { allowPersonalData: false, model: 'typesafe/jev' };
    expect(() => assertStateAllowed({ plan: 'pro' }, provider, [{ instructions: 'Write to ada@example.com' }])).toThrow(
      'A question contains email data',
    );
    expect(() => assertStateAllowed({ note: 'ada@example.com' }, provider, [{ instructions: 'Safe' }])).toThrow(
      'The state contains email data',
    );
    expect(() => assertStateAllowed({ plan: 'pro' }, provider, [{ instructions: 'Safe' }])).not.toThrow();
    expect(() => assertStateAllowed({ email: 'ada@example.com' }, { allowPersonalData: true, model: 'typesafe/jev' }, [])).not.toThrow();
  });

  it('treats choice labels as text, so an ordinary email/sms choice passes', () => {
    const provider = { allowPersonalData: false, model: 'typesafe/jev' };
    // "email" and "sms" are channel labels, not the person's address.
    expect(() => assertStateAllowed({ plan: 'pro' }, provider, [choice])).not.toThrow();
    expect(() =>
      assertStateAllowed({ plan: 'pro' }, provider, [{ ...choice, criteria: { email: 'E-mail', sms: 'ada@example.com' } }]),
    ).toThrow('A question contains email data');
    expect(() =>
      assertStateAllowed({ plan: 'pro' }, provider, [{ ...choice, criteria: { 'ada@example.com': 'E-mail', sms: 'SMS' } }]),
    ).toThrow('A question contains email data');
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

describe('provider diagnostics (#885)', () => {
  it('keeps a provider error to its own code and message, never its body', async () => {
    // A decision provider (or a gateway) that echoes the Authorization header must not have that
    // text copied into the DecisionError, which becomes an AppError the caller and audit log read.
    const server = createServer((_req, res) => {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: { code: 'unauthorized', message: 'Bearer probe-secret is not valid' },
          echo: { access_token: 'probe-secret' },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const provider: DecisionProvider = {
      providerId: 'aip_0123456789abcdef0123456789abcdef',
      model: 'typesafe/jev',
      baseUrl: url,
      apiKey: 'sk-test',
      allowPersonalData: false,
    };
    try {
      const err = (await callSystemOne(provider, 'x', [noul], { egress: local }).catch((e: unknown) => e)) as DecisionError;
      expect(err).toBeInstanceOf(DecisionError);
      expect(err.code).toBe('provider_error');
      expect(err.message).toContain('answered 401');
      expect(err.message).toContain('unauthorized');
      expect(err.message).toContain('Bearer [redacted]');
      expect(err.message).not.toContain('probe-secret');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

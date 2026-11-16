import { artifactTypes, type PromptDefinition } from '@agentic-marketing/artifacts';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { NoObjectGeneratedError } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runTestCase } from '../src/prompts';
import { estimatedUsage, usageOfError } from '../src/providers';
import { fakeLlm } from '../src/testing';

// #941: a failed call may still have been billed. The AI SDK's NoObjectGeneratedError carries the
// usage of the invalid answer; when nothing is known, the reserved estimate is recorded, not zero.

const decide = artifactTypes.prompt.content.parse({
  kind: 'decide',
  instructions: 'Pick one.',
  options: [
    { key: 'a', description: 'First' },
    { key: 'b', description: 'Second' },
  ],
  tests: [{ name: 'one', traits: {}, expect: { options: ['a'] } }],
}) as PromptDefinition;

describe('usage on a failed model call (#941)', () => {
  it('reads the usage an AI SDK error carries', () => {
    const error = new NoObjectGeneratedError({
      message: 'invalid answer',
      response: { id: 'r', modelId: 'm', timestamp: new Date() },
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        inputTokenDetails: { noCacheTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { reasoningTokens: 0, textTokens: 30 },
        totalTokens: 150,
      } as never,
      finishReason: 'stop',
    });
    expect(usageOfError(error)).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(usageOfError(new Error('no usage here'))).toBeNull();
    expect(usageOfError({ lastError: { usage: { inputTokens: 7, outputTokens: 3 } } })).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('splits a reserved estimate into input and output', () => {
    expect(estimatedUsage(500, 200)).toEqual({ inputTokens: 300, outputTokens: 200 });
    expect(estimatedUsage(100, 400)).toEqual({ inputTokens: 0, outputTokens: 100 });
  });
});

describe('runTestCase keeps billed usage (#941)', () => {
  let llm: Awaited<ReturnType<typeof fakeLlm>>;
  let mode: 'invalid' | 'fail' = 'invalid';
  beforeAll(async () => {
    llm = await fakeLlm(() => {
      if (mode === 'fail') return { status: 500, error: 'upstream exploded' };
      return { text: 'not the JSON the schema asked for', inputTokens: 50, outputTokens: 7 };
    });
  });
  afterAll(() => llm.close());
  const model = () => ({
    providerId: 'aip_x',
    modelId: 'm',
    model: createOpenAICompatible({ name: 't', baseURL: llm.baseUrl, apiKey: 'k', supportsStructuredOutputs: true })('m'),
  });

  it('records the usage of an invalid structured answer', async () => {
    mode = 'invalid';
    const r = await runTestCase(model(), decide, decide.tests[0], { reservedTokens: 900 });
    expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 7 });
    expect(r.estimated).toBe(false);
    expect(r.problems.join(' ')).toContain('model call failed');
  });

  it('records the reserved estimate when the provider error has no usage', async () => {
    mode = 'fail';
    const r = await runTestCase(model(), decide, decide.tests[0], { reservedTokens: 900 });
    expect(r.usage.inputTokens + r.usage.outputTokens).toBe(900);
    expect(r.estimated).toBe(true);
  });
});

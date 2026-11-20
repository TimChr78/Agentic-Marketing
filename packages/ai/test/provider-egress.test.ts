import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

// #1131: an openai-compatible or anthropic-compatible provider is a URL an admin sets, so it gets
// the same egress guard as webhooks, connectors and decision providers. The setting is checked when
// the provider is created or changed, and every model request is checked again at fetch time, with
// DNS pinning and no redirects, while still streaming the answer (the copilot streams).

vi.mock('@agentic-marketing/secrets', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agentic-marketing/secrets')>();
  return {
    ...original,
    // The commands seal and open keys through the database; this file exercises the URL guard.
    sealJson: async () => ({ blob: Buffer.alloc(48), keyId: 'k_test' }),
    openJson: async () => ({ apiKey: 'sk-test-0123456789' }),
  };
});

import { generateText, streamText } from 'ai';
import { createAiProvider, languageModel, updateAiProvider } from '../src/providers';
import { fakeLlm } from '../src/testing';

const row = (baseUrl: string, kind: 'openai-compatible' | 'anthropic-compatible' = 'openai-compatible') => ({
  id: `aip_${'1'.repeat(32)}`,
  workspaceId: '00000000-0000-4000-8000-000000000001',
  name: 'Model',
  kind,
  baseUrl,
  models: { default: 'gpt-test' },
  structuredOutputs: true,
  allowPersonalData: false,
  useFor: ['journeys'],
  monthlyTokenBudget: null,
  region: '',
  enabled: true,
  secrets: Buffer.alloc(48),
  secretsKeyId: 'k_test',
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

/** A transaction just deep enough for the provider commands' insert, select, update and usage read. */
function fakeCtx(egress = { allowedHosts: [] as string[] }) {
  const current = row('https://old.example.com/v1');
  const tx = {
    execute: async () => ({ rows: [{ n: '0' }] }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({ returning: async () => [{ ...current, ...values }] }),
    }),
    // `claimUses` awaits the rows directly, while the update handler narrows with `.where()`.
    select: () => ({ from: () => Object.assign(Promise.resolve([]), { where: async () => [current] }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({ where: () => ({ returning: async () => [{ ...current, ...values }] }) }),
    }),
  };
  return { tx, principal: { workspaceId: current.workspaceId }, services: { keyProvider: {}, egress } };
}

const settings = {
  name: 'Model',
  kind: 'openai-compatible' as const,
  baseUrl: 'https://api.example.com/v1',
  models: { default: 'gpt-test' },
  structuredOutputs: true,
  allowPersonalData: false,
  useFor: ['journeys' as const],
  monthlyTokenBudget: null,
  region: '',
};

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { message?: string }).message ?? String(err);
  }
  throw new Error('expected the call to be refused');
}

/** The messages of an error and its causes, so an SDK wrapper cannot hide the guard's reason. */
function errorText(err: unknown, depth = 0): string {
  const e = err as { message?: string; cause?: unknown };
  return `${e?.message ?? String(err)} ${depth < 3 && e?.cause ? errorText(e.cause, depth + 1) : ''}`;
}

describe('AI provider settings (#1131)', () => {
  it('refuses a metadata or loopback base URL when the provider is created', async () => {
    const metadata = await refusal(
      createAiProvider.handler({ ...settings, baseUrl: 'http://169.254.169.254/latest', apiKey: 'sk-test' }, fakeCtx() as never),
    );
    expect(metadata).toMatch(/169\.254\.169\.254 is a private address/);
    const loopback = await refusal(
      createAiProvider.handler({ ...settings, baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'sk-test' }, fakeCtx() as never),
    );
    expect(loopback).toMatch(/127\.0\.0\.1 is a private address/);
    const internal = await refusal(
      createAiProvider.handler({ ...settings, baseUrl: 'http://metadata.google.internal/', apiKey: 'sk-test' }, fakeCtx() as never),
    );
    expect(internal).toMatch(/internal address/);
  });

  it('refuses the same URLs when an existing provider is changed', async () => {
    const metadata = await refusal(
      updateAiProvider.handler({ id: row('x').id, baseUrl: 'http://169.254.169.254/latest' }, fakeCtx() as never),
    );
    expect(metadata).toMatch(/169\.254\.169\.254 is a private address/);
    const loopback = await refusal(updateAiProvider.handler({ id: row('x').id, baseUrl: 'http://localhost:11434/v1' }, fakeCtx() as never));
    expect(loopback).toMatch(/localhost is an internal address/);
  });

  it('keeps an allow-listed host working, for a local Ollama or a test server', async () => {
    const created = await createAiProvider.handler(
      { ...settings, baseUrl: 'http://127.0.0.1:11434/v1/', apiKey: 'sk-test' },
      fakeCtx({ allowedHosts: ['127.0.0.1'] }) as never,
    );
    expect(created.baseUrl).toBe('http://127.0.0.1:11434/v1');
    const updated = await updateAiProvider.handler(
      { id: row('x').id, baseUrl: 'http://localhost:11434/v1' },
      fakeCtx({ allowedHosts: ['localhost'] }) as never,
    );
    expect(updated.baseUrl).toBe('http://localhost:11434/v1');
  });
});

describe('model requests go through the egress guard (#1131)', () => {
  it('refuses a model call to a private address at fetch time', async () => {
    for (const kind of ['openai-compatible', 'anthropic-compatible'] as const) {
      const model = await languageModel(null as never, row('http://169.254.169.254/v1', kind) as never, {} as never, 'default', {
        allowedHosts: [],
      });
      const err = await generateText({ model: model.model, prompt: 'hello' }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(errorText(err)).toMatch(/169\.254\.169\.254 is a private address/);
    }
  });

  it('refuses a redirect from an allowed host instead of following it elsewhere', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const model = await languageModel(null as never, row(baseUrl) as never, {} as never, 'default', {
        allowedHosts: ['127.0.0.1'],
      });
      const err = await generateText({ model: model.model, prompt: 'hello' }).catch((e) => e);
      expect(errorText(err)).toMatch(/redirects are not followed/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('still calls an allow-listed host, streaming included', async () => {
    const llm = await fakeLlm((r) => ({ text: `answer for ${r.user}` }));
    try {
      const model = await languageModel(null as never, row(llm.baseUrl) as never, {} as never, 'default', {
        allowedHosts: ['127.0.0.1'],
      });
      const generated = await generateText({ model: model.model, prompt: 'hello' });
      expect(generated.text).toBe('answer for hello');

      const streamed = streamText({ model: model.model, prompt: 'stream' });
      expect(await streamed.text).toBe('answer for stream');
      expect(llm.requests.length).toBe(2);
    } finally {
      await llm.close();
    }
  });
});

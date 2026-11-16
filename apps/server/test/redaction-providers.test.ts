import { aiProviderKinds, modelProviderNames } from '@agentic-marketing/ai';
import { redactCredentials } from '@agentic-marketing/core';
import { adapters, pushAdapters, smsAdapters } from '@agentic-marketing/email';
import { connectors } from '@agentic-marketing/integrations';
import { describe, expect, it } from 'vitest';
import '@agentic-marketing/ads';

// #898: the qualifier list that makes `shopifyKey` a credential must keep up with the provider
// registries. This derives the ids from the code rather than from memory, so adding an adapter or
// a connector without a qualifier fails here instead of silently leaking a `<provider>Key` value.
// #956: model providers are workspace data, not a registry, so their names come from
// `modelProviderNames` in packages/ai; the same rule applies to a new one.

const SECRET = 'shortpw';

/** The spelling a provider key would use. `lmstudio` is `lmStudio` in camelCase. */
const CAMEL_OVERRIDES: Record<string, string> = { lmstudio: 'lmStudio' };
const camel = (id: string) =>
  CAMEL_OVERRIDES[id] ??
  id
    .split('_')
    .map((part, index) => (index === 0 ? part : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`))
    .join('');

const ids = [
  ...new Set([
    ...Object.keys(adapters),
    ...Object.keys(smsAdapters),
    ...Object.keys(pushAdapters),
    ...Object.keys(connectors),
    // `openai-compatible` → `openai`, `anthropic-compatible` → `anthropic`; `decision` is a use,
    // not a provider, and has no key.
    ...aiProviderKinds.map((kind) => kind.split('-')[0]!).filter((kind) => kind !== 'decision'),
    // The named model providers users configure with their own key (#956).
    ...modelProviderNames,
  ]),
].filter((id) => id !== 'log' && id !== 'http' && id !== 'oauth_http');

describe('every registered provider id qualifies its key (#898)', () => {
  it('reads a plausible list of providers', () => {
    expect(ids).toEqual(
      expect.arrayContaining(['smtp', 'postmark', 'twilio', 'fcm', 'apns', 'meta_ads', 'shopify', 'salesforce', 'slack', 'openai']),
    );
  });

  it('redacts <provider>Key and <provider>_key for every one of them', () => {
    const missed: string[] = [];
    for (const id of ids) {
      const names = [`${camel(id)}Key`, `${id}_key`, `${id}Key`];
      for (const name of names) {
        const bare = `${name}=${SECRET}`;
        const header = `X-${name.replaceAll('_', '-')}: ${SECRET}`;
        for (const input of [bare, header]) if (redactCredentials(input).includes(SECRET)) missed.push(input);
      }
    }
    expect(missed.slice(0, 10)).toEqual([]);
    expect(missed).toHaveLength(0);
  });
});

describe('every named model provider qualifies its key, token and secret (#956)', () => {
  it('covers the documented model providers', () => {
    expect([...modelProviderNames]).toEqual(
      expect.arrayContaining(['openai', 'anthropic', 'mistral', 'ollama', 'vllm', 'litellm', 'openrouter', 'lmstudio', 'bedrock']),
    );
    expect(modelProviderNames).toContain('gemini');
    expect(modelProviderNames).toContain('deepseek');
  });

  it('redacts <provider>Key, <provider>Token and <provider>Secret in camel, snake and kebab form', () => {
    const missed: string[] = [];
    for (const id of modelProviderNames) {
      const names = [camel(id), id, id.replaceAll('_', '-')];
      for (const name of names)
        for (const suffix of ['Key', 'Token', 'Secret']) {
          const key = `${name}${suffix}`;
          for (const input of [`${key}=${SECRET}`, `${name}_${suffix.toLowerCase()}=${SECRET}`, `X-${key}: ${SECRET}`])
            if (redactCredentials(input).includes(SECRET)) missed.push(input);
        }
    }
    expect(missed.slice(0, 10)).toEqual([]);
    expect(missed).toHaveLength(0);
  });
});

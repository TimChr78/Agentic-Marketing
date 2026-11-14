import { aiProviderKinds } from '@agentic-marketing/ai';
import { redactCredentials } from '@agentic-marketing/core';
import { adapters, pushAdapters, smsAdapters } from '@agentic-marketing/email';
import { connectors } from '@agentic-marketing/integrations';
import { describe, expect, it } from 'vitest';
import '@agentic-marketing/ads';

// #898: the qualifier list that makes `shopifyKey` a credential must keep up with the provider
// registries. This derives the ids from the code rather than from memory, so adding an adapter or
// a connector without a qualifier fails here instead of silently leaking a `<provider>Key` value.

const SECRET = 'shortpw';

/** `meta_ads` → `metaAds`, the camelCase spelling a provider key would use. */
const camel = (id: string) =>
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

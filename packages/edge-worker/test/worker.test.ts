import { writeKeyHash } from '@agentic-marketing/personalize/core';
import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/worker';

// The edge worker answers /v1/decide from what the scheduler wrote to KV, with the same rules as
// the server: write keys and origins, consent before people data, sticky variants, previews.

const ws = '00000000-0000-4000-8000-000000000001';
const seg = `seg_${'1'.repeat(32)}`;
const def = (over: Record<string, unknown>) => ({
  placement: 'hero',
  description: '',
  priority: 100,
  holdoutPercent: 0,
  analysis: { method: 'sequential', alpha: 0.05, threshold: 0.95 },
  trigger: { kind: 'load' },
  variants: [{ id: 'a', name: 'A', weight: 100, content: { html: '<p>Generic</p>' } }],
  ...over,
});

function env(): Env {
  const kv = new Map<string, unknown>([
    [
      `am:key:${writeKeyHash('wk_site')}`,
      { workspaceId: ws, kind: 'browser', requiredPurpose: null, enabled: true, allowedOrigins: ['https://shop.example.com'] },
    ],
    [
      `am:exp:${ws}`,
      {
        purposes: [{ key: 'web_personalization', basis: 'consent' }],
        experiences: [
          {
            id: 'exp_fans',
            version: 2,
            def: def({
              priority: 200,
              targeting: { segment: seg },
              variants: [
                { id: 'a', name: 'A', weight: 50, content: { html: '<p>Fans A</p>' } },
                { id: 'b', name: 'B', weight: 50, content: { html: '<p>Fans B</p>' } },
              ],
            }),
          },
          { id: 'exp_generic', version: 1, def: def({}) },
        ],
      },
    ],
    [`am:snap:${ws}:u:u-1`, { profileId: 'prf_1', traits: {}, segments: [seg], at: '' }],
  ]);
  return { AM_KV: { get: async (k) => kv.get(k) ?? null }, AM_CACHE_SECONDS: '0' };
}

const decide = (body: Record<string, unknown>, headers: Record<string, string> = { origin: 'https://shop.example.com' }) =>
  worker.fetch(
    new Request('https://shop.example.com/am/v1/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ writeKey: 'wk_site', placements: ['hero'], ...body }),
    }),
    env(),
  );
const consent = { consent: { categoryPreferences: { web_personalization: true } } };

describe('edge worker', () => {
  it('uses the snapshot only with consent', async () => {
    const yes = await (await decide({ userId: 'u-1', context: consent })).json();
    expect(yes).toMatchObject({ personalized: true, edge: true, decisions: [{ placement: 'hero', experienceId: 'exp_fans', version: 2 }] });
    const no = await (await decide({ userId: 'u-1' })).json();
    expect(no).toMatchObject({ personalized: false, decisions: [{ experienceId: 'exp_generic', variantId: 'a' }] });
  });

  it('keeps variants sticky per person and honours preview links', async () => {
    const first = (await (await decide({ userId: 'u-1', context: consent })).json()) as { decisions: { variantId: string }[] };
    const again = (await (await decide({ userId: 'u-1', context: consent })).json()) as { decisions: { variantId: string }[] };
    expect(again.decisions[0].variantId).toBe(first.decisions[0].variantId);
    const other = first.decisions[0].variantId === 'a' ? 'b' : 'a';
    const preview = await (await decide({ anonymousId: 'anon-9', preview: { experienceId: 'exp_fans', variantId: other } })).json();
    expect(preview).toMatchObject({
      decisions: [{ experienceId: 'exp_fans', variantId: other, content: { html: `<p>Fans ${other.toUpperCase()}</p>` } }],
    });
  });

  it('refuses unknown keys, other origins and bad input, and answers preflight', async () => {
    expect((await decide({ writeKey: 'wk_nope' })).status).toBe(401);
    expect((await decide({}, { origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await decide({ placements: [] })).status).toBe(400);
    const pre = await worker.fetch(
      new Request('https://shop.example.com/am/v1/decide', { method: 'OPTIONS', headers: { origin: 'https://shop.example.com' } }),
      env(),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
  });
});

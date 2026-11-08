import { describe, expect, it } from 'vitest';
import { parseCreateIntent } from '../src/app/createIntent';
import { navFor, SETTINGS_ITEMS, settingsPath, visibleNav, visibleSettings } from '../src/app/nav';
import { redirectTarget } from '../src/app/redirects';

// The role lists mirror packages/commands/src/principal.ts (ROLE_PERMISSIONS). The nav must hide what
// the role cannot use, and the hidden entries must never rely on role names.
const PERMISSIONS = [
  'artifacts:read',
  'artifacts:write',
  'artifacts:publish',
  'artifacts:approve',
  'messages:send',
  'audit:read',
  'profiles:read',
  'profiles:pii',
  'profiles:write',
  'profiles:erase',
  'secrets:read',
  'secrets:write',
  'workspace:admin',
] as const;
const ROLE = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  marketer: ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'messages:send', 'audit:read', 'profiles:read', 'profiles:write'],
  approver: ['artifacts:read', 'artifacts:approve', 'audit:read', 'profiles:read'],
  viewer: ['artifacts:read'],
} as const;
const can = (role: keyof typeof ROLE) => {
  const permissions = new Set<string>(ROLE[role]);
  return (permission: string) => permissions.has(permission);
};
const labels = (role: keyof typeof ROLE) => visibleNav(can(role)).flatMap((g) => g.items.map((i) => i.label));

describe('navigation visibility', () => {
  it('owner and admin see every work destination', () => {
    expect(labels('owner')).toHaveLength(18);
    expect(labels('admin')).toEqual(labels('owner'));
    expect(labels('owner')).toEqual([
      'Home',
      'Approvals',
      'Agents',
      'Campaigns',
      'Broadcasts',
      'Journeys',
      'Web experiences',
      'People',
      'Segments',
      'Forms',
      'Consent',
      'Templates',
      'Assets',
      'Brand',
      'Analytics',
      'Message activity',
      'Deliverability',
      'Alerts',
    ]);
  });

  it('a builder sees all work destinations and only public Settings', () => {
    expect(labels('marketer')).toHaveLength(18);
    expect(visibleSettings(can('marketer')).map((i) => i.label)).toEqual([
      'Integrations and API tokens',
      'Approval policy and agent autonomy',
    ]);
  });

  it('an approver sees People and artifacts:read rows but no creation-only entries', () => {
    expect(labels('approver')).toContain('People');
    expect(labels('approver')).toContain('Message activity');
    expect(labels('approver')).toContain('Consent');
    expect(visibleSettings(can('approver')).map((i) => i.label)).toEqual([
      'Integrations and API tokens',
      'Approval policy and agent autonomy',
    ]);
  });

  it('a viewer sees artifacts:read rows and Consent, without People or Message activity', () => {
    expect(labels('viewer')).toEqual([
      'Home',
      'Approvals',
      'Agents',
      'Campaigns',
      'Broadcasts',
      'Journeys',
      'Web experiences',
      'Segments',
      'Forms',
      'Consent',
      'Templates',
      'Assets',
      'Brand',
      'Analytics',
      'Deliverability',
      'Alerts',
    ]);
    expect(labels('viewer')).not.toContain('People');
    expect(labels('viewer')).not.toContain('Message activity');
    expect(visibleSettings(can('viewer')).map((i) => i.label)).toEqual([
      'Integrations and API tokens',
      'Approval policy and agent autonomy',
    ]);
  });

  it('opens Settings at the first permitted secondary item', () => {
    expect(settingsPath(can('owner'))).toBe('/settings/workspace');
    expect(settingsPath(can('viewer'))).toBe('/settings/integrations');
    expect(SETTINGS_ITEMS.map((i) => i.path)).toEqual([
      '/settings/workspace',
      '/settings/providers',
      '/settings/integrations',
      '/settings/secrets',
      '/settings/users',
      '/settings/approval-policy',
    ]);
  });
});

describe('navFor', () => {
  it('matches Home exactly and chooses the longest path', () => {
    expect(navFor('/')?.item?.label).toBe('Home');
    expect(navFor('/approvals/apr_1')?.item?.label).toBe('Approvals');
    expect(navFor('/work/agents/agt_1')?.item?.label).toBe('Agents');
    expect(navFor('/work/agents/library/prm_1')?.item?.label).toBe('Agents');
    expect(navFor('/audience/people/prf_1')?.item?.label).toBe('People');
    expect(navFor('/audience/consent')?.item?.label).toBe('Consent');
    expect(navFor('/content/templates/blocks/blk_1')?.item?.label).toBe('Templates');
  });

  it('keeps Settings children under Settings', () => {
    expect(navFor('/settings')?.group?.label).toBe('Settings');
    expect(navFor('/settings/workspace')?.item?.label).toBe('Workspace');
    expect(navFor('/settings/integrations/tokens/tok_1')?.item?.label).toBe('Integrations and API tokens');
    expect(navFor('/preferences')).toEqual({});
  });
});

describe('legacy redirects', () => {
  const table: [string, string, string][] = [
    ['/demo-signed-in', '', '/'],
    ['/build/campaigns', '', '/marketing/campaigns'],
    ['/build/campaigns/cmp_01', '', '/marketing/campaigns/cmp_01'],
    ['/build/broadcasts', '', '/marketing/broadcasts'],
    ['/build/broadcasts/brd_01', '', '/marketing/broadcasts/brd_01'],
    ['/build/journeys', '', '/marketing/journeys'],
    ['/build/journeys/jrn_01', '', '/marketing/journeys/jrn_01'],
    ['/build/experiences', '', '/marketing/experiences'],
    ['/build/experiences/exp_01', '', '/marketing/experiences/exp_01'],
    ['/build/segments', '', '/audience/segments'],
    ['/build/segments/seg_01', '', '/audience/segments/seg_01'],
    ['/build/forms', '', '/audience/forms'],
    ['/build/forms/frm_01', '', '/audience/forms/frm_01'],
    ['/build/prompts', '', '/work/agents?tab=library'],
    ['/build/prompts/prm_01', '', '/work/agents/library/prm_01'],
    ['/build/topics', '', '/audience/consent?tab=topics'],
    ['/build/recipes', '', '/content/templates?tab=starters'],
    ['/design/templates', '', '/content/templates'],
    ['/design/templates/tpl_01', '', '/content/templates/tpl_01'],
    ['/design/blocks', '', '/content/templates?tab=blocks'],
    ['/design/blocks/blk_01', '', '/content/templates/blocks/blk_01'],
    ['/design/assets', '', '/content/assets'],
    ['/design/hosted-pages', '', '/content/brand?tab=subscriber-pages'],
    ['/design/brand', '', '/content/brand'],
    ['/audience/imports', '', '/audience/people?tab=imports'],
    ['/settings/agents', '', '/work/agents'],
    ['/settings/agents/agt_01', '', '/work/agents/agt_01'],
    ['/settings/purposes', '', '/audience/consent?tab=purposes'],
    ['/settings/preferences', '', '/preferences'],
    ['/insights/ai', '', '/insights/analytics?tab=ai'],
    ['/insights/journeys', '', '/marketing/journeys?view=reports'],
  ];

  for (const [from, query, to] of table)
    it(`${from}${query} → ${to}`, () => {
      expect(redirectTarget(from, new URLSearchParams(query))).toBe(to);
    });

  it('preserves other query values and the hash, and lets the destination tab win', () => {
    expect(redirectTarget('/build/campaigns', new URLSearchParams('tab=report&page=2'), '#top')).toBe(
      '/marketing/campaigns?tab=report&page=2#top',
    );
    expect(redirectTarget('/build/topics', new URLSearchParams('tab=old&x=1'))).toBe('/audience/consent?tab=topics&x=1');
    expect(redirectTarget('/settings/agents/agt_01', new URLSearchParams('x=1'), '#activity')).toBe('/work/agents/agt_01?x=1#activity');
    expect(redirectTarget('/settings/preferences', new URLSearchParams('tab=theme'), '#appearance')).toBe(
      '/preferences?tab=theme#appearance',
    );
  });

  it('carries an encoded id once', () => {
    expect(redirectTarget('/build/campaigns/cmp_01%2F02', new URLSearchParams())).toBe('/marketing/campaigns/cmp_01%2F02');
  });

  it('does not silently discard an unknown tail', () => {
    expect(redirectTarget('/build/campaigns/cmp_01/extra', new URLSearchParams())).toBeNull();
    expect(redirectTarget('/design/templates/tpl_01/extra', new URLSearchParams())).toBeNull();
    expect(redirectTarget('/insights/journeys/jrn_01', new URLSearchParams())).toBeNull();
  });

  it('maps the Journey stats query selection to the journey Report tab', () => {
    expect(redirectTarget('/insights/journeys', new URLSearchParams('journey=jrn_42&from=2026-10-01'), '#waiting')).toBe(
      '/marketing/journeys/jrn_42?from=2026-10-01&tab=report#waiting',
    );
    expect(redirectTarget('/insights/journeys', new URLSearchParams('journey='))).toBe('/marketing/journeys?view=reports&invalidJourney=1');
    expect(redirectTarget('/insights/journeys', new URLSearchParams('journey=not a journey'))).toBe(
      '/marketing/journeys?view=reports&invalidJourney=1',
    );
  });

  it('leaves canonical and unknown URLs alone', () => {
    expect(redirectTarget('/marketing/campaigns', new URLSearchParams())).toBeNull();
    expect(redirectTarget('/approvals', new URLSearchParams())).toBeNull();
    expect(redirectTarget('/audience/people', new URLSearchParams('tab=imports'))).toBeNull();
  });
});

describe('create intent', () => {
  it('accepts known create types only', () => {
    expect(parseCreateIntent(new URLSearchParams('create=broadcast'))).toBe('broadcast');
    expect(parseCreateIntent(new URLSearchParams('create=email_block'))).toBe('email_block');
    expect(parseCreateIntent(new URLSearchParams('create=unknown'))).toBeNull();
    expect(parseCreateIntent(new URLSearchParams())).toBeNull();
  });
});

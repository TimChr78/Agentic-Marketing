import { describe, expect, it } from 'vitest';
import {
  buildReadPlan,
  type ConsequenceInput,
  type ConsequenceRow,
  dependencyRefs,
  deriveConsequences,
  deriveProposalConsequences,
  humanDuration,
} from '../src/features/approvals/consequences';

// #498: every artifact kind gets a consequence summary. These tests pin the rows the contract
// names, the missing-versus-empty distinction, and the exact read plan (unique id/version, and no
// restricted read at all).

const id = (prefix: string, char: string) => `${prefix}_${char.repeat(32)}`;
const eml = id('eml', 'a');
const seg = id('seg', 'd');
const blk = id('blk', 'e');
const jrn = id('jrn', '1');

const formatWhen = (iso: string | null | undefined) => iso ?? '—';

function base(overrides: Partial<ConsequenceInput> = {}): ConsequenceInput {
  return {
    artifactId: id('bct', '9'),
    type: 'email_template',
    name: 'Weekly Signal #44',
    version: 4,
    publishedVersion: 3,
    latestVersion: 4,
    status: 'pending',
    content: {},
    formatWhen,
    ...overrides,
  };
}

const row = (rows: ConsequenceRow[], key: string) => rows.find((r) => r.key === key);

describe('approval consequence rows (#498)', () => {
  it('heads a pending request with “If approved” and a decided one with “Decision context”', () => {
    expect(deriveConsequences(base()).heading).toBe('If approved');
    expect(deriveConsequences(base({ status: 'approved' })).heading).toBe('Decision context');
  });

  it('states what publishes and whether it replaces a live version', () => {
    const changed = deriveConsequences(base());
    expect(row(changed.rows, 'publishes')?.value).toBe('Weekly Signal #44 · E-mail template · Saved v4');
    expect(row(changed.rows, 'publishes')?.notes).toEqual(['Replaces Published v3']);
    const first = deriveConsequences(base({ publishedVersion: null }));
    expect(row(first.rows, 'publishes')?.notes).toEqual(['Nothing live yet']);
  });

  it('uses the reviewed schedule for a broadcast and “On approval” for everything else', () => {
    const broadcast = deriveConsequences(
      base({
        type: 'broadcast',
        content: { template: eml, segment: seg, sendAt: '2026-11-09T09:00:00Z' },
      }),
    );
    expect(row(broadcast.rows, 'when')?.value).toBe('2026-11-09T09:00:00Z');
    expect(deriveConsequences(base()).rows.find((r) => r.key === 'when')?.value).toBe('On approval');
  });

  it('lists template, segment, purpose, schedule details, tests and archive for a broadcast', () => {
    const model = deriveConsequences(
      base({
        type: 'broadcast',
        content: {
          template: eml,
          segment: seg,
          topic: 'weekly',
          sendAt: '2026-11-09T09:00:00Z',
          sendWindow: { start: '09:00', end: '17:00', days: ['mon', 'tue'], maxDelay: 'P1D' },
          subjectTest: { subjects: ['A', 'B'], samplePercent: 20, metric: 'click', decideAfter: 'PT4H' },
          archive: { publish: true, slug: 'signal-43', summary: 'The issue' },
        },
        bundleVersions: { [eml]: 3, [seg]: 2 },
        dependencies: {
          [eml]: { id: eml, name: 'Weekly Signal #43', publishedVersion: 2 },
          [seg]: { id: seg, name: 'Engaged readers', publishedVersion: 2 },
        },
        purposes: [{ key: 'marketing_email', name: 'Marketing e-mail', basis: 'consent', channels: ['email'] }],
        templatePurpose: { purpose: 'marketing_email', topic: 'weekly' },
        dependenciesLoading: false,
      }),
    );
    expect(row(model.rows, 'template')?.value).toBe('Weekly Signal #43');
    expect(row(model.rows, 'template')?.notes).toEqual(['Saved v3 · In this bundle · Live v2']);
    expect(row(model.rows, 'segment')?.notes).toContain('Check uses current membership; this bundle may change it.');
    expect(row(model.rows, 'purpose')?.value).toBe('Marketing e-mail · consent · weekly');
    expect(row(model.rows, 'send-window')?.value).toContain('09:00–17:00');
    expect(row(model.rows, 'send-window')?.notes?.[0]).toContain('mon, tue');
    expect(row(model.rows, 'subject-test')?.value).toContain('2 subjects on 20%');
    expect(row(model.rows, 'archive')?.value).toContain('/n/signal-43/');
    expect(model.notes).toContain('Pre-publication audience checks do not simulate future bundled segment membership.');
    // An audience read that has not returned is “Checking…”, never a zero.
    expect(model.audience?.value).toBe('Checking…');
  });

  it('shows the eligible current check as an estimate, never as full reach', () => {
    const model = deriveConsequences(
      base({
        type: 'broadcast',
        content: { template: eml, segment: seg },
        broadcastAudience: {
          audience: 12_480,
          checked: 2_000,
          wouldSend: 1_842,
          wouldSkip: { no_consent: 120, unsubscribed: 38 },
          completedAt: '2026-11-06T10:32:00Z',
        },
      }),
    );
    expect(model.audience?.label).toBe('Eligible in current check');
    expect(model.audience?.value).toBe('1,842 in current check');
    expect(model.audience?.notes).toContain('Estimate · 2,000 of 12,480 members checked');
    expect(model.audience?.notes).toContain('No consent for the purpose: 120');
    expect(model.audience?.notes).toContain('As of 2026-11-06T10:32:00Z');
    expect(model.audience?.notes.join(' ')).not.toContain('12,480 in current');
  });

  it('never turns an empty or failed audience read into a zero', () => {
    const empty = deriveConsequences(
      base({
        type: 'broadcast',
        content: { template: eml, segment: seg },
        broadcastAudience: { audience: 0, checked: 0, wouldSend: 0, wouldSkip: {}, completedAt: '2026-11-06T10:32:00Z' },
      }),
    );
    expect(empty.audience?.value).toBe('No members checked');
    const none = deriveConsequences(
      base({
        type: 'broadcast',
        content: { template: eml, segment: seg },
        broadcastAudience: { audience: 10, checked: 10, wouldSend: 0, wouldSkip: { no_consent: 10 }, completedAt: '2026-11-06T10:32:00Z' },
      }),
    );
    expect(none.audience?.value).toBe('No eligible recipients in this check');
    const failed = deriveConsequences(base({ type: 'broadcast', content: { template: eml, segment: seg }, audienceError: 'network down' }));
    expect(failed.audience?.value).toBe('Unavailable');
    expect(failed.audience?.notes).toEqual(['network down']);
  });

  it('shows an e-mail template as sending nothing, with its tagging and block dependencies', () => {
    const model = deriveConsequences(
      base({
        type: 'email_template',
        content: {
          purpose: 'marketing_email',
          topic: 'weekly',
          subject: 'Hello {{ profile.firstName }}',
          preheader: 'Preview',
          mjml: `{% block '${blk}', title: 'x' %}`,
          utm: { source: 'newsletter', medium: 'email', campaign: 'signal-44', domains: ['martechsignal.example'] },
        },
        dependencies: { [blk]: { id: blk, name: 'Header', publishedVersion: 2 } },
        templatePreview: { version: 4, subject: 'Hello Ada', preheader: 'Preview' },
        purposes: [{ key: 'marketing_email', name: 'Marketing e-mail', basis: 'consent', channels: ['email'] }],
        templateCheck: { version: 4, checkedAt: '2026-11-06T10:32:00Z', summary: { blocking: 0, warning: 1, info: 0 }, findings: [] },
      }),
    );
    expect(row(model.rows, 'subject')?.value).toBe('Hello {{ profile.firstName }}');
    expect(row(model.rows, 'rendered-subject')?.value).toBe('Hello Ada');
    expect(row(model.rows, 'link-tagging')?.value).toContain('campaign signal-44');
    expect(row(model.rows, 'link-tagging')?.notes).toEqual(['Only links to martechsignal.example']);
    expect(row(model.rows, 'sends')?.value).toContain('publishing a template alone sends nothing');
    expect(row(model.rows, 'dependencies')?.items?.[0]?.value).toBe('Header');
    expect(row(model.rows, 'dependencies')?.items?.[0]?.note).toContain('Published v2');
    expect(model.notes).toContain('Used when a sending artifact references it; publishing alone sends nothing.');
    expect(model.audience).toBeNull();
    expect(model.notes).toContain('No recipient estimate applies: publishing alone sends nothing.');
    expect(model.templateCheck?.summary.warning).toBe(1);
  });

  it('marks an unpublished bundled block as unavailable before publication', () => {
    const model = deriveConsequences(
      base({
        type: 'email_template',
        content: { purpose: 'marketing_email', subject: 'S', mjml: `{% block '${blk}' %}` },
        bundleVersions: { [blk]: 2 },
        dependencies: { [blk]: { id: blk, name: 'Header', publishedVersion: null } },
      }),
    );
    expect(row(model.rows, 'dependencies')?.items?.[0]?.note).toContain('Saved v2 · In this bundle');
    expect(model.notes).toContain('Bundled block render unavailable before publication.');
  });

  it('shows SMS and push structured content and never e-mail provider checks', () => {
    const smsModel = deriveConsequences(
      base({ type: 'sms_template', content: { purpose: 'marketing_sms', body: 'Hi {{ profile.firstName }}' } }),
    );
    expect(row(smsModel.rows, 'body')?.value).toBe('Hi {{ profile.firstName }}');
    expect(smsModel.evidence).toEqual([]);
    const pushModel = deriveConsequences(
      base({
        type: 'push_template',
        content: { purpose: 'marketing_push', title: 'Hi', body: 'Body', url: 'https://x.test', ttlHours: 12, urgency: 'high' },
      }),
    );
    expect(row(pushModel.rows, 'title')?.value).toBe('Hi');
    expect(row(pushModel.rows, 'delivery')?.value).toContain('TTL 12 hours');
    expect(pushModel.evidence.map((e) => e.label)).not.toContain('Provider');
  });

  it('renders a journey trigger configuration, control group and no inferred audience', () => {
    const model = deriveConsequences(
      base({
        type: 'journey',
        content: {
          purpose: 'marketing_email',
          goal: 'Two opens',
          controlGroup: { percent: 10, minSampleSize: 200 },
          nodes: [
            { id: 'n1', kind: 'trigger', label: 'Confirmed', config: { event: 'Subscription Confirmed', reentry: 'once' } },
            { id: 'n2', kind: 'email', label: 'Welcome', config: { template: eml } },
          ],
        },
        dependencies: { [eml]: { id: eml, name: 'Welcome template', publishedVersion: 2 } },
      }),
    );
    expect(row(model.rows, 'control-group')?.value).toBe('10% held out');
    expect(row(model.rows, 'trigger')?.details?.[0]?.label).toBe('Trigger configuration');
    expect(row(model.rows, 'nodes')?.value).toBe('2 nodes');
    expect(row(model.rows, 'sends')?.value).toContain('publishing does not guarantee a send');
    expect(model.notes).toContain('No inferred eligible audience or completion ETA.');
  });

  it('describes a segment condition and keeps membership apart from consent', () => {
    const model = deriveConsequences(
      base({
        type: 'segment',
        content: { description: 'Engaged', condition: { consent: 'marketing_email' } },
        segmentCount: { count: 1842 },
      }),
    );
    expect(row(model.rows, 'mode')?.value).toBe('Dynamic');
    expect(row(model.rows, 'membership')?.condition).toEqual({ consent: 'marketing_email' });
    expect(model.audience?.value).toBe('1,842 people');
    expect(model.notes).toContain('Membership is not consent, and it is never an eligible-recipient count.');
    const restricted = deriveConsequences(base({ type: 'segment', content: { condition: {} }, segmentCountRestricted: true }));
    expect(restricted.audience?.value).toBe('Membership count restricted');
    const staticSegment = deriveConsequences(base({ type: 'segment', content: { mode: 'static', description: 'List' } }));
    expect(row(staticSegment.rows, 'membership')?.value).toContain('Explicit membership list');
  });

  it('renders a form’s purposes, consent text and redirects without claiming a migration', () => {
    const model = deriveConsequences(
      base({
        type: 'form',
        content: {
          purposes: ['marketing_email'],
          doubleOptIn: true,
          confirmationTemplate: eml,
          consentText: 'Yes, send me the newsletter.',
          traits: ['firstName', 'company'],
          successUrl: 'https://martechsignal.example/thanks',
          allowedOrigins: [],
        },
        dependencies: { [eml]: { id: eml, name: 'Confirm', publishedVersion: 1 } },
        purposes: [{ key: 'marketing_email', name: 'Marketing e-mail', basis: 'consent', channels: ['email'], requiresDoubleOptIn: true }],
      }),
    );
    expect(row(model.rows, 'purposes')?.value).toBe('Marketing e-mail');
    expect(row(model.rows, 'double-opt-in')?.value).toContain('after confirmation');
    expect(row(model.rows, 'allowed-origins')?.value).toBe('Any site');
    expect(row(model.rows, 'sends')?.notes).toContain('Existing subscribers are not migrated by publishing.');
    expect(model.audience).toBeNull();
  });

  it('lists experience variants in definition order with weights and targeting defaults', () => {
    const model = deriveConsequences(
      base({
        type: 'experience',
        content: {
          placement: 'article-footer',
          variants: [
            { id: 'a', name: 'Short', weight: 60, content: { html: '<p>Hi</p>' } },
            { id: 'b', name: 'Long', weight: 40, content: { json: { text: 'Hi' } } },
          ],
          holdoutPercent: 5,
          goal: { event: 'Signup' },
        },
      }),
    );
    expect(row(model.rows, 'targeting')?.value).toBe('All eligible visitors');
    expect(row(model.rows, 'variants')?.items?.map((i) => i.value)).toEqual(['Short · 60%', 'Long · 40%']);
    expect(row(model.rows, 'variants')?.html?.[0]).toEqual({ label: 'Short HTML', html: '<p>Hi</p>' });
    expect(row(model.rows, 'holdout')?.value).toBe('5% see nothing');
    expect(row(model.rows, 'goal')?.value).toBe('Signup');
    expect(model.notes).toContain('No new SDK simulation or audience estimate.');
  });

  it('falls back to a plain definition consequence for other artifact families', () => {
    const model = deriveConsequences(base({ type: 'email_block', content: { mjml: '<mj-section />' } }));
    expect(row(model.rows, 'effect')?.value).toBe('This definition becomes live on approval; no recipient estimate applies.');
    expect(model.audience).toBeNull();
  });

  it('separates consent from the other evidence and says “Not checked” where evidence is missing', () => {
    const model = deriveConsequences(
      base({
        type: 'broadcast',
        content: { template: eml, segment: seg },
        dependencies: { [eml]: { id: eml, publishedVersion: 2 }, [seg]: { id: seg, publishedVersion: 1 } },
        purposes: [{ key: 'marketing_email', name: 'Marketing e-mail', basis: 'consent', channels: ['email'] }],
        templatePurpose: { purpose: 'marketing_email' },
        provider: { marketing: true, transactional: true, configured: true, adapter: 'log' },
        domains: {
          checkedAt: '2026-11-06T10:32:00Z',
          domains: [{ domain: 'martechsignal.example', ok: true, spf: { ok: true }, dkim: [], dmarc: { ok: true }, uses: ['marketing'] }],
        },
      }),
    );
    expect(model.evidence.find((e) => e.key === 'consent-purpose')?.status).toBe('ready');
    expect(model.evidence.find((e) => e.key === 'provider')?.status).toBe('attention');
    expect(model.evidence.find((e) => e.key === 'provider')?.value).toBe('Log adapter — no external delivery');
    const domain = model.evidence.find((e) => e.key.startsWith('domain:'));
    expect(domain?.status).toBe('not-checked');
    expect(domain?.value).toContain('DKIM not checked — selectors required');
    const missingDomains = deriveConsequences(
      base({ type: 'broadcast', content: { template: eml, segment: seg }, dependencies: { [eml]: { id: eml, publishedVersion: 2 } } }),
    );
    expect(missingDomains.evidence.find((e) => e.key === 'domains')?.value).toBe('Not checked');
  });

  it('shows an unavailable dependency by id instead of “No dependencies”', () => {
    const model = deriveConsequences(
      base({
        type: 'form',
        content: { purposes: ['marketing_email'], confirmationTemplate: eml, consentText: 'Yes', successUrl: 'https://x.test' },
        dependencies: { [eml]: { id: eml, unavailable: true } },
        dependenciesLoading: false,
      }),
    );
    const dependency = row(model.rows, 'dependencies')?.items?.[0];
    expect(dependency?.value).toBe(eml);
    expect(dependency?.note).toContain('Unavailable');
    expect(dependency?.tone).toBe('bad');
  });

  it('says loading while the dependency read is still out', () => {
    const model = deriveConsequences(
      base({ type: 'form', content: { purposes: ['marketing_email'], confirmationTemplate: eml }, dependenciesLoading: true }),
    );
    expect(row(model.rows, 'dependencies')?.items?.[0]?.note).toContain('Loading…');
    expect(row(model.rows, 'dependencies')?.items?.[0]?.tone).toBeUndefined();
  });
});

describe('approval consequence corrections (0.14.7)', () => {
  it('lets the broadcast topic override the template topic in the consent evidence (#581)', () => {
    const model = deriveConsequences(
      base({
        type: 'broadcast',
        content: { template: eml, segment: seg, topic: 'annual_recap' },
        dependencies: { [eml]: { id: eml, publishedVersion: 1 }, [seg]: { id: seg, publishedVersion: 1 } },
        purposes: [
          {
            key: 'marketing_email',
            name: 'Marketing e-mail',
            basis: 'consent',
            channels: ['email'],
            topics: [{ key: 'product_updates', name: 'Product updates' }],
          },
        ],
        templatePurpose: { purpose: 'marketing_email', topic: 'product_updates' },
      }),
    );
    const consent = model.evidence.find((e) => e.key === 'consent-purpose');
    expect(consent?.status).toBe('attention');
    expect(consent?.value).toContain('annual_recap');
    expect(consent?.value).not.toContain('product_updates');
    // The Purpose row already preferred the broadcast topic and must agree with the evidence.
    expect(row(model.rows, 'purpose')?.value).toContain('annual_recap');
  });

  it('shows the live version beside a bundled one and warns when approval moves it backwards (#583)', () => {
    const model = deriveConsequences(
      base({
        type: 'broadcast',
        content: { template: eml, segment: seg },
        bundleVersions: { [eml]: 2 },
        dependencies: { [eml]: { id: eml, name: 'Weekly Signal', publishedVersion: 3 }, [seg]: { id: seg, publishedVersion: 3 } },
      }),
    );
    const template = row(model.rows, 'template');
    expect(template?.notes?.join(' ')).toContain('Live v3');
    expect(template?.notes?.join(' ')).toContain('back from v3 to v2');
    expect(template?.tone).toBe('warn');

    const dependency = row(model.rows, 'dependencies')?.items?.find((item) => item.key === eml);
    expect(dependency?.note).toContain('Live v3');
    expect(dependency?.note).toContain('back from v3 to v2');
    expect(dependency?.tone).toBe('warn');

    // The drawer's summary repeats the warning, not only the row.
    expect(model.notes.join(' ')).toContain('back from v3 to v2');
  });

  it('shows the live version beside a newer bundled one without a rollback warning (#583)', () => {
    const model = deriveConsequences(
      base({
        type: 'broadcast',
        content: { template: eml, segment: seg },
        bundleVersions: { [eml]: 4 },
        dependencies: { [eml]: { id: eml, name: 'Weekly Signal', publishedVersion: 3 }, [seg]: { id: seg, publishedVersion: 3 } },
      }),
    );
    const template = row(model.rows, 'template');
    expect(template?.notes?.join(' ')).toContain('Live v3');
    expect(template?.notes?.join(' ')).not.toContain('back from');
    expect(template?.tone).toBeUndefined();
    const dependency = row(model.rows, 'dependencies')?.items?.find((item) => item.key === eml);
    expect(dependency?.note).toContain('Live v3');
    expect(dependency?.note).not.toContain('back from');
    expect(dependency?.tone).toBeUndefined();
    expect(model.notes.join(' ')).not.toContain('back from');
  });

  it('describes the send window in the When row instead of “arrival varies” (#584)', () => {
    const model = deriveConsequences(
      base({
        type: 'broadcast',
        content: { template: eml, segment: seg, sendWindow: { start: '09:00', end: '17:00', maxDelay: 'P1D' } },
      }),
    );
    expect(row(model.rows, 'when')?.notes?.[0]).toContain('Inside each reader’s local send window');
    const without = deriveConsequences(base({ type: 'broadcast', content: { template: eml, segment: seg } }));
    expect(row(without.rows, 'when')?.notes?.[0]).toBe('Arrival time varies by reader.');
  });

  it('does not claim a hosted-page override when the form turned it off (#598)', () => {
    const content = { purposes: ['marketing_email'], hostedPages: { headline: 'Custom' } };
    const off = deriveConsequences(base({ type: 'form', content: { ...content, hostedPagesEnabled: false }, purposes: [] }));
    expect(row(off.rows, 'hosted-pages')?.value).toBe('Workspace brand');
    const on = deriveConsequences(base({ type: 'form', content: { ...content, hostedPagesEnabled: true }, purposes: [] }));
    expect(row(on.rows, 'hosted-pages')?.value).toBe('Overrides the workspace brand on this form');
  });

  it('names an unresolved saved purpose “Unavailable purpose” in every consequence row (#600)', () => {
    const cases: ConsequenceInput[] = [
      base({
        type: 'broadcast',
        content: { template: eml, segment: seg, topic: 'weekly' },
        templatePurpose: { purpose: 'legacy_purpose', topic: 'weekly' },
        purposes: [],
      }),
      base({ type: 'email_template', content: { purpose: 'legacy_purpose', subject: 'S' }, purposes: [] }),
      base({ type: 'sms_template', content: { purpose: 'legacy_purpose', body: 'B' }, purposes: [] }),
      base({ type: 'journey', content: { purpose: 'legacy_purpose', nodes: [] }, purposes: [] }),
    ];
    for (const input of cases) {
      const purpose = row(deriveConsequences(input).rows, 'purpose');
      expect(purpose?.value).toBe('Unavailable purpose');
      expect(purpose?.value).not.toContain('legacy_purpose');
    }
  });
});

describe('exact consequence reads (#498)', () => {
  const capabilities = { canReadArtifacts: true, canReadProfiles: true };

  it('reads each unique artifact id once, even when several nodes reference it', () => {
    const journey = buildReadPlan({
      artifactId: jrn,
      type: 'journey',
      version: 2,
      content: {
        nodes: [
          { kind: 'email', label: 'One', config: { template: eml } },
          { kind: 'email', label: 'Two', config: { template: eml } },
        ],
      },
      capabilities,
    });
    expect(journey.artifacts).toEqual([eml]);
    expect(journey.cacheKeys.filter((k) => k === `artifact:${eml}`)).toHaveLength(1);
    expect(dependencyRefs('journey', { nodes: [{ kind: 'email', label: 'One', config: { template: eml } }] })).toHaveLength(1);
  });

  it('pins the broadcast audience read to the reviewed version and bundle template', () => {
    const plan = buildReadPlan({
      artifactId: id('bct', '8'),
      type: 'broadcast',
      version: 4,
      content: { template: eml, segment: seg },
      bundleVersions: { [eml]: 3 },
      capabilities,
    });
    expect(plan.broadcast).toEqual({ artifactId: id('bct', '8'), version: 4, templateVersion: 3 });
    expect(plan.provider).toBe(true);
    expect(plan.domains).toBe(true);
    expect(plan.purposes).toBe(true);
  });

  it('does not plan an audience read for non-sending types', () => {
    for (const type of ['email_template', 'segment', 'form', 'journey', 'experience']) {
      const plan = buildReadPlan({ artifactId: id(type === 'segment' ? 'seg' : 'bct', '7'), type, version: 1, content: {}, capabilities });
      expect(plan.broadcast).toBeUndefined();
    }
  });

  it('reads a segment count only with profiles:read', () => {
    const allowed = buildReadPlan({ artifactId: seg, type: 'segment', version: 2, content: {}, capabilities });
    expect(allowed.segmentPreview).toEqual({ artifactId: seg, version: 2 });
    const restricted = buildReadPlan({
      artifactId: seg,
      type: 'segment',
      version: 2,
      content: {},
      capabilities: { canReadArtifacts: true, canReadProfiles: false },
    });
    expect(restricted.segmentPreview).toBeUndefined();
    // Nothing else is read for an empty restricted segment definition: no count, no fan-out.
    expect(restricted.cacheKeys).toEqual([]);
  });

  it('plans nothing at all without artifacts:read', () => {
    const plan = buildReadPlan({
      artifactId: eml,
      type: 'email_template',
      version: 1,
      content: { purpose: 'marketing_email', mjml: `{% block '${blk}' %}` },
      capabilities: { canReadArtifacts: false, canReadProfiles: false },
    });
    expect(plan).toEqual({ artifacts: [], purposes: false, provider: false, domains: false, cacheKeys: [] });
  });

  it('dedupes the template preview and check to one exact version each', () => {
    const plan = buildReadPlan({ artifactId: eml, type: 'email_template', version: 4, content: {}, capabilities });
    expect(plan.templatePreview).toEqual({ artifactId: eml, version: 4 });
    expect(plan.templateCheck).toEqual({ artifactId: eml, version: 4 });
    expect(new Set(plan.cacheKeys).size).toBe(plan.cacheKeys.length);
    expect(plan.cacheKeys).toContain(`template:${eml}@4`);
  });
});

describe('workspace proposal consequences (#498)', () => {
  it('applies immediately, lists only changed settings and explains the time zone', () => {
    const model = deriveProposalConsequences({
      changes: { name: { from: 'MartechSignal', to: 'Signal' }, timeZone: { from: 'UTC', to: 'Europe/Copenhagen' } },
      note: 'The team is in Denmark.',
    });
    expect(model.heading).toBe('If approved');
    expect(row(model.rows, 'effect')?.value).toBe('Applies workspace settings immediately on approval.');
    expect(row(model.rows, 'settings')?.items?.map((i) => i.value)).toEqual(['Name', 'Time zone']);
    expect(row(model.rows, 'settings')?.items?.[1]?.note).toBe('UTC → Europe/Copenhagen');
    expect(row(model.rows, 'time-zone-note')?.value).toBe('Changes display time zone; stored send instants stay the same.');
    expect(model.rows.some((r) => r.key === 'publishes')).toBe(false);
    expect(model.rows.some((r) => r.key === 'dependencies')).toBe(false);
    expect(model.audience).toBeNull();
    expect(model.notes).toEqual(['The team is in Denmark.']);
  });
});

describe('approval consequence review follow-ups (0.14.10)', () => {
  const capabilities = { canReadArtifacts: true, canReadProfiles: true };

  it('warns when a bundle rolls the purposes singleton back (#735)', () => {
    const pur = id('pur', 'f');
    const model = deriveConsequences(
      base({
        type: 'form',
        content: { purposes: ['marketing_email'], confirmationTemplate: eml },
        bundleVersions: { [pur]: 3, [eml]: 2 },
        dependencies: {
          [pur]: { id: pur, name: 'Purposes', type: 'purposes', publishedVersion: 4 },
          [eml]: { id: eml, name: 'Confirm subscription', type: 'email_template', publishedVersion: 2 },
        },
      }),
    );
    // The summary repeats the rollback, not only the member row.
    expect(model.notes.join(' ')).toContain('moves the live purposes back from v4 to v3');
    const purposes = row(model.rows, 'dependencies')?.items?.find((item) => item.key === pur);
    expect(purposes?.note).toContain('Saved v3');
    expect(purposes?.note).toContain('back from v4 to v3');
    expect(purposes?.tone).toBe('warn');
  });

  it('reads the bundled purposes singleton a purpose-keyed artifact references (#735)', () => {
    const pur = id('pur', 'f');
    const plan = buildReadPlan({
      artifactId: eml,
      type: 'email_template',
      version: 4,
      content: { subject: 'Hello', purpose: 'marketing_email' },
      bundleVersions: { [pur]: 3 },
      capabilities,
    });
    expect(plan.artifacts).toContain(pur);
  });

  it('does not add a purposes read when the artifact names no purpose (#735)', () => {
    const pur = id('pur', 'f');
    const plan = buildReadPlan({
      artifactId: eml,
      type: 'email_template',
      version: 4,
      content: { subject: 'Hello' },
      bundleVersions: { [pur]: 3 },
      capabilities,
    });
    expect(plan.artifacts).not.toContain(pur);
  });

  it('does not treat a free-text purpose field as a purpose reference (0.14.10 review)', () => {
    const pur = id('pur', 'f');
    const plan = buildReadPlan({
      artifactId: eml,
      type: 'email_template',
      version: 4,
      content: { subject: 'Hello', mandate: { purpose: 'Grow the newsletter list by 20% this quarter.' } },
      bundleVersions: { [pur]: 3 },
      capabilities,
    });
    expect(plan.artifacts).not.toContain(pur);
  });

  it('finds purpose keys nested in the artifact content (#735)', () => {
    const pur = id('pur', 'f');
    const plan = buildReadPlan({
      artifactId: id('dlp', '2'),
      type: 'delivery_policy',
      version: 2,
      content: { frequencyCaps: [{ channel: 'email', purposes: ['marketing_email'], max: 2, days: 7 }] },
      bundleVersions: { [pur]: 3 },
      capabilities,
    });
    expect(plan.artifacts).toContain(pur);
    const journey = buildReadPlan({
      artifactId: jrn,
      type: 'journey',
      version: 2,
      content: { purpose: 'marketing_email', nodes: [] },
      bundleVersions: { [pur]: 3 },
      capabilities,
    });
    expect(journey.artifacts).toContain(pur);
    // A dynamic segment's consent condition names a purpose key too.
    const segment = buildReadPlan({
      artifactId: seg,
      type: 'segment',
      version: 2,
      content: { mode: 'dynamic', condition: { all: [{ consent: 'marketing_email' }] } },
      bundleVersions: { [pur]: 3 },
      capabilities,
    });
    expect(segment.artifacts).toContain(pur);
  });

  it('does not make the purposes singleton its own dependency (#735)', () => {
    const pur = id('pur', 'f');
    const refs = dependencyRefs('purposes', { purposes: [{ key: 'marketing_email', name: 'Marketing' }] }, { [pur]: 3 });
    expect(refs.map((ref) => ref.id)).not.toContain(pur);
  });
});

describe('consequence wording helpers (#498)', () => {
  it('humanises the durations used by schedules and tests', () => {
    expect(humanDuration('P1D')).toBe('1 day');
    expect(humanDuration('PT4H')).toBe('4 hours');
    expect(humanDuration('PT30M')).toBe('30 minutes');
    expect(humanDuration('P2D')).toBe('2 days');
    expect(humanDuration('weird')).toBe('weird');
  });
});

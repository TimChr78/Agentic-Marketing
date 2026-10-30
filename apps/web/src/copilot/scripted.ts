import { useStore } from '../mock/store';
import type { Sink } from './types';

// Scripted scenarios: they call the real (mock) commands, so the state changes are genuine —
// only the reasoning between tool calls is pre-written.

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const winbackMjml = `<mjml>
  <mj-body background-color="#f3efe6">
    <mj-section background-color="#2f5d43" padding="18px 24px">
      <mj-column><mj-text color="#f3efe6" font-size="20px" font-weight="700" font-family="Georgia, serif">Fjeldvej Outdoor</mj-text></mj-column>
    </mj-section>
    <mj-section background-color="#ffffff" padding="28px 24px">
      <mj-column>
        <mj-text font-size="22px" font-family="Georgia, serif" color="#1f2a22">It has been a while, {{ profile.first_name }}</mj-text>
        <mj-text font-size="15px" line-height="1.6" color="#374151">{{ ai.intro | default: "The trails are muddy, the light is low and the new range is in." }}</mj-text>
        <mj-button background-color="#2f5d43" href="https://example.com/{{ profile.preferred_category }}">See what is new in {{ profile.preferred_category }}</mj-button>
      </mj-column>
    </mj-section>
    <mj-section padding="16px 24px"><mj-column><mj-text font-size="11px" color="#6b7280"><a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text></mj-column></mj-section>
  </mj-body>
</mjml>`;

async function winback(s: Sink) {
  s.say('I will size the audience first, then build the journey as a draft. Nothing is sent until it is published.');
  await pause(500);
  const est = (await s.tool('segments.estimate', { definition: 'customer AND no order_completed within 60d' })) as {
    estimatedSize: number;
  };
  await s.tool('segments.create', {
    name: 'Win-back audience',
    definition: 'customer AND no order_completed within 60d AND marketing_email allowed',
    realtime: true,
  });
  await s.tool('templates.list', {});
  s.say('There is no win-back template yet, so I am creating one with an AI-filled opening paragraph and a safe default.');
  await pause(400);
  await s.tool('templates.create', {
    name: 'Win back',
    subject: 'We kept your spot on the trail, {{ profile.first_name }}',
    mjml: winbackMjml,
  });
  await s.tool('journeys.createDraft', {
    name: 'Win-back 60 days',
    purpose: 'marketing_email',
    goal: 'Order within 14 days',
    nodes: [
      {
        id: 'n1',
        kind: 'trigger',
        label: 'Entered “Win-back audience”',
        config: { event: 'segment.entered', segment: 'seg_win_back_audience', reentry: 'every 180 days' },
      },
      { id: 'n2', kind: 'aiGenerate', label: 'AI: personalise opener', config: { slot: 'intro', prompt: 'prm_winback@1', maxChars: 240 } },
      { id: 'n3', kind: 'email', label: 'We miss you', config: { template: 'tpl_win_back', purpose: 'marketing_email' } },
      {
        id: 'n4',
        kind: 'waitEvent',
        label: 'Clicked within 4 days?',
        config: { event: 'email_clicked', timeout: 'P4D' },
        next: [
          { to: 'n5', label: 'clicked' },
          { to: 'n6', label: 'timeout' },
        ],
      },
      {
        id: 'n5',
        kind: 'updateProfile',
        label: 'Tag as re-engaged',
        config: { trait: 'lifecycle_stage', value: 're_engaged' },
        next: [{ to: 'n9' }],
      },
      {
        id: 'n6',
        kind: 'split',
        label: 'A/B: comeback offer',
        config: { a: 50, b: 50, holdout: 10 },
        next: [
          { to: 'n7', label: 'A' },
          { to: 'n8', label: 'B' },
        ],
      },
      {
        id: 'n7',
        kind: 'email',
        label: '15% comeback code',
        config: { template: 'tpl_win_back', variant: 'A', purpose: 'marketing_email' },
        next: [{ to: 'n9' }],
      },
      {
        id: 'n8',
        kind: 'email',
        label: 'Free gear check-up',
        config: { template: 'tpl_win_back', variant: 'B', purpose: 'marketing_email' },
        next: [{ to: 'n9' }],
      },
      { id: 'n9', kind: 'goal', label: 'Order within 14 days', config: { event: 'order_completed', within: 'P14D' } },
    ],
  });
  const lapsed = useStore.getState().profiles.find((p) => p.segments.includes('seg_lapsed_60d')) ?? useStore.getState().profiles[1];
  await s.tool('journeys.simulate', { journeyId: 'jrn_win_back_60_days', profileId: lapsed.id });
  const pub = (await s.tool('journeys.requestPublish', {
    journeyId: 'jrn_win_back_60_days',
    note: `New win-back journey for ≈${est.estimatedSize.toLocaleString('en')} lapsed customers. A/B tests a 15% code against a free gear check-up, with a 10% holdout to measure real uplift.`,
  })) as { status: string };
  const nav = useStore.getState().navigate;
  s.say(
    pub.status === 'published'
      ? 'Done. The journey is published because your policy allows direct publishing.'
      : `Draft v1 is ready and waiting for your approval (policy: agent changes need a human). It targets about ${est.estimatedSize.toLocaleString('en')} lapsed customers. Only people with a valid basis for marketing e-mail will receive it, and a 10% holdout measures the real uplift.`,
    [
      { label: 'Open the journey', run: () => nav('journeys', { journeyId: 'jrn_win_back_60_days' }) },
      { label: 'Review approval', run: () => nav('approvals') },
    ],
  );
}

async function explain(s: Sink) {
  const found = (await s.tool('profiles.search', { query: 'anna' })) as { id: string; name: string }[];
  const anna = found[0];
  await s.tool('messages.explainDelivery', { profileId: anna.id, journeyId: 'jrn_cart' });
  const c = (await s.tool('consent.explain', { profileId: anna.id, purpose: 'marketing_email' })) as { source: string; recordedAt: string };
  s.say(
    `${anna.name} entered “Abandoned cart” and was assigned variant A, but the send gateway suppressed the reminder: she objected to marketing e-mail (${c.source.toLowerCase()}, ${c.recordedAt}). That is the intended behaviour. An objection to direct marketing overrides legitimate interest. She still gets service e-mails such as order confirmations.`,
    [{ label: 'Open her profile', run: () => useStore.getState().navigate('profiles', { profileId: anna.id }) }],
  );
}

async function performance(s: Sink) {
  const p = (await s.tool('analytics.emailPerformance', { days: 7 })) as {
    sent: number;
    clickRate: number;
    unsubscribeRate: number;
    conversions: number;
    revenueDkk: number;
    bestDay: string;
  };
  const f = (await s.tool('analytics.journeyFunnel', { journeyId: 'jrn_cart' })) as { conversion: number; holdoutUplift: number };
  s.say(
    `Last 7 days: ${p.sent.toLocaleString('en')} e-mails, ${p.clickRate}% click rate, ${p.unsubscribeRate}% unsubscribes, ${p.conversions} attributed orders worth ${p.revenueDkk.toLocaleString('da-DK')} kr. Best day was ${p.bestDay}. Abandoned cart converts ${f.conversion}% with +${f.holdoutUplift} pts over the holdout, so it is your most incremental journey. Welcome clicks are slipping; I already proposed a fix as Welcome series v4.`,
    [{ label: 'Open analytics', run: () => useStore.getState().navigate('analytics') }],
  );
}

export const scenarios = [
  { prompt: 'Build a win-back journey for customers inactive for 60 days', match: /win.?back|inactive|lapsed/i, run: winback },
  { prompt: 'Why didn’t Anna Jensen get the abandoned cart e-mail?', match: /why|anna|didn|explain/i, run: explain },
  { prompt: 'Summarise last week’s e-mail performance', match: /perform|summar|week|report|how did/i, run: performance },
];

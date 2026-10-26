import { deflateSync } from 'node:zlib';
import { createClient } from '@agentic-marketing/client';
import type { Commands } from '../../src/registry';
import type { startTestServer } from '../harness';

// A realistic workspace for UI work, screenshots and Playwright: a newsletter site (like the
// MartechSignal pilot) with people in each role, an agent token, published prerequisites and
// pending approvals of every reviewed type.

type T = Awaited<ReturnType<typeof startTestServer>>;
export const PEOPLE = {
  owner: { email: 'alex@example.com', name: 'Alex Morgan' },
  builder: { email: 'sam@example.com', name: 'Sam Rivera' },
  approver: { email: 'jo@example.com', name: 'Jo Lee' },
  viewer: { email: 'vic@example.com', name: 'Vic Chen' },
};

const mjml = (title: string, body: string) => `<mjml>
  <mj-head><mj-attributes><mj-all font-family="Helvetica, Arial, sans-serif" /></mj-attributes></mj-head>
  <mj-body background-color="#f4f5f7">
    <mj-section background-color="#ffffff" padding="24px">
      <mj-column>
        <mj-text font-size="13px" color="#6b7280">MartechSignal</mj-text>
        <mj-text font-size="22px" font-weight="700" color="#111827">${title}</mj-text>
        <mj-text font-size="15px" line-height="24px" color="#374151">Hi {{ profile.firstName | default: 'there' }},</mj-text>
        <mj-text font-size="15px" line-height="24px" color="#374151">${body}</mj-text>
        <mj-button background-color="#1d4ed8" href="https://martechsignal.example/latest">Read the issue</mj-button>
        <mj-text font-size="12px" color="#6b7280"><a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

/** A tiny PNG (solid colour) so the asset library has a real image. */
function png(w: number, h: number, rgb: [number, number, number]) {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).fill(Buffer.from(rgb))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** `confirmedUrl`: where the signup form sends people after they confirm (default: the pilot site). */
export async function seed(t: T, opts: { confirmedUrl?: string } = {}) {
  const users = {
    owner: await t.signUp(PEOPLE.owner.email),
    builder: await t.signUp(PEOPLE.builder.email),
    approver: await t.signUp(PEOPLE.approver.email),
    viewer: await t.signUp(PEOPLE.viewer.email),
  };
  for (const [k, u] of Object.entries(users))
    await t.srv.db.admin.query('UPDATE "user" SET name = $1 WHERE id = $2', [PEOPLE[k as keyof typeof PEOPLE].name, u.id]);
  const ws = await t.workspaceWith(
    [
      [users.owner, 'owner'],
      [users.builder, 'marketer'],
      [users.approver, 'approver'],
      [users.viewer, 'viewer'],
    ],
    'agent_changes',
  );
  await t.srv.db.admin.query(`UPDATE workspaces SET name = 'MartechSignal', time_zone = 'UTC' WHERE id = $1`, [ws]);
  const sandbox = await t.workspaceWith([[users.owner, 'admin']], 'none');
  await t.srv.db.admin.query(`UPDATE workspaces SET name = 'Sandbox' WHERE id = $1`, [sandbox]);

  const owner = t.api(users.owner, ws);
  await owner.call('workspace.setSeedList', { seedList: ['inbox-check@example.com'] }).catch(() => {});
  await owner.call('emailProviders.create', {
    name: 'Development log',
    adapter: 'log',
    fromEmail: 'news@martechsignal.example',
    fromName: 'MartechSignal',
    useFor: ['transactional', 'marketing'],
  });
  await owner.call('secrets.set', { name: 'turnstile.secret_key', value: 'dev-secret-not-real' });

  const logo = await owner.call('assets.upload', {
    fileName: 'martechsignal-logo.png',
    contentType: 'image/png',
    dataBase64: png(160, 40, [29, 78, 216]).toString('base64'),
    altText: 'MartechSignal',
  });
  await owner.call('assets.upload', {
    fileName: 'issue-43-hero.png',
    contentType: 'image/png',
    dataBase64: png(600, 300, [15, 122, 131]).toString('base64'),
    altText: 'Chart of e-mail engagement by weekday',
  });

  const pub = async (id: string, note: string) => owner.call('artifacts.requestPublish', { artifactId: id, note });
  const brand = await owner.call('artifacts.create', {
    type: 'brand',
    name: 'Brand',
    content: {
      siteName: 'MartechSignal',
      siteUrl: 'https://martechsignal.example',
      logoUrl: logo.url,
      logoAlt: 'MartechSignal',
      colors: { accent: '#1d4ed8' },
      language: 'en',
    },
  });
  await pub(brand.artifactId, 'Initial brand');

  const confirm = await owner.call('artifacts.create', {
    type: 'email_template',
    name: 'Confirm your subscription',
    content: {
      purpose: 'onboarding',
      subject: 'Confirm your MartechSignal subscription',
      preheader: 'One click and you are in',
      mjml: mjml('Confirm your subscription', 'Click below to confirm. <a href="{{ confirm_url }}">Confirm</a>'),
      sampleData: { profile: { firstName: 'Ada' }, confirm_url: 'https://links.example/f/confirm/sample' },
    },
  });
  await pub(confirm.artifactId, 'Confirmation e-mail');
  const issue42 = await owner.call('artifacts.create', {
    type: 'email_template',
    name: 'Weekly Signal #42',
    content: {
      purpose: 'marketing_email',
      subject: 'Signal #42: attribution is a story you tell',
      preheader: 'Plus three tools worth a look',
      mjml: mjml('Signal #42', 'This week: why last-click attribution keeps winning arguments it should lose.'),
      sampleData: { profile: { firstName: 'Ada' } },
    },
  });
  await pub(issue42.artifactId, 'Issue 42');
  const subscribers = await owner.call('artifacts.create', {
    type: 'segment',
    name: 'Newsletter subscribers',
    content: { description: 'Everyone who allows the newsletter.', condition: { consent: 'marketing_email' } },
  });
  await pub(subscribers.artifactId, 'All subscribers');
  const engaged = await owner.call('artifacts.create', {
    type: 'segment',
    name: 'Engaged readers',
    content: {
      description: 'Subscribers who opened recently.',
      condition: { all: [{ consent: 'marketing_email' }, { event: 'Email Opened', within: 'P30D' }] },
    },
  });
  await pub(engaged.artifactId, 'Engaged readers');
  const form = await owner.call('artifacts.create', {
    type: 'form',
    name: 'Newsletter signup',
    content: {
      purposes: ['marketing_email'],
      doubleOptIn: true,
      confirmationTemplate: confirm.artifactId,
      consentText: 'Send me the weekly MartechSignal newsletter. Unsubscribe at any time.',
      traits: ['firstName'],
      successUrl: 'https://martechsignal.example/thanks',
      confirmedUrl: opts.confirmedUrl ?? 'https://martechsignal.example/welcome',
      allowedOrigins: ['https://martechsignal.example'],
    },
  });
  await pub(form.artifactId, 'Signup form');
  // No thank-you page on the site: confirming shows the branded confirmed page (#115).
  const footerForm = await owner.call('artifacts.create', {
    type: 'form',
    name: 'Footer signup',
    content: {
      purposes: ['marketing_email'],
      doubleOptIn: true,
      confirmationTemplate: confirm.artifactId,
      consentText: 'Send me the weekly MartechSignal newsletter. Unsubscribe at any time.',
      traits: [],
      successUrl: 'https://martechsignal.example/thanks',
      allowedOrigins: ['https://martechsignal.example'],
    },
  });
  await pub(footerForm.artifactId, 'Footer signup form');

  await owner.call('profiles.import', {
    label: 'Kit export 2026-10-20',
    rows: Array.from({ length: 24 }, (_, i) => ({
      email: `reader${i + 1}@example.net`,
      traits: { firstName: ['Ada', 'Grace', 'Linus', 'Margaret', 'Ken', 'Barbara'][i % 6], city: i % 2 ? 'Copenhagen' : 'Aarhus' },
      consent: [
        {
          purpose: 'marketing_email',
          status: i % 7 === 6 ? ('withdrawn' as const) : ('granted' as const),
          recordedAt: '2026-09-01T08:00:00Z',
          proof: { system: 'Kit' },
        },
      ],
    })),
  });

  // The agent: an API token owned by the builder, as Hermes uses on the pilot.
  const builder = t.api(users.builder, ws);
  const token = await builder.call('apiTokens.create', {
    name: 'Hermes',
    scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'],
    expiresInDays: 90,
  });
  await builder.call('apiTokens.create', { name: 'n8n reporting', scopes: ['artifacts:read'] });
  const agent = createClient<Commands>({ baseUrl: t.base, headers: { authorization: `Bearer ${token.token}` } });
  // An agent cannot administer workspace settings (#106); it proposes, and the owner approves
  // the change from the Approvals page.
  await agent.call('workspace.proposeUpdate', {
    timeZone: 'Europe/Copenhagen',
    note: 'The editorial team and most readers are in Denmark; display dates in Copenhagen time.',
  });
  const ask = (id: string, note: string) => agent.call('artifacts.requestPublish', { artifactId: id, note });

  const issue43 = await agent.call('artifacts.create', {
    type: 'email_template',
    name: 'Weekly Signal #43',
    content: {
      purpose: 'marketing_email',
      subject: 'Signal #43: the inbox is the new homepage',
      preheader: 'Why readers trust e-mail more than feeds',
      mjml: mjml(
        'Signal #43',
        'Feeds come and go; the inbox stays. This week we look at what 1,200 newsletters taught us about Tuesday sends.',
      ),
      sampleData: { profile: { firstName: 'Ada' } },
    },
  });
  await ask(issue43.artifactId, 'Draft of issue 43 from the editorial outline. Subject tested against #41 and #42.');

  const bc = await agent.call('artifacts.create', {
    type: 'broadcast',
    name: 'Signal #42 resend to engaged readers',
    content: {
      template: issue42.artifactId,
      segment: engaged.artifactId,
      sendAt: '2026-10-30T09:00:00+01:00',
      description: 'Resend of #42 to readers who opened in the last 30 days.',
    },
  });
  await ask(bc.artifactId, 'Resend #42 on Friday morning, Copenhagen time.');

  // The weekly flow since #107: next issue's template and the broadcast that sends it, one review.
  const issue44 = await agent.call('artifacts.create', {
    type: 'email_template',
    name: 'Weekly Signal #44',
    content: {
      purpose: 'marketing_email',
      subject: 'Signal #44: one review per issue',
      mjml: mjml('Signal #44', 'This issue and its send were approved together.'),
    },
  });
  const send44 = await agent.call('artifacts.create', {
    type: 'broadcast',
    name: 'Send Signal #44',
    content: { template: issue44.artifactId, segment: engaged.artifactId, sendAt: '2026-11-06T09:00:00+01:00' },
  });
  await agent.call('artifacts.requestPublishBundle', {
    artifactIds: [send44.artifactId, issue44.artifactId],
    note: 'Issue 44 and its Friday send, for one review.',
  });

  await agent.call('artifacts.updateDraft', {
    artifactId: engaged.artifactId,
    content: {
      description: 'Subscribers who opened or clicked recently.',
      condition: {
        all: [
          { consent: 'marketing_email' },
          {
            any: [
              { event: 'Email Opened', within: 'P14D' },
              { event: 'Email Clicked', within: 'P30D' },
            ],
          },
        ],
      },
    },
  });
  await ask(engaged.artifactId, 'Tighten to 14 days of opens, or a click in 30 days.');

  await agent.call('artifacts.updateDraft', {
    artifactId: form.artifactId,
    content: {
      purposes: ['marketing_email'],
      doubleOptIn: true,
      confirmationTemplate: confirm.artifactId,
      consentText: 'Yes, send me MartechSignal every Tuesday. I can unsubscribe with one click in any issue.',
      traits: ['firstName', 'company'],
      successUrl: 'https://martechsignal.example/thanks',
      confirmedUrl: 'https://martechsignal.example/welcome',
      allowedOrigins: ['https://martechsignal.example'],
    },
  });
  await ask(form.artifactId, 'Clearer consent wording and a company field.');

  const welcome = await agent.call('artifacts.create', {
    type: 'journey',
    name: 'Welcome series',
    content: {
      purpose: 'marketing_email',
      goal: 'Reader opens two issues in the first two weeks',
      nodes: [
        {
          id: 'n1',
          kind: 'trigger',
          label: 'Confirmed subscription',
          config: { event: 'Subscription Confirmed', reentry: 'once' },
          next: [{ to: 'n2' }],
        },
        { id: 'n2', kind: 'email', label: 'Welcome e-mail', config: { template: issue42.artifactId }, next: [{ to: 'n3' }] },
        { id: 'n3', kind: 'wait', label: 'Wait two days', config: { duration: 'P2D' }, next: [{ to: 'n4' }] },
        {
          id: 'n4',
          kind: 'branch',
          label: 'Opened the welcome?',
          config: { segment: engaged.artifactId },
          next: [{ to: 'n5' }, { to: 'n6' }],
        },
        { id: 'n5', kind: 'exit', label: 'Done', config: {} },
        { id: 'n6', kind: 'email', label: 'Best of MartechSignal', config: { template: issue42.artifactId }, next: [{ to: 'n7' }] },
        { id: 'n7', kind: 'exit', label: 'Exit', config: {} },
      ],
    },
  });
  await agent.call('artifacts.requestPublish', {
    artifactId: welcome.artifactId,
    note: 'Two-step welcome: issue 42 now, and again after two days for people who did not open it.',
  });

  await agent.call('artifacts.create', {
    type: 'experience',
    name: 'Newsletter banner on articles',
    content: {
      placement: 'article-footer',
      variants: [{ id: 'a', name: 'Short pitch', weight: 50, content: { html: '<p>Get the Tuesday signal.</p>' } }],
    },
  });

  return { ws, sandbox, users, token: token.token, forms: { signup: form.artifactId, footer: footerForm.artifactId } };
}

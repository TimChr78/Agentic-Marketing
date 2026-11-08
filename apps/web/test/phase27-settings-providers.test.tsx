import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelTable } from '../src/features/phase27/settings/channels';
import { useEmailChannel } from '../src/features/providers/EmailProviders';
import { useAiChannel, usePushChannel, useSmsChannel } from '../src/features/providers/OtherProviders';
import ProvidersPage from '../src/pages/settings/ProvidersPage';
import { ToastProvider } from '../src/ui';

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: Record<string, unknown> }[],
  emptySms: false,
  emailTracking: 'configurable' as 'configurable' | 'forced',
  emailProviders: [
    {
      id: 'epr_1',
      name: 'Newsletter delivery',
      adapter: 'postmark',
      config: { messageStream: 'broadcast' },
      fromEmail: 'news@example.com',
      fromName: 'Northstar Journal',
      replyTo: 'hello@example.com',
      useFor: ['marketing'],
      enabled: true,
      hasCredentials: true,
      tracking: 'configurable',
      trackingNote: 'Postmark tracks opens and clicks only when you enable it in the message stream.',
    },
  ],
  adapters: [
    {
      id: 'postmark',
      label: 'Postmark',
      config: {
        type: 'object',
        properties: {
          messageStream: { type: 'string', description: 'The Postmark message stream.' },
          trackOpens: { type: 'boolean' },
        },
        required: ['messageStream'],
      },
      secrets: {
        type: 'object',
        properties: { serverToken: { type: 'string', description: 'The Postmark server token.' } },
        required: ['serverToken'],
      },
      tracking: 'configurable',
      trackingNote: 'Postmark tracks opens and clicks only when you enable it in the message stream.',
      docsUrl: 'https://postmarkapp.com/developer',
    },
  ],
  sms: [
    {
      id: 'sms_1',
      name: 'Twilio alerts',
      adapter: 'twilio',
      config: { accountSid: `AC${'0'.repeat(32)}`, apiBase: 'https://api.twilio.com' },
      sender: '+14155550123',
      useFor: ['transactional'],
      enabled: true,
      hasCredentials: true,
      billing: { pricePerSegment: 0.0075, currency: 'USD', monthlyBudget: 50, helpText: 'Reply STOP to unsubscribe.' },
      webhookPath: '/hooks/sms/tok',
    },
  ],
  push: [
    {
      id: 'psh_1',
      name: 'Web push',
      adapter: 'webpush',
      config: { subject: 'mailto:ops@example.com', publicKey: 'BPublicKey0123' },
      useFor: ['marketing'],
      enabled: true,
    },
  ],
  ai: [
    {
      id: 'aip_1',
      name: 'Anthropic',
      kind: 'anthropic-compatible',
      baseUrl: 'https://api.anthropic.com/v1',
      models: { default: 'claude-sonnet-5-5', fast: 'claude-haiku-4-5' },
      structuredOutputs: true,
      allowPersonalData: false,
      useFor: ['journeys'],
      monthlyTokenBudget: 1_000_000,
      usedThisMonth: 12_000,
      region: 'eu',
      enabled: true,
      hasApiKey: true,
    },
  ],
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  const respond = (name: string) => {
    switch (name) {
      case 'emailProviders.list':
        return {
          providers: h.emailProviders.map((p) => ({ ...p, tracking: h.emailTracking })),
          adapters: h.adapters.map((a) => ({ ...a, tracking: h.emailTracking })),
          warnings:
            h.emailTracking === 'forced'
              ? ['Postmark provider "Newsletter delivery" adds open and click tracking to every marketing e-mail.']
              : [],
        };
      case 'smsProviders.list':
        return { providers: h.emptySms ? [] : h.sms };
      case 'pushProviders.list':
        return { providers: h.push };
      case 'aiProviders.list':
        return { providers: h.ai };
      case 'emailProviders.update':
      case 'smsProviders.update':
      case 'pushProviders.update':
      case 'aiProviders.update':
        return { id: 'x', name: 'saved', warnings: [] };
      case 'emailProviders.rotateWebhook':
        return { webhookUrl: 'https://links.example.com/hooks/email/new' };
      default:
        throw new Error(`unexpected command ${name}`);
    }
  };
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        return respond(name);
      }),
    },
    errText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  h.calls = [];
  h.emptySms = false;
  h.emailTracking = 'configurable';
});

/** The same channel wiring ProvidersPage uses, without the responsive table/card duplication. */
function Channels() {
  const channels = [useEmailChannel(), useSmsChannel(), usePushChannel(), useAiChannel()];
  return (
    <>
      {channels.map((channel) => (
        <div key={channel.key}>{channel.notices}</div>
      ))}
      <ChannelTable channels={channels} />
      {channels.map((channel) => (
        <div key={channel.key}>{channel.overlay}</div>
      ))}
    </>
  );
}

const renderChannels = () =>
  render(
    <ToastProvider>
      <Channels />
    </ToastProvider>,
  );

const fld = (scope: HTMLElement, label: string) =>
  within(scope).getByLabelText(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*?$`));

const row = async (name: string) => {
  const cell = await screen.findByText(name);
  return cell.closest('tr') as HTMLElement;
};

describe('Providers compact channel rows (#527)', () => {
  it('renders one template header and a row per channel, with routing summaries', async () => {
    render(
      <ToastProvider>
        <ProvidersPage />
      </ToastProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Providers' })).toBeTruthy();
    expect(screen.getByText('4 of 4 channels configured')).toBeTruthy();
    expect(screen.getAllByText('E-mail').length).toBeGreaterThan(0);
    expect(screen.getAllByText('SMS').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Push').length).toBeGreaterThan(0);
    expect(screen.getAllByText('AI').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Sends marketing e-mail').length).toBeGreaterThan(0);
  });

  it('keeps the e-mail drawer fields, the blank-keeps-credential rule and the routing transfer warning', async () => {
    renderChannels();
    const emailRow = await row('Newsletter delivery');
    expect(within(emailRow).getByText('Sends marketing e-mail')).toBeTruthy();
    await userEvent.click(within(emailRow).getByRole('button', { name: 'Edit' }));

    const drawer = await screen.findByRole('dialog', { name: 'Edit “Newsletter delivery”' });
    expect(fld(drawer, 'Name')).toHaveProperty('value', 'Newsletter delivery');
    expect(fld(drawer, 'From address')).toHaveProperty('value', 'news@example.com');
    expect(fld(drawer, 'From name')).toHaveProperty('value', 'Northstar Journal');
    expect(fld(drawer, 'Reply-to address')).toHaveProperty('value', 'hello@example.com');
    expect(within(drawer).getByRole('checkbox', { name: 'Transactional' })).toBeTruthy();
    expect(within(drawer).getByRole('checkbox', { name: 'Marketing' })).toHaveProperty('checked', true);
    expect(fld(drawer, 'Message stream')).toHaveProperty('value', 'broadcast');
    expect(fld(drawer, 'Server token')).toHaveProperty('value', '');
    expect(within(drawer).getByText(/Leave empty to keep the stored value/)).toBeTruthy();
    expect(within(drawer).getByText('Postmark tracks opens and clicks only when you enable it in the message stream.')).toBeTruthy();
    expect(
      within(drawer)
        .getByRole('link', { name: /Postmark setup guide/ })
        .getAttribute('href'),
    ).toBe('https://postmarkapp.com/developer');

    await userEvent.click(within(drawer).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(h.calls.some((c) => c.name === 'emailProviders.update')).toBe(true));
    const update = h.calls.find((c) => c.name === 'emailProviders.update');
    expect(update?.input).toMatchObject({ id: 'epr_1', fromEmail: 'news@example.com', useFor: ['marketing'] });
    expect(update?.input).not.toHaveProperty('secrets');
  });

  it('shows the forced tracking warning and route transfer copy', async () => {
    h.emailTracking = 'forced';
    renderChannels();
    expect(await screen.findByText(/adds open and click tracking to every marketing e-mail/)).toBeTruthy();
    const emailRow = await row('Newsletter delivery');
    expect(within(emailRow).getByText(/tracks opens and clicks only when/)).toBeTruthy();
  });

  it('keeps every SMS field, the incoming URL copy and the toggle', async () => {
    renderChannels();
    const smsRow = await row('Twilio alerts');
    expect(within(smsRow).getByRole('button', { name: 'Copy incoming messages URL' })).toBeTruthy();
    await userEvent.click(within(smsRow).getByRole('button', { name: 'Edit' }));

    const drawer = await screen.findByRole('dialog', { name: 'Edit Twilio alerts' });
    for (const label of [
      'Name',
      'Adapter',
      'Sender',
      'Cost per segment',
      'Monthly budget',
      'Currency',
      'Help text',
      'Account SID',
      'Messaging service SID',
      'API base URL',
      'Auth token',
    ])
      expect(fld(drawer, label)).toBeTruthy();
    expect(within(drawer).getByRole('checkbox', { name: 'Transactional messages' })).toHaveProperty('checked', true);
    expect(within(drawer).getByRole('checkbox', { name: 'Marketing messages' })).toBeTruthy();
    expect(within(drawer).getByText('Leave empty to keep the stored token.')).toBeTruthy();

    await userEvent.click(within(smsRow).getByRole('switch'));
    await waitFor(() =>
      expect(h.calls.find((c) => c.name === 'smsProviders.update')?.input).toMatchObject({ id: 'sms_1', enabled: false }),
    );
  });

  it('keeps push schema-specific setup for web push, Firebase and Apple', async () => {
    renderChannels();
    await screen.findByText('Web push');
    await userEvent.click(screen.getByRole('button', { name: 'Add push provider' }));

    const drawer = await screen.findByRole('dialog', { name: 'Add push provider' });
    expect(fld(drawer, 'Contact')).toBeTruthy();
    expect(within(drawer).getByText('VAPID keys are generated for you')).toBeTruthy();

    await userEvent.selectOptions(fld(drawer, 'Adapter'), 'fcm');
    for (const label of ['Project ID', 'API base URL', 'Token URL', 'Client email', 'Private key', 'Private key ID'])
      expect(fld(drawer, label)).toBeTruthy();

    await userEvent.selectOptions(fld(drawer, 'Adapter'), 'apns');
    for (const label of ['Team ID', 'Key ID', 'Topic', 'Environment', 'API base URL', 'Private key'])
      expect(fld(drawer, label)).toBeTruthy();

    await userEvent.selectOptions(fld(drawer, 'Adapter'), 'log');
    expect(within(drawer).getByText('Development outbox')).toBeTruthy();
  });

  it('keeps every AI field and the sensitive-data rule', async () => {
    renderChannels();
    const aiRow = await row('Anthropic');
    await userEvent.click(within(aiRow).getByRole('button', { name: 'Edit' }));

    const drawer = await screen.findByRole('dialog', { name: 'Edit Anthropic' });
    for (const label of ['Name', 'API style', 'Base URL', 'Default model', 'Fast model', 'Monthly token budget', 'Region', 'API key'])
      expect(fld(drawer, label)).toBeTruthy();
    expect(within(drawer).getByRole('checkbox', { name: 'Structured outputs' })).toHaveProperty('checked', true);
    expect(within(drawer).getByRole('checkbox', { name: 'Journeys' })).toHaveProperty('checked', true);
    expect(within(drawer).getByRole('checkbox', { name: 'Enabled' })).toHaveProperty('checked', true);
    expect(within(drawer).getByText('Leave empty to keep the stored key. Filling it replaces the key.')).toBeTruthy();
  });

  it('offers one create action for an empty channel', async () => {
    h.emptySms = true;
    renderChannels();
    expect(await screen.findByText('Not configured')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add SMS provider' })).toBeTruthy();
  });

  it('keeps the webhook replace action and its one-time URL', async () => {
    renderChannels();
    const emailRow = await row('Newsletter delivery');
    await userEvent.click(within(emailRow).getByRole('button', { name: 'More actions for Newsletter delivery' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Replace webhook URL' }));
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Replace URL' }));
    const modal = await screen.findByRole('dialog', { name: 'Webhook URL for “Newsletter delivery”' });
    expect(within(modal).getByText('https://links.example.com/hooks/email/new')).toBeTruthy();
  });
});

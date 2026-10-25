import { useState } from 'react';
import { BellRing, MessageSquare, MoreHorizontal, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  CodeView,
  Drawer,
  EmptyState,
  Field,
  FieldGroup,
  Input,
  LoadingBlock,
  Menu,
  Modal,
  Select,
  StatusPill,
  Switch,
  Table,
  TableFrame,
  Tag,
  THead,
  Td,
  Th,
  Tr,
  fieldErrors,
  useConfirm,
  useToast,
} from '../../ui';
import { ApiError, api, errText, type Out } from '../../app/api';
import { useApi } from '../../app/useApi';

type Sms = Out<'smsProviders.list'>['providers'][number];
type SmsAdapter = Sms['adapter'];
type MessageUse = 'transactional' | 'marketing';
type AiUse = Ai['useFor'][number];
type Push = Out<'pushProviders.list'>['providers'][number];
type PushAdapter = Push['adapter'];
type Ai = Out<'aiProviders.list'>['providers'][number];
type AiKind = Ai['kind'];

const SMS_ADAPTERS: { id: SmsAdapter; label: string }[] = [
  { id: 'twilio', label: 'Twilio' },
  { id: 'log', label: 'Development outbox (sends nothing)' },
];
const PUSH_ADAPTERS: { id: PushAdapter; label: string }[] = [
  { id: 'webpush', label: 'Web push (browsers)' },
  { id: 'fcm', label: 'Firebase Cloud Messaging (Android)' },
  { id: 'apns', label: 'Apple Push Notification service (Apple apps)' },
  { id: 'log', label: 'Development outbox (sends nothing)' },
];
const KIND_LABELS: Record<AiKind, string> = {
  'anthropic-compatible': 'Anthropic-compatible',
  'openai-compatible': 'OpenAI-compatible',
};
const MESSAGE_USES: { id: MessageUse; label: string }[] = [
  { id: 'transactional', label: 'Transactional messages' },
  { id: 'marketing', label: 'Marketing messages' },
];
const AI_USES: { id: AiUse; label: string }[] = [
  { id: 'journeys', label: 'Journeys' },
  { id: 'copilot', label: 'Copilot' },
];
const MESSAGE_USE_LABELS: Record<MessageUse, string> = { transactional: 'Transactional', marketing: 'Marketing' };
const AI_USE_LABELS: Record<AiUse, string> = { journeys: 'Journeys', copilot: 'Copilot' };

const smsLabel = (id: SmsAdapter) => SMS_ADAPTERS.find((a) => a.id === id)?.label ?? id;
const pushLabel = (id: PushAdapter) => PUSH_ADAPTERS.find((a) => a.id === id)?.label ?? id;

/** `fieldErrors` keys for the billing paths map onto the form's own field names. */
function providerErrors(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fieldErrors(details))) {
    const mapped = key
      .replace(/^billing\.pricePerSegment$/, 'price')
      .replace(/^billing\.currency$/, 'currency')
      .replace(/^billing\.monthlyBudget$/, 'budget')
      .replace(/^billing\.helpText$/, 'helpText')
      .replace(/^monthlyTokenBudget$/, 'budget')
      .replace(/^useFor(\.\d+)?$/, 'useFor');
    out[mapped] = value;
  }
  return out;
}

function adapterErrors(details: unknown, message: string, prefix: 'config' | 'secrets'): Record<string, string> {
  const raw = providerErrors(details);
  const prefixed: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    prefixed[/^(Settings|Credentials)/.test(message) ? `${prefix}.${key}` : key] = value;
  }
  return prefixed;
}

function UseFor<T extends string>({
  value,
  onChange,
  options,
  error,
}: {
  value: T[];
  onChange: (v: T[]) => void;
  options: { id: T; label: string }[];
  error?: string;
}) {
  const toggle = (use: T) => onChange(value.includes(use) ? value.filter((u) => u !== use) : [...value, use]);
  return (
    <FieldGroup legend="Use for" hint="Leave both empty to keep the provider available but unused.">
      {options.map((o) => (
        <Checkbox key={o.id} label={o.label} checked={value.includes(o.id)} onChange={() => toggle(o.id)} />
      ))}
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </FieldGroup>
  );
}

function MoreButton({ name, onDelete, busy }: { name: string; onDelete: () => void; busy?: boolean }) {
  return (
    <Menu
      label={`More for ${name}`}
      trigger={(t) => (
        <button
          {...t}
          type="button"
          aria-label={`More for ${name}`}
          className="inline-flex size-7 items-center justify-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg"
        >
          <MoreHorizontal size={16} />
        </button>
      )}
      items={[{ label: 'Delete', icon: <Trash2 size={14} />, destructive: true, disabled: busy, onSelect: onDelete }]}
    />
  );
}

/* ------------------------------------------------------------------ SMS */

type SmsForm = {
  name: string;
  adapter: SmsAdapter;
  sender: string;
  useFor: MessageUse[];
  price: string;
  budget: string;
  currency: string;
  helpText: string;
  accountSid: string;
  messagingServiceSid: string;
  apiBase: string;
  authToken: string;
};

function smsFormOf(p: Sms | null): SmsForm {
  return {
    name: p?.name ?? '',
    adapter: p?.adapter ?? 'twilio',
    sender: p?.sender ?? '',
    useFor: p?.useFor ?? [],
    price: p ? String(p.billing.pricePerSegment) : '0',
    budget: p?.billing.monthlyBudget == null ? '' : String(p.billing.monthlyBudget),
    currency: p?.billing.currency ?? 'USD',
    helpText: p?.billing.helpText ?? 'Reply STOP to unsubscribe.',
    accountSid: String(p?.config.accountSid ?? ''),
    messagingServiceSid: String(p?.config.messagingServiceSid ?? ''),
    apiBase: String(p?.config.apiBase ?? 'https://api.twilio.com'),
    authToken: '',
  };
}

const SENDER_RE = /^(\+[1-9]\d{6,14}|[A-Za-z][A-Za-z0-9 ]{1,10})$/;

function validateSms(f: SmsForm, editing: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.name.trim()) e.name = 'Give the provider a name.';
  if (!f.sender.trim()) e.sender = 'Enter the number or sender ID messages come from.';
  else if (!SENDER_RE.test(f.sender.trim())) e.sender = 'Use an international phone number such as +14155550123, or an alphanumeric sender ID.';
  if (f.adapter === 'twilio') {
    if (!/^AC[0-9a-f]{32}$/.test(f.accountSid.trim())) e['config.accountSid'] = 'Enter the Twilio account SID (starts with AC, then 32 hex characters).';
    if (f.messagingServiceSid.trim() && !/^MG[0-9a-f]{32}$/.test(f.messagingServiceSid.trim()))
      e['config.messagingServiceSid'] = 'Enter a messaging service SID (starts with MG, then 32 hex characters), or leave it empty.';
    if (!/^https?:\/\//.test(f.apiBase.trim())) e['config.apiBase'] = 'Enter the API base URL, for example https://api.twilio.com.';
    if (!editing && f.authToken.trim().length < 16) e['secrets.authToken'] = 'Enter the Twilio auth token.';
  }
  const price = Number(f.price);
  if (!f.price.trim() || Number.isNaN(price) || price < 0 || price > 10) e.price = 'Enter a cost per segment between 0 and 10.';
  if (f.budget.trim()) {
    const budget = Number(f.budget);
    if (Number.isNaN(budget) || budget < 0) e.budget = 'Enter a monthly budget of 0 or more, or leave it empty.';
  }
  if (!/^[A-Z]{3}$/.test(f.currency.trim().toUpperCase())) e.currency = 'Use a three-letter currency code, for example USD.';
  if (f.helpText.length > 300) e.helpText = 'Keep the help text to 300 characters or fewer.';
  return e;
}

function SmsDrawer({ provider, onClose, onSaved }: { provider: Sms | null; onClose: () => void; onSaved: (p: Sms | null, created?: { name: string; url: string }) => void }) {
  const [f, setF] = useState<SmsForm>(() => smsFormOf(provider));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = !!provider;
  const set = <K extends keyof SmsForm>(key: K, value: SmsForm[K]) => setF((cur) => ({ ...cur, [key]: value }));

  const save = async () => {
    const found = validateSms(f, editing);
    setErrors(found);
    setError(null);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const config =
        f.adapter === 'twilio'
          ? {
              accountSid: f.accountSid.trim(),
              ...(f.messagingServiceSid.trim() ? { messagingServiceSid: f.messagingServiceSid.trim() } : {}),
              apiBase: f.apiBase.trim(),
            }
          : {};
      const secrets = f.adapter === 'twilio' && f.authToken.trim() ? { authToken: f.authToken.trim() } : undefined;
      const billing = {
        pricePerSegment: Number(f.price),
        currency: f.currency.trim().toUpperCase(),
        ...(f.budget.trim() ? { monthlyBudget: Number(f.budget) } : {}),
        ...(f.helpText.trim() ? { helpText: f.helpText.trim() } : {}),
      };
      const useFor = f.useFor;
      if (provider) {
        await api.call('smsProviders.update', {
          id: provider.id,
          name: f.name.trim(),
          config,
          ...(secrets ? { secrets } : {}),
          sender: f.sender.trim(),
          useFor,
          billing,
        });
        onSaved(null);
      } else {
        const created = await api.call('smsProviders.create', {
          name: f.name.trim(),
          adapter: f.adapter,
          config,
          ...(secrets ? { secrets } : {}),
          sender: f.sender.trim(),
          useFor,
          billing,
        });
        onSaved(created, { name: created.name, url: `${location.origin}${created.webhookPath}/inbound` });
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_input') {
        const prefix = /^Credentials/.test(e.message) ? 'secrets' : 'config';
        setErrors(adapterErrors(e.details, e.message, prefix));
      }
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title={provider ? `Edit ${provider.name}` : 'Add SMS provider'}
      meta={provider ? <span className="font-mono text-[12px]">{provider.id}</span> : 'Send text messages from journeys and broadcasts.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="sms-provider-form" loading={saving}>
            {provider ? 'Save changes' : 'Add provider'}
          </Button>
        </>
      }
    >
      <form
        id="sms-provider-form"
        className="space-y-6 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" hint="How this provider appears in journeys and settings." error={errors.name} required>
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus />
        </Field>
        <Field label="Adapter" hint={f.adapter === 'log' ? 'Writes messages to the server log instead of sending them.' : 'Twilio sends messages through your account.'}>
          <Select
            value={f.adapter}
            disabled={editing}
            onChange={(e) => {
              const adapter = e.target.value as SmsAdapter;
              setF((cur) => ({ ...cur, adapter }));
            }}
          >
            {SMS_ADAPTERS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Sender"
          hint="The number recipients see. Use E.164 format such as +14155550123, or an alphanumeric sender ID."
          error={errors.sender}
          required
        >
          <Input value={f.sender} onChange={(e) => set('sender', e.target.value)} />
        </Field>
        <UseFor value={f.useFor} onChange={(v) => set('useFor', v)} options={MESSAGE_USES} error={errors.useFor} />

        <FieldGroup legend="Cost and limits">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cost per segment" unit={f.currency || 'USD'} error={errors.price} hint="Used to estimate journey costs." required>
              <Input inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value)} />
            </Field>
            <Field label="Monthly budget" unit={f.currency || 'USD'} error={errors.budget} hint="Optional. Sending stops when the budget is reached.">
              <Input inputMode="decimal" value={f.budget} onChange={(e) => set('budget', e.target.value)} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Currency" hint="Three-letter code, for example USD." error={errors.currency}>
              <Input value={f.currency} maxLength={3} onChange={(e) => set('currency', e.target.value.toUpperCase())} />
            </Field>
            <Field label="Help text" hint="Appended where opt-out instructions are required." error={errors.helpText}>
              <Input value={f.helpText} onChange={(e) => set('helpText', e.target.value)} />
            </Field>
          </div>
        </FieldGroup>

        {f.adapter === 'twilio' ? (
          <>
            <FieldGroup legend="Twilio settings">
              <Field label="Account SID" error={errors['config.accountSid']} hint="Starts with AC, followed by 32 characters." required>
                <Input value={f.accountSid} onChange={(e) => set('accountSid', e.target.value)} />
              </Field>
              <Field label="Messaging service SID" error={errors['config.messagingServiceSid']} hint="Optional. Use it to let Twilio choose a sender from a pool.">
                <Input value={f.messagingServiceSid} onChange={(e) => set('messagingServiceSid', e.target.value)} />
              </Field>
              <Field label="API base URL" error={errors['config.apiBase']} hint="Leave the default unless you use a Twilio-compatible gateway.">
                <Input type="url" value={f.apiBase} onChange={(e) => set('apiBase', e.target.value)} />
              </Field>
            </FieldGroup>
            <Field
              label="Auth token"
              error={errors['secrets.authToken']}
              hint={provider?.hasCredentials ? 'Leave empty to keep the stored token.' : 'From the Twilio console. It is stored encrypted and never shown again.'}
              required={!provider}
            >
              <Input type="password" autoComplete="new-password" value={f.authToken} onChange={(e) => set('authToken', e.target.value)} />
            </Field>
          </>
        ) : (
          <Alert tone="info" title="Development outbox">
            Messages are written to the server log and are not delivered. Use it to test journeys without a Twilio account.
          </Alert>
        )}

        {error && (
          <Alert tone="bad" title={provider ? 'Not saved' : 'Not added'}>
            {error}
          </Alert>
        )}
      </form>
    </Drawer>
  );
}

export function SmsCard() {
  const list = useApi(() => api.call('smsProviders.list', {}), []);
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [editing, setEditing] = useState<Sms | 'new' | null>(null);
  const [created, setCreated] = useState<{ name: string; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (p: Sms) => {
    setBusy(p.id);
    try {
      await api.call('smsProviders.update', { id: p.id, enabled: !p.enabled });
      toast.success(p.enabled ? `Disabled “${p.name}”. Messages will not be sent through it.` : `Enabled “${p.name}”. Messages will be sent through it.`);
      await list.reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (p: Sms) => {
    const ok = await confirm({
      title: `Delete “${p.name}”?`,
      body: <>Messages that use this provider will stop sending until another one is chosen. Stored credentials are deleted.</>,
      confirmLabel: 'Delete provider',
      destructive: true,
      typeToConfirm: p.name,
    });
    if (!ok) return;
    setBusy(p.id);
    try {
      await api.call('smsProviders.delete', { id: p.id });
      toast.success(`Deleted “${p.name}”.`);
      await list.reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const providers = list.data?.providers ?? [];
  return (
    <>
      <Card
        title="SMS"
        description="Send text messages through Twilio, or log them in development, with opt-out handling for your audience."
        action={
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
            Add SMS provider
          </Button>
        }
      >
        {list.loading ? (
          <LoadingBlock lines={4} />
        ) : list.error ? (
          <div className="p-3">
            <Alert tone="bad" title="Couldn't load SMS providers" onRetry={list.reload}>
              {errText(list.error)}
            </Alert>
          </div>
        ) : providers.length === 0 ? (
          <EmptyState
            icon={<MessageSquare size={20} />}
            title="No SMS provider yet"
            action={
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
                Add SMS provider
              </Button>
            }
          >
            Add Twilio so journeys and broadcasts can send text messages, or a development outbox that only writes to the server log. Set the number's incoming-message webhook to the URL shown after you add a Twilio provider, so STOP and HELP replies are handled.
          </EmptyState>
        ) : (
          <TableFrame columns={6}>
            <Table label="SMS providers">
              <THead>
                <tr>
                  <Th>Name</Th>
                  <Th className="hidden md:table-cell">Sender</Th>
                  <Th className="hidden lg:table-cell">Use for</Th>
                  <Th className="hidden md:table-cell">Cost</Th>
                  <Th>Status</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </THead>
              <tbody>
                {providers.map((p) => {
                  const url = `${location.origin}${p.webhookPath}/inbound`;
                  return (
                    <Tr key={p.id}>
                      <Td>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-fg">{p.name}</span>
                          <Tag>{smsLabel(p.adapter)}</Tag>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                          <span className="min-w-0 truncate font-mono" title={url}>
                            {url}
                          </span>
                          <span className="sr-only">Incoming messages URL</span>
                          <CopyInline value={url} label="Copy incoming messages URL" />
                        </div>
                      </Td>
                      <Td className="hidden md:table-cell">{p.sender}</Td>
                      <Td className="hidden lg:table-cell">{p.useFor.length ? p.useFor.map((u) => MESSAGE_USE_LABELS[u]).join(', ') : 'Not used'}</Td>
                      <Td className="hidden md:table-cell whitespace-nowrap">
                        {p.billing.pricePerSegment} {p.billing.currency}/segment
                        {p.billing.monthlyBudget != null && <div className="text-[11px] text-muted">Budget {p.billing.monthlyBudget} {p.billing.currency}/month</div>}
                      </Td>
                      <Td>
                        <StatusPill tone={p.enabled ? 'good' : 'neutral'}>{p.enabled ? 'Enabled' : 'Disabled'}</StatusPill>
                      </Td>
                      <Td align="right">
                        <div className="flex items-center justify-end gap-2">
                          <Switch checked={p.enabled} onChange={() => void toggle(p)} label={`Enable ${p.name}`} hideLabel disabled={busy === p.id} />
                          <Button size="sm" icon={<Pencil size={14} />} onClick={() => setEditing(p)}>
                            Edit
                          </Button>
                          <MoreButton name={p.name} onDelete={() => void remove(p)} busy={busy === p.id} />
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableFrame>
        )}
      </Card>

      {editing && (
        <SmsDrawer
          key={editing === 'new' ? 'new' : editing.id}
          provider={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(p, inbound) => {
            setEditing(null);
            if (inbound) setCreated(inbound);
            toast.success(inbound ? `Added “${inbound.name}”. Copy the incoming-message URL and set it in Twilio.` : p ? `Saved “${p.name}”.` : 'SMS provider added.');
            void list.reload();
          }}
        />
      )}

      <Modal
        open={!!created}
        onClose={() => setCreated(null)}
        title={`Incoming messages URL for “${created?.name ?? ''}”`}
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            I've saved it
          </Button>
        }
      >
        <p className="mb-3">Set this as the incoming-message webhook for the number in Twilio. It handles STOP, HELP and other replies.</p>
        <CodeView value={created?.url ?? ''} label="Webhook URL" maxHeight={120} />
        <p className="mt-3 text-[12px] text-muted">The URL stays available on the provider row in this list.</p>
      </Modal>
      {confirmDialog}
    </>
  );
}

/** CopyButton with the row layout used in tables. */
function CopyInline({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-surface-2 hover:text-fg"
      onClick={async () => {
        await navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <span className="text-[11px]">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

/* ----------------------------------------------------------------- PUSH */

type PushForm = {
  name: string;
  adapter: PushAdapter;
  useFor: MessageUse[];
  enabled: boolean;
  subject: string;
  projectId: string;
  apiBase: string;
  tokenUrl: string;
  clientEmail: string;
  privateKey: string;
  privateKeyId: string;
  teamId: string;
  keyId: string;
  topic: string;
  environment: 'production' | 'sandbox';
  apnsBase: string;
};

function pushFormOf(p: Push | null): PushForm {
  const c = p?.config ?? {};
  return {
    name: p?.name ?? '',
    adapter: p?.adapter ?? 'webpush',
    useFor: p?.useFor ?? [],
    enabled: p?.enabled ?? true,
    subject: String(c.subject ?? ''),
    projectId: String(c.projectId ?? ''),
    apiBase: String(c.apiBase ?? 'https://fcm.googleapis.com'),
    tokenUrl: String(c.tokenUrl ?? 'https://oauth2.googleapis.com/token'),
    clientEmail: '',
    privateKey: '',
    privateKeyId: '',
    teamId: String(c.teamId ?? ''),
    keyId: String(c.keyId ?? ''),
    topic: String(c.topic ?? ''),
    environment: c.environment === 'sandbox' ? 'sandbox' : 'production',
    apnsBase: String(c.apiBase ?? ''),
  };
}

function validatePush(f: PushForm, editing: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.name.trim()) e.name = 'Give the provider a name.';
  if (f.adapter === 'webpush' && !/^(mailto:|https:\/\/)/.test(f.subject.trim()))
    e['config.subject'] = 'Enter a contact for the VAPID token, starting with mailto: or https://.';
  if (f.adapter === 'fcm') {
    if (!/^[a-z0-9-]{4,40}$/.test(f.projectId.trim())) e['config.projectId'] = 'Enter the Firebase project ID (4–40 lowercase letters, digits or dashes).';
    if (!/^https?:\/\//.test(f.apiBase.trim())) e['config.apiBase'] = 'Enter the FCM API base URL.';
    if (!/^https?:\/\//.test(f.tokenUrl.trim())) e['config.tokenUrl'] = 'Enter the OAuth token URL.';
    if (!editing || f.clientEmail.trim() || f.privateKey.trim()) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.clientEmail.trim())) e['secrets.clientEmail'] = 'Enter the service account email.';
      if (!f.privateKey.includes('PRIVATE KEY')) e['secrets.privateKey'] = 'Paste the service account private key, including the BEGIN/END lines.';
    }
  }
  if (f.adapter === 'apns') {
    if (!/^[A-Z0-9]{10}$/.test(f.teamId.trim())) e['config.teamId'] = 'Enter the 10-character Apple team ID.';
    if (!/^[A-Z0-9]{10}$/.test(f.keyId.trim())) e['config.keyId'] = 'Enter the 10-character key ID.';
    if (f.topic.trim().length < 3) e['config.topic'] = 'Enter the app bundle ID.';
    if (f.apnsBase.trim() && !/^https?:\/\//.test(f.apnsBase.trim())) e['config.apiBase'] = 'Enter an Apple Push Notification service URL, or leave it empty.';
    if (!editing && !f.privateKey.includes('PRIVATE KEY')) e['secrets.privateKey'] = 'Paste the .p8 key, including the BEGIN/END lines.';
  }
  return e;
}

function PushDrawer({ provider, onClose, onSaved }: { provider: Push | null; onClose: () => void; onSaved: (p: Push | null) => void }) {
  const [f, setF] = useState<PushForm>(() => pushFormOf(provider));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = !!provider;
  const set = <K extends keyof PushForm>(key: K, value: PushForm[K]) => setF((cur) => ({ ...cur, [key]: value }));

  const save = async () => {
    const found = validatePush(f, editing);
    setErrors(found);
    setError(null);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const config =
        f.adapter === 'webpush'
          ? { subject: f.subject.trim() }
          : f.adapter === 'fcm'
            ? { projectId: f.projectId.trim(), apiBase: f.apiBase.trim(), tokenUrl: f.tokenUrl.trim() }
            : f.adapter === 'apns'
              ? {
                  teamId: f.teamId.trim(),
                  keyId: f.keyId.trim(),
                  topic: f.topic.trim(),
                  environment: f.environment,
                  ...(f.apnsBase.trim() ? { apiBase: f.apnsBase.trim() } : {}),
                }
              : {};
      const secrets =
        f.adapter === 'fcm' && f.clientEmail.trim() && f.privateKey.trim()
          ? { clientEmail: f.clientEmail.trim(), privateKey: f.privateKey, ...(f.privateKeyId.trim() ? { privateKeyId: f.privateKeyId.trim() } : {}) }
          : (f.adapter === 'fcm' || f.adapter === 'apns') && f.privateKey.includes('PRIVATE KEY')
            ? { privateKey: f.privateKey }
            : undefined;
      const base = { name: f.name.trim(), config, ...(secrets ? { secrets } : {}), useFor: f.useFor };
      if (provider) {
        await api.call('pushProviders.update', { id: provider.id, ...base, enabled: f.enabled });
        onSaved(null);
      } else {
        // webpush: omit secrets so the server generates the VAPID key pair.
        const created = await api.call('pushProviders.create', { ...base, adapter: f.adapter });
        onSaved(created);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_input') {
        const prefix = /^Credentials/.test(e.message) ? 'secrets' : 'config';
        setErrors(adapterErrors(e.details, e.message, prefix));
      }
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title={provider ? `Edit ${provider.name}` : 'Add push provider'}
      meta={provider ? <span className="font-mono text-[12px]">{provider.id}</span> : 'Send push notifications from journeys.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="push-provider-form" loading={saving}>
            {provider ? 'Save changes' : 'Add provider'}
          </Button>
        </>
      }
    >
      <form
        id="push-provider-form"
        className="space-y-6 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" hint="How this provider appears in journeys and settings." error={errors.name} required>
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus />
        </Field>
        <Field label="Adapter" hint={f.adapter === 'log' ? 'Writes messages to the server log instead of sending them.' : 'Choose the push service your app uses.'}>
          <Select
            value={f.adapter}
            onChange={(e) => {
              const adapter = e.target.value as PushAdapter;
              setF((cur) => ({ ...cur, adapter }));
            }}
            disabled={editing}
          >
            {PUSH_ADAPTERS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <UseFor value={f.useFor} onChange={(v) => set('useFor', v)} options={MESSAGE_USES} error={errors.useFor} />
        {editing && (
          <Checkbox label="Enabled" hint="Disabled providers are skipped; push steps then do nothing." checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        )}

        {f.adapter === 'webpush' && (
          <>
            <Field
              label="Contact"
              error={errors['config.subject']}
              hint="A mailto: or https:// address for the VAPID token. Push services use it to contact you about your traffic."
              required
            >
              <Input value={f.subject} placeholder="mailto:ops@example.com" onChange={(e) => set('subject', e.target.value)} />
            </Field>
            <Alert tone="info" title={editing ? 'VAPID keys stay as they are' : 'VAPID keys are generated for you'}>
              {editing
                ? 'The public and private keys were created when you added this provider and cannot be changed here.'
                : 'The server creates a public and private VAPID key pair. Use the public key from the provider row in your browser app.'}
            </Alert>
            {editing && provider && typeof provider.config.publicKey === 'string' && (
              <Field label="Public key" hint="Give this to your browser app when it subscribes to push.">
                <Input readOnly value={provider.config.publicKey} className="font-mono" onFocus={(e) => e.currentTarget.select()} />
              </Field>
            )}
          </>
        )}

        {f.adapter === 'fcm' && (
          <>
            <FieldGroup legend="Firebase settings">
              <Field label="Project ID" error={errors['config.projectId']} hint="From the Firebase console." required>
                <Input value={f.projectId} onChange={(e) => set('projectId', e.target.value)} />
              </Field>
              <Field label="API base URL" error={errors['config.apiBase']} hint="Leave the default unless you use a proxy.">
                <Input type="url" value={f.apiBase} onChange={(e) => set('apiBase', e.target.value)} />
              </Field>
              <Field label="Token URL" error={errors['config.tokenUrl']} hint="Google's OAuth token endpoint.">
                <Input type="url" value={f.tokenUrl} onChange={(e) => set('tokenUrl', e.target.value)} />
              </Field>
            </FieldGroup>
            <FieldGroup legend="Service account" hint={editing ? 'Leave both fields empty to keep the stored credentials.' : 'Create a service account key in the Firebase console.'}>
              <Field label="Client email" error={errors['secrets.clientEmail']} required={!editing}>
                <Input type="email" value={f.clientEmail} onChange={(e) => set('clientEmail', e.target.value)} />
              </Field>
              <Field label="Private key" error={errors['secrets.privateKey']} required={!editing} hint="Paste the whole key, including the BEGIN and END lines.">
                <Input type="password" autoComplete="new-password" value={f.privateKey} onChange={(e) => set('privateKey', e.target.value)} />
              </Field>
              <Field label="Private key ID" hint="Optional. Helps identify the key in Google's audit logs.">
                <Input value={f.privateKeyId} onChange={(e) => set('privateKeyId', e.target.value)} />
              </Field>
            </FieldGroup>
          </>
        )}

        {f.adapter === 'apns' && (
          <>
            <FieldGroup legend="Apple settings">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Team ID" error={errors['config.teamId']} hint="10 characters, from your Apple developer account." required>
                  <Input value={f.teamId} onChange={(e) => set('teamId', e.target.value.toUpperCase())} />
                </Field>
                <Field label="Key ID" error={errors['config.keyId']} hint="10 characters, shown next to the .p8 key." required>
                  <Input value={f.keyId} onChange={(e) => set('keyId', e.target.value.toUpperCase())} />
                </Field>
              </div>
              <Field label="Topic" error={errors['config.topic']} hint="The app bundle ID, for example com.example.app." required>
                <Input value={f.topic} onChange={(e) => set('topic', e.target.value)} />
              </Field>
              <Field label="Environment">
                <Select value={f.environment} onChange={(e) => set('environment', e.target.value as 'production' | 'sandbox')}>
                  <option value="production">Production</option>
                  <option value="sandbox">Sandbox</option>
                </Select>
              </Field>
              <Field label="API base URL" error={errors['config.apiBase']} hint="Optional. Leave it empty to use Apple's default endpoint.">
                <Input type="url" value={f.apnsBase} onChange={(e) => set('apnsBase', e.target.value)} />
              </Field>
            </FieldGroup>
            <Field
              label="Private key"
              error={errors['secrets.privateKey']}
              hint={editing ? 'Leave empty to keep the stored key. Paste a key to replace it.' : 'Paste the .p8 key, including the BEGIN and END lines.'}
              required={!editing}
            >
              <Input type="password" autoComplete="new-password" value={f.privateKey} onChange={(e) => set('privateKey', e.target.value)} />
            </Field>
          </>
        )}

        {f.adapter === 'log' && (
          <Alert tone="info" title="Development outbox">
            Push messages are written to the server log and are not delivered. Use it to test journeys without a push service.
          </Alert>
        )}

        {error && (
          <Alert tone="bad" title={provider ? 'Not saved' : 'Not added'}>
            {error}
          </Alert>
        )}
      </form>
    </Drawer>
  );
}

export function PushCard() {
  const list = useApi(() => api.call('pushProviders.list', {}), []);
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [editing, setEditing] = useState<Push | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (p: Push) => {
    setBusy(p.id);
    try {
      await api.call('pushProviders.update', { id: p.id, enabled: !p.enabled });
      toast.success(p.enabled ? `Disabled “${p.name}”. Push steps will skip it.` : `Enabled “${p.name}”. Push steps will use it.`);
      await list.reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (p: Push) => {
    const ok = await confirm({
      title: `Delete “${p.name}”?`,
      body: <>Push steps that use this provider will do nothing until another one is chosen. Stored credentials are deleted.</>,
      confirmLabel: 'Delete provider',
      destructive: true,
      typeToConfirm: p.name,
    });
    if (!ok) return;
    setBusy(p.id);
    try {
      await api.call('pushProviders.delete', { id: p.id });
      toast.success(`Deleted “${p.name}”.`);
      await list.reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const providers = list.data?.providers ?? [];
  return (
    <>
      <Card
        title="Push"
        description="Send browser, Android and Apple push notifications to people in your audience."
        action={
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
            Add push provider
          </Button>
        }
      >
        {list.loading ? (
          <LoadingBlock lines={4} />
        ) : list.error ? (
          <div className="p-3">
            <Alert tone="bad" title="Couldn't load push providers" onRetry={list.reload}>
              {errText(list.error)}
            </Alert>
          </div>
        ) : providers.length === 0 ? (
          <EmptyState
            icon={<BellRing size={20} />}
            title="No push provider yet"
            action={
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
                Add push provider
              </Button>
            }
          >
            Add web push for browsers, Firebase for Android or Apple Push Notification service for Apple apps. Until then, push steps in journeys send nothing.
          </EmptyState>
        ) : (
          <TableFrame columns={5}>
            <Table label="Push providers">
              <THead>
                <tr>
                  <Th>Name</Th>
                  <Th className="hidden md:table-cell">Adapter</Th>
                  <Th className="hidden lg:table-cell">Use for</Th>
                  <Th>Status</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </THead>
              <tbody>
                {providers.map((p) => (
                  <Tr key={p.id}>
                    <Td>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-fg">{p.name}</span>
                        {p.adapter === 'webpush' && typeof p.config.publicKey === 'string' && (
                          <CopyInline value={p.config.publicKey} label={`Copy public key for ${p.name}`} />
                        )}
                      </div>
                      {p.adapter === 'log' && <div className="mt-0.5 text-[11px] text-muted">Writes to the server log.</div>}
                    </Td>
                    <Td className="hidden md:table-cell">{pushLabel(p.adapter)}</Td>
                    <Td className="hidden lg:table-cell">{p.useFor.length ? p.useFor.map((u) => MESSAGE_USE_LABELS[u]).join(', ') : 'Not used'}</Td>
                    <Td>
                      <StatusPill tone={p.enabled ? 'good' : 'neutral'}>{p.enabled ? 'Enabled' : 'Disabled'}</StatusPill>
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-2">
                        <Switch checked={p.enabled} onChange={() => void toggle(p)} label={`Enable ${p.name}`} hideLabel disabled={busy === p.id} />
                        <Button size="sm" icon={<Pencil size={14} />} onClick={() => setEditing(p)}>
                          Edit
                        </Button>
                        <MoreButton name={p.name} onDelete={() => void remove(p)} busy={busy === p.id} />
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableFrame>
        )}
      </Card>

      {editing && (
        <PushDrawer
          key={editing === 'new' ? 'new' : editing.id}
          provider={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            setEditing(null);
            toast.success(p ? `Added “${p.name}”.` : 'Push provider saved.');
            void list.reload();
          }}
        />
      )}
      {confirmDialog}
    </>
  );
}

/* ------------------------------------------------------------------- AI */

type AiForm = {
  name: string;
  kind: AiKind;
  baseUrl: string;
  model: string;
  fastModel: string;
  structuredOutputs: boolean;
  useFor: AiUse[];
  budget: string;
  region: string;
  enabled: boolean;
  apiKey: string;
};

function aiFormOf(p: Ai | null): AiForm {
  return {
    name: p?.name ?? '',
    kind: p?.kind ?? 'anthropic-compatible',
    baseUrl: p?.baseUrl ?? 'https://api.anthropic.com/v1',
    model: p?.models.default ?? '',
    fastModel: p?.models.fast ?? '',
    structuredOutputs: p?.structuredOutputs ?? true,
    useFor: p?.useFor ?? [],
    budget: p?.monthlyTokenBudget === null || p?.monthlyTokenBudget === undefined ? '' : String(p.monthlyTokenBudget),
    region: p?.region ?? '',
    enabled: p?.enabled ?? true,
    apiKey: '',
  };
}

function validateAi(f: AiForm, editing: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.name.trim()) e.name = 'Give the provider a name.';
  if (!/^https?:\/\/\S+$/.test(f.baseUrl.trim())) e.baseUrl = 'Enter the API base URL, for example https://api.anthropic.com/v1.';
  if (!f.model.trim()) e['models.default'] = 'Enter the model to use by default.';
  if (f.budget.trim()) {
    const budget = Number(f.budget);
    if (!Number.isInteger(budget) || budget < 0) e.budget = 'Enter a whole number of tokens, or leave it empty.';
  }
  if (f.region.length > 120) e.region = 'Keep the region to 120 characters or fewer.';
  if (!editing && !f.apiKey.trim()) e.apiKey = 'Enter the API key for this provider.';
  return e;
}

function AiDrawer({ provider, onClose, onSaved }: { provider: Ai | null; onClose: () => void; onSaved: (p: Ai | null) => void }) {
  const [f, setF] = useState<AiForm>(() => aiFormOf(provider));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = !!provider;
  const set = <K extends keyof AiForm>(key: K, value: AiForm[K]) => setF((cur) => ({ ...cur, [key]: value }));

  const changeKind = (kind: AiKind) => {
    setF((cur) => {
      const preset = kind === 'anthropic-compatible';
      const knownName = ['', 'Anthropic', 'OpenAI'].includes(cur.name);
      const knownUrl = ['', 'https://api.anthropic.com/v1', 'https://api.openai.com/v1'].includes(cur.baseUrl);
      return {
        ...cur,
        kind,
        name: knownName ? (preset ? 'Anthropic' : 'OpenAI') : cur.name,
        baseUrl: knownUrl ? (preset ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1') : cur.baseUrl,
        model: cur.model || (preset ? 'claude-sonnet-5-5' : ''),
      };
    });
  };

  const save = async () => {
    const found = validateAi(f, editing);
    setErrors(found);
    setError(null);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const models = { default: f.model.trim(), ...(f.fastModel.trim() ? { fast: f.fastModel.trim() } : {}) };
      const input = {
        name: f.name.trim(),
        kind: f.kind,
        baseUrl: f.baseUrl.trim(),
        models,
        structuredOutputs: f.structuredOutputs,
        useFor: f.useFor,
        monthlyTokenBudget: f.budget.trim() ? Number(f.budget) : null,
        region: f.region.trim(),
        ...(f.apiKey.trim() ? { apiKey: f.apiKey.trim() } : {}),
      };
      if (provider) {
        await api.call('aiProviders.update', {
          id: provider.id,
          name: input.name,
          baseUrl: input.baseUrl,
          models: input.models,
          structuredOutputs: input.structuredOutputs,
          useFor: input.useFor,
          monthlyTokenBudget: input.monthlyTokenBudget,
          region: input.region,
          ...(f.apiKey.trim() ? { apiKey: f.apiKey.trim() } : {}),
          enabled: f.enabled,
        });
        onSaved(null);
      } else {
        const created = await api.call('aiProviders.create', { ...input, apiKey: f.apiKey.trim() });
        onSaved(created);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_input') setErrors(providerErrors(e.details));
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title={provider ? `Edit ${provider.name}` : 'Add AI provider'}
      meta={provider ? <span className="font-mono text-[12px]">{provider.id}</span> : 'Use your own model account for journey AI steps and the copilot.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="ai-provider-form" loading={saving}>
            {provider ? 'Save changes' : 'Add provider'}
          </Button>
        </>
      }
    >
      <form
        id="ai-provider-form"
        className="space-y-6 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" hint="How this provider appears in journeys and settings." error={errors.name} required>
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus />
        </Field>
        <Field label="API style" hint={editing ? 'The API style cannot be changed after the provider is added.' : 'Choose the API your model endpoint speaks.'}>
          <Select value={f.kind} disabled={editing} onChange={(e) => changeKind(e.target.value as AiKind)}>
            <option value="anthropic-compatible">Anthropic-compatible</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </Select>
        </Field>
        <Field label="Base URL" error={errors.baseUrl} hint="The API root, including the version path when the provider needs one." required>
          <Input type="url" value={f.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
        </Field>
        <FieldGroup legend="Models">
          <Field label="Default model" error={errors['models.default']} hint="The model ID your provider expects, for example claude-sonnet-5-5." required>
            <Input value={f.model} onChange={(e) => set('model', e.target.value)} />
          </Field>
          <Field label="Fast model" error={errors['models.fast']} hint="Optional. Used for short tasks such as classifying intent or picking a segment.">
            <Input value={f.fastModel} onChange={(e) => set('fastModel', e.target.value)} />
          </Field>
          <Checkbox
            label="Structured outputs"
            hint="Leave on when the model supports JSON schema responses. Turn off if it rejects them."
            checked={f.structuredOutputs}
            onChange={(e) => set('structuredOutputs', e.target.checked)}
          />
        </FieldGroup>
        <UseFor value={f.useFor} onChange={(v) => set('useFor', v)} options={AI_USES} error={errors.useFor} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Monthly token budget"
            unit="tokens"
            error={errors.budget}
            hint="Optional. AI steps stop when the budget is reached."
          >
            <Input inputMode="numeric" value={f.budget} onChange={(e) => set('budget', e.target.value)} />
          </Field>
          <Field label="Region" error={errors.region} hint="Optional. Where your provider processes requests.">
            <Input value={f.region} onChange={(e) => set('region', e.target.value)} />
          </Field>
        </div>
        {editing && (
          <Checkbox label="Enabled" hint="Disabled providers are skipped by AI steps and the copilot." checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        )}
        <Field
          label="API key"
          error={errors.apiKey}
          hint={provider?.hasApiKey ? 'Leave empty to keep the stored key. Filling it replaces the key.' : 'Stored encrypted and never shown again.'}
          required={!provider}
        >
          <Input type="password" autoComplete="new-password" value={f.apiKey} onChange={(e) => set('apiKey', e.target.value)} />
        </Field>

        {error && (
          <Alert tone="bad" title={provider ? 'Not saved' : 'Not added'}>
            {error}
          </Alert>
        )}
      </form>
    </Drawer>
  );
}

export function AiCard() {
  const list = useApi(() => api.call('aiProviders.list', {}), []);
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [editing, setEditing] = useState<Ai | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (p: Ai) => {
    setBusy(p.id);
    try {
      await api.call('aiProviders.update', { id: p.id, enabled: !p.enabled });
      toast.success(p.enabled ? `Disabled “${p.name}”. AI steps will skip it.` : `Enabled “${p.name}”. AI steps will use it.`);
      await list.reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (p: Ai) => {
    const ok = await confirm({
      title: `Delete “${p.name}”?`,
      body: <>Journeys and the copilot will fail when they try to use this provider, until another one is chosen. The stored API key is deleted.</>,
      confirmLabel: 'Delete provider',
      destructive: true,
      typeToConfirm: p.name,
    });
    if (!ok) return;
    setBusy(p.id);
    try {
      await api.call('aiProviders.delete', { id: p.id });
      toast.success(`Deleted “${p.name}”.`);
      await list.reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const providers = list.data?.providers ?? [];
  return (
    <>
      <Card
        title="AI"
        description="Connect a model account for AI steps in journeys and the copilot."
        action={
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
            Add AI provider
          </Button>
        }
      >
        {list.loading ? (
          <LoadingBlock lines={4} />
        ) : list.error ? (
          <div className="p-3">
            <Alert tone="bad" title="Couldn't load AI providers" onRetry={list.reload}>
              {errText(list.error)}
            </Alert>
          </div>
        ) : providers.length === 0 ? (
          <EmptyState
            icon={<Sparkles size={20} />}
            title="No AI provider yet"
            action={
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
                Add AI provider
              </Button>
            }
          >
            Add an OpenAI- or Anthropic-compatible endpoint with your own API key to run AI steps in journeys and the copilot. Until then, AI steps take their fallback.
          </EmptyState>
        ) : (
          <TableFrame columns={5}>
            <Table label="AI providers">
              <THead>
                <tr>
                  <Th>Name</Th>
                  <Th className="hidden md:table-cell">Models</Th>
                  <Th className="hidden lg:table-cell">Use for</Th>
                  <Th>Status</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </THead>
              <tbody>
                {providers.map((p) => (
                  <Tr key={p.id}>
                    <Td>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-fg">{p.name}</span>
                        <Tag>{KIND_LABELS[p.kind]}</Tag>
                      </div>
                      <div className="mt-0.5 max-w-[280px] truncate font-mono text-[11px] text-muted" title={p.baseUrl}>
                        {p.baseUrl}
                      </div>
                      {p.monthlyTokenBudget !== null && (
                        <div className="mt-0.5 text-[11px] text-muted">
                          {p.usedThisMonth.toLocaleString()} / {p.monthlyTokenBudget.toLocaleString()} tokens this month
                        </div>
                      )}
                      {p.monthlyTokenBudget === null && p.usedThisMonth > 0 && (
                        <div className="mt-0.5 text-[11px] text-muted">{p.usedThisMonth.toLocaleString()} tokens this month</div>
                      )}
                    </Td>
                    <Td className="hidden md:table-cell">
                      <div className="font-mono text-[12px]">{p.models.default}</div>
                      {p.models.fast && <div className="font-mono text-[11px] text-muted">Fast: {p.models.fast}</div>}
                    </Td>
                    <Td className="hidden lg:table-cell">{p.useFor.length ? p.useFor.map((u) => AI_USE_LABELS[u]).join(', ') : 'Not used'}</Td>
                    <Td>
                      <StatusPill tone={p.enabled ? 'good' : 'neutral'}>{p.enabled ? 'Enabled' : 'Disabled'}</StatusPill>
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-2">
                        <Switch checked={p.enabled} onChange={() => void toggle(p)} label={`Enable ${p.name}`} hideLabel disabled={busy === p.id} />
                        <Button size="sm" icon={<Pencil size={14} />} onClick={() => setEditing(p)}>
                          Edit
                        </Button>
                        <MoreButton name={p.name} onDelete={() => void remove(p)} busy={busy === p.id} />
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableFrame>
        )}
      </Card>

      {editing && (
        <AiDrawer
          key={editing === 'new' ? 'new' : editing.id}
          provider={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            setEditing(null);
            toast.success(p ? `Added “${p.name}”.` : 'AI provider saved.');
            void list.reload();
          }}
        />
      )}
      {confirmDialog}
    </>
  );
}

export function OtherProviders() {
  return (
    <div className="space-y-6">
      <SmsCard />
      <PushCard />
      <AiCard />
    </div>
  );
}

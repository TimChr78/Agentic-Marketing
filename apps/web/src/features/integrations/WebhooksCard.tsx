import { useState } from 'react';
import { ExternalLink, MoreHorizontal, Pencil, Plus, RefreshCw, RotateCcw, Send, Trash2 } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CodeView,
  Drawer,
  EmptyState,
  Field,
  Input,
  Menu,
  Modal,
  StatusPill,
  Switch,
  Table,
  TableFrame,
  Tag,
  THead,
  Td,
  Th,
  Textarea,
  Tr,
  fieldErrors,
  timeAgo,
  useConfirm,
  useToast,
} from '../../ui';
import { ApiError, api, errText, type Out } from '../../app/api';
import { useApi } from '../../app/useApi';
import { useWorkspace } from '../../app/session';

type Endpoint = Out<'webhooks.list'>['endpoints'][number];
type Delivery = Out<'deliveries.list'>['deliveries'][number];

const DELIVERY_TONE: Record<Delivery['status'], 'neutral' | 'info' | 'good' | 'bad'> = {
  pending: 'neutral',
  running: 'info',
  done: 'good',
  failed: 'bad',
  dead: 'bad',
};
const DELIVERY_LABEL: Record<Delivery['status'], string> = {
  pending: 'Pending',
  running: 'Sending',
  done: 'Delivered',
  failed: 'Failed',
  dead: 'Gave up',
};
const RETRYABLE: Delivery['status'][] = ['failed', 'dead'];

const parseEvents = (text: string) =>
  text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

const payloadType = (payload: unknown) => {
  if (payload && typeof payload === 'object' && 'type' in payload) {
    const type = (payload as { type?: unknown }).type;
    if (typeof type === 'string') return type;
  }
  return '—';
};

type WebhookForm = { name: string; url: string; events: string; purpose: string };

function validateWebhook(f: WebhookForm): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.name.trim()) e.name = 'Give the endpoint a name.';
  if (!f.url.trim()) e.url = 'Enter the URL that receives the events.';
  else if (!/^https?:\/\/\S+$/.test(f.url.trim())) e.url = 'Use a full http:// or https:// URL.';
  const events = parseEvents(f.events);
  if (events.length > 100) e.events = 'Subscribe to 100 events at most.';
  else if (events.some((event) => event.length > 200)) e.events = 'Keep each event name to 200 characters or fewer.';
  if (f.purpose.length > 64) e.purpose = 'Keep the purpose to 64 characters or fewer.';
  return e;
}

function WebhookDrawer({ endpoint, onClose, onSaved }: { endpoint: Endpoint | null; onClose: () => void; onSaved: (created: { name: string; secret: string } | null) => void }) {
  const [f, setF] = useState<WebhookForm>(() => ({
    name: endpoint?.name ?? '',
    url: endpoint?.url ?? '',
    events: endpoint?.events.join(', ') ?? '',
    purpose: endpoint?.purpose ?? '',
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof WebhookForm>(key: K, value: WebhookForm[K]) => setF((cur) => ({ ...cur, [key]: value }));

  const save = async () => {
    const found = validateWebhook(f);
    setErrors(found);
    setError(null);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const input = {
        name: f.name.trim(),
        url: f.url.trim(),
        events: parseEvents(f.events),
        purpose: f.purpose.trim() ? f.purpose.trim() : null,
      };
      if (endpoint) {
        await api.call('webhooks.update', { id: endpoint.id, ...input });
        onSaved(null);
      } else {
        const created = await api.call('webhooks.create', {
          name: input.name,
          url: input.url,
          events: input.events,
          ...(input.purpose ? { purpose: input.purpose } : {}),
        });
        onSaved({ name: created.name, secret: created.secret });
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_input') {
        const found = fieldErrors(e.details);
        if (!Object.keys(found).length && /^The URL cannot be used/.test(e.message)) setErrors({ url: e.message });
        else setErrors(found);
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
      title={endpoint ? `Edit ${endpoint.name}` : 'Add endpoint'}
      meta={endpoint ? <span className="font-mono text-[12px]">{endpoint.id}</span> : 'Receive customer events and journey webhook steps.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="webhook-form" loading={saving}>
            {endpoint ? 'Save changes' : 'Add endpoint'}
          </Button>
        </>
      }
    >
      <form
        id="webhook-form"
        className="space-y-6 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" hint="How this endpoint appears in deliveries and journey steps." error={errors.name} required>
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus />
        </Field>
        <Field
          label="Endpoint URL"
          error={errors.url}
          hint="An http:// or https:// address on the public internet. Private and local addresses are refused."
          required
        >
          <Input type="url" value={f.url} placeholder="https://hooks.example.com/agentic-marketing" onChange={(e) => set('url', e.target.value)} />
        </Field>
        <Field
          label="Events"
          error={errors.events}
          hint="Event names separated by commas or new lines, for example identify, order.completed, or * for every event. Leave empty to receive only journey webhook steps."
        >
          <Textarea mono rows={3} value={f.events} placeholder="*" spellCheck={false} onChange={(e) => set('events', e.target.value)} />
        </Field>
        <Field
          label="Purpose"
          error={errors.purpose}
          hint="Optional. When set, only events from people who consented to this purpose are sent, for example analytics."
        >
          <Input value={f.purpose} onChange={(e) => set('purpose', e.target.value)} />
        </Field>

        <Alert tone="info" title="Signed requests">
          Each delivery is signed with the Standard Webhooks headers. {endpoint ? 'The signing secret stays the same.' : 'The signing secret is shown once after you add the endpoint.'}
        </Alert>

        {error && (
          <Alert tone="bad" title={endpoint ? 'Not saved' : 'Not added'}>
            {error}
          </Alert>
        )}
      </form>
    </Drawer>
  );
}

export function WebhooksCard() {
  const { can } = useWorkspace();
  const admin = can('workspace:admin');
  const list = useApi(() => api.call('webhooks.list', {}), []);
  const deliveries = useApi(() => api.call('deliveries.list', { limit: 100 }), []);
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [editing, setEditing] = useState<Endpoint | 'new' | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const endpoints = list.data?.endpoints ?? [];
  const allDeliveries = deliveries.data?.deliveries ?? [];
  const webhookDeliveries = allDeliveries.filter((d) => d.kind === 'webhook');
  const latest = new Map<string, Delivery>();
  for (const d of webhookDeliveries) if (!latest.has(d.targetId)) latest.set(d.targetId, d);
  const endpointName = (id: string) => endpoints.find((e) => e.id === id)?.name ?? id;

  const reloadDeliveriesSoon = () => {
    window.setTimeout(() => void deliveries.reload(), 1500);
  };

  const toggle = async (e: Endpoint) => {
    setBusy(e.id);
    try {
      await api.call('webhooks.update', { id: e.id, enabled: !e.enabled });
      toast.success(e.enabled ? `Paused “${e.name}”. Events are not sent until you enable it.` : `Enabled “${e.name}”. Events are sent again.`);
      await list.reload();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async (e: Endpoint) => {
    setBusy(e.id);
    try {
      await api.call('webhooks.test', { id: e.id });
      toast.success(`Queued a test delivery to “${e.name}”. Its result appears under Recent deliveries.`);
      reloadDeliveriesSoon();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (e: Endpoint) => {
    const ok = await confirm({
      title: `Delete “${e.name}”?`,
      body: <>Events stop being sent to this URL and deliveries still waiting are dropped. The signing secret is deleted. Journey webhook steps that point here will fail.</>,
      confirmLabel: 'Delete endpoint',
      destructive: true,
      typeToConfirm: e.name,
    });
    if (!ok) return;
    setBusy(e.id);
    try {
      await api.call('webhooks.delete', { id: e.id });
      toast.success(`Deleted “${e.name}”.`);
      await list.reload();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const retry = async (d: Delivery) => {
    setRetrying(d.id);
    try {
      await api.call('deliveries.retry', { id: d.id });
      toast.success(`Queued the delivery to “${endpointName(d.targetId)}” for another attempt.`);
      reloadDeliveriesSoon();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setRetrying(null);
    }
  };

  return (
    <div className="space-y-6">
      <Card
        title="Webhooks"
        description="Send customer events and journey webhook steps to an HTTPS endpoint, signed so the receiver can verify them."
        action={
          admin ? (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
              Add endpoint
            </Button>
          ) : undefined
        }
      >
        <TableFrame
          loading={list.loading}
          error={list.error ? errText(list.error) : null}
          onRetry={list.reload}
          isEmpty={endpoints.length === 0}
          columns={6}
          empty={
            <EmptyState
              icon={<Send size={20} />}
              title="No webhook endpoints yet"
              action={
                admin ? (
                  <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
                    Add endpoint
                  </Button>
                ) : undefined
              }
            >
              {admin
                ? 'Add an endpoint to send customer events and journey webhook steps to your own service, n8n or Zapier. Endpoints are signed with a secret you verify on the receiving side.'
                : 'No endpoints are configured. A workspace admin can add one.'}
            </EmptyState>
          }
        >
          <Table label="Webhook endpoints">
            <THead>
              <tr>
                <Th>Name</Th>
                <Th className="hidden lg:table-cell">URL</Th>
                <Th className="hidden md:table-cell">Events</Th>
                <Th>Last delivery</Th>
                <Th>Status</Th>
                {admin && <Th align="right">Actions</Th>}
              </tr>
            </THead>
            <tbody>
              {endpoints.map((e) => {
                const last = latest.get(e.id);
                return (
                  <Tr key={e.id}>
                    <Td>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-fg">{e.name}</span>
                        {e.purpose && <Tag>{e.purpose}</Tag>}
                      </div>
                      <div className="mt-0.5 max-w-[260px] truncate font-mono text-[11px] text-muted lg:hidden" title={e.url}>
                        {e.url}
                      </div>
                    </Td>
                    <Td className="hidden lg:table-cell">
                      <a
                        href={e.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex max-w-[260px] items-center gap-1 font-mono text-[12px] text-fg-2 hover:text-fg hover:underline"
                        title={e.url}
                      >
                        <span className="truncate">{e.url}</span>
                        <ExternalLink size={12} aria-hidden />
                      </a>
                    </Td>
                    <Td className="hidden md:table-cell">
                      <div className="max-w-[240px] truncate" title={e.events.join(', ')}>
                        {e.events.length ? e.events.join(', ') : <span className="text-muted">Journey steps only</span>}
                      </div>
                    </Td>
                    <Td>
                      {last ? (
                        <div className="flex flex-col gap-0.5">
                          <StatusPill tone={DELIVERY_TONE[last.status]}>{DELIVERY_LABEL[last.status]}</StatusPill>
                          <span className="text-[11px] text-muted">{timeAgo(last.createdAt)}</span>
                        </div>
                      ) : (
                        <span className="text-muted">Never</span>
                      )}
                    </Td>
                    <Td>
                      <StatusPill tone={e.enabled ? 'good' : 'neutral'}>{e.enabled ? 'Enabled' : 'Paused'}</StatusPill>
                    </Td>
                    {admin && (
                      <Td align="right">
                        <div className="flex items-center justify-end gap-2">
                          <Switch checked={e.enabled} onChange={() => void toggle(e)} label={`Enable ${e.name}`} hideLabel disabled={busy === e.id} />
                          <Button size="sm" icon={<Pencil size={14} />} onClick={() => setEditing(e)}>
                            Edit
                          </Button>
                          <Button size="sm" icon={<Send size={14} />} loading={busy === e.id} onClick={() => void sendTest(e)}>
                            Send test
                          </Button>
                          <Menu
                            label={`More for ${e.name}`}
                            trigger={(t) => (
                              <button
                                {...t}
                                type="button"
                                aria-label={`More for ${e.name}`}
                                className="inline-flex size-7 items-center justify-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg"
                              >
                                <MoreHorizontal size={16} />
                              </button>
                            )}
                            items={[{ label: 'Delete', icon: <Trash2 size={14} />, destructive: true, disabled: busy === e.id, onSelect: () => void remove(e) }]}
                          />
                        </div>
                      </Td>
                    )}
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableFrame>
      </Card>

      <Card
        title="Recent deliveries"
        description="The latest webhook deliveries, newest first. Failed deliveries retry with backoff; gave-up ones can be retried by hand."
        action={
          <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={deliveries.reload} loading={deliveries.refreshing}>
            Refresh
          </Button>
        }
      >
        <TableFrame
          loading={deliveries.loading}
          error={deliveries.error ? errText(deliveries.error) : null}
          onRetry={deliveries.reload}
          isEmpty={webhookDeliveries.length === 0}
          columns={6}
          empty={
            <EmptyState
              icon={<Send size={20} />}
              title="No deliveries yet"
              action={
                admin && endpoints.length > 0 ? (
                  <Button icon={<Send size={14} />} onClick={() => void sendTest(endpoints[0]!)}>
                    Send a test to “{endpoints[0]!.name}”
                  </Button>
                ) : undefined
              }
            >
              {endpoints.length ? 'Deliveries appear here after an event is sent. Send a test to check the endpoint and its signing secret.' : 'Add an endpoint first, then send a test to see a delivery here.'}
            </EmptyState>
          }
        >
          <Table label="Recent webhook deliveries">
            <THead>
              <tr>
                <Th>Status</Th>
                <Th>Event</Th>
                <Th className="hidden md:table-cell">Endpoint</Th>
                <Th>Attempts</Th>
                <Th className="hidden lg:table-cell">Response</Th>
                <Th>When</Th>
                {admin && <Th align="right">Actions</Th>}
              </tr>
            </THead>
            <tbody>
              {webhookDeliveries.map((d) => (
                <Tr key={d.id}>
                  <Td>
                    <StatusPill tone={DELIVERY_TONE[d.status]}>{DELIVERY_LABEL[d.status]}</StatusPill>
                  </Td>
                  <Td>
                    <span className="font-mono text-[12px]">{payloadType(d.payload)}</span>
                  </Td>
                  <Td className="hidden md:table-cell">
                    <div className="max-w-[200px] truncate">{endpointName(d.targetId)}</div>
                  </Td>
                  <Td>{d.attempts}</Td>
                  <Td className="hidden lg:table-cell">
                    <div className="font-mono text-[12px]">{d.statusCode ?? '—'}</div>
                    {d.error && (
                      <div className="max-w-[220px] truncate text-[11px] text-muted" title={d.error}>
                        {d.error}
                      </div>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap" title={d.createdAt}>
                    {timeAgo(d.createdAt)}
                  </Td>
                  {admin && (
                    <Td align="right">
                      {RETRYABLE.includes(d.status) && (
                        <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} loading={retrying === d.id} onClick={() => void retry(d)}>
                          Retry
                        </Button>
                      )}
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableFrame>
      </Card>

      {editing && (
        <WebhookDrawer
          key={editing === 'new' ? 'new' : editing.id}
          endpoint={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null);
            if (created) {
              setSecret({ name: created.name, value: created.secret });
              toast.success(`Added “${created.name}”. Copy the signing secret and store it with the receiver.`);
            } else {
              toast.success('Webhook endpoint saved.');
            }
            void list.reload();
          }}
        />
      )}

      <Modal
        open={!!secret}
        onClose={() => setSecret(null)}
        title={`Signing secret for “${secret?.name ?? ''}”`}
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            I've saved it
          </Button>
        }
      >
        <p className="mb-3">
          Verify the <span className="font-mono text-[12px]">webhook-signature</span> header with this secret. It is shown once and cannot be recovered. If it leaks,
          delete the endpoint and add it again to get a new one.
        </p>
        <CodeView value={secret?.value ?? ''} label="Signing secret" maxHeight={100} />
      </Modal>
      {confirmDialog}
    </div>
  );
}

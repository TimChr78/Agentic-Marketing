import { Bell, BellRing, Plus, Send, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errText, type In, type Out } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Drawer,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  StatusPill,
  Table,
  TableFrame,
  Tag,
  Td,
  Th,
  THead,
  Tr,
  useConfirm,
  useToast,
  formatDateTime,
} from '../../ui';
import { pageWidth } from '../../ui/layout';

type Rule = Out<'alerts.list'>['rules'][number];
type Event = Out<'alerts.history'>['events'][number];
type Kind = Rule['kind'];
type Channel = In<'alerts.create'>['channels'][number];

const KIND_LABEL: Record<Kind, string> = {
  deliverability: 'Deliverability',
  signup_drop: 'Signup drop',
  journey_errors: 'Journey errors',
};

const WINDOWS = ['PT1H', 'PT6H', 'PT24H', 'P3D', 'P7D'];

const windowText = (window: string) => {
  const hours = /^PT(\d+)H$/.exec(window);
  if (hours) return `${hours[1]} hour${hours[1] === '1' ? '' : 's'}`;
  const days = /^P(\d+)D$/.exec(window);
  if (days) return `${days[1]} day${days[1] === '1' ? '' : 's'}`;
  return window;
};

const pct = (value: number) => `${(value * 100).toFixed(value * 100 < 1 ? 2 : 1)}%`;
const num = (value: number) => value.toLocaleString();

function kindExplanation(kind: Kind): string {
  switch (kind) {
    case 'deliverability':
      return 'Watches bounce or spam-complaint rate over a window. It only fires after a minimum number of people were sent, so a tiny sample cannot trigger it.';
    case 'signup_drop':
      return 'Compares confirmed signups in the window with the window before it. It fires when the new window falls below a percentage of the old one and the old one had enough signups to compare.';
    case 'journey_errors':
      return 'Counts failed journey steps (an error while advancing a participant) over a window, for one journey or all of them, and fires above the count.';
  }
}

function ruleSummary(rule: Rule, journeyName?: string): string {
  const config = rule.config as Record<string, unknown>;
  const window = windowText(String(config.window ?? 'PT24H'));
  if (rule.kind === 'deliverability') {
    const metric = config.metric === 'complaint' ? 'Complaint rate' : 'Bounce rate';
    return `${metric} above ${pct(Number(config.threshold ?? 0))} over ${window}, after at least ${num(Number(config.minSent ?? 100))} sent.`;
  }
  if (rule.kind === 'signup_drop') {
    return `Confirmed signups below ${num(Number(config.dropPercent ?? 50))}% of the previous ${window}, when the previous window had at least ${num(Number(config.minPrevious ?? 10))}.`;
  }
  const journey = config.journeyId ? (journeyName ?? String(config.journeyId)) : 'all journeys';
  return `More than ${num(Number(config.threshold ?? 5))} failed steps over ${window} for ${journey}.`;
}

interface FormState {
  name: string;
  kind: Kind;
  enabled: boolean;
  metric: 'bounce' | 'complaint';
  deliverabilityWindow: string;
  thresholdPercent: string;
  minSent: string;
  signupWindow: string;
  dropPercent: string;
  minPrevious: string;
  errorWindow: string;
  errorThreshold: string;
  journeyId: string;
  webhookIds: string[];
  userIds: string[];
}

function formFor(rule: Rule | null): FormState {
  const config = (rule?.config ?? {}) as Record<string, unknown>;
  const channels = rule?.channels ?? [];
  return {
    name: rule?.name ?? '',
    kind: rule?.kind ?? 'deliverability',
    enabled: rule?.enabled ?? true,
    metric: config.metric === 'complaint' ? 'complaint' : 'bounce',
    deliverabilityWindow: String(config.window ?? 'PT24H'),
    thresholdPercent: rule?.kind === 'deliverability' ? String((Number(config.threshold ?? 0.05) * 100).toFixed(3)).replace(/\.?0+$/, '') : '5',
    minSent: String(config.minSent ?? 100),
    signupWindow: rule?.kind === 'signup_drop' ? String(config.window ?? 'PT24H') : 'PT24H',
    dropPercent: String(config.dropPercent ?? 50),
    minPrevious: String(config.minPrevious ?? 10),
    errorWindow: rule?.kind === 'journey_errors' ? String(config.window ?? 'PT1H') : 'PT1H',
    errorThreshold: String(config.threshold ?? 5),
    journeyId: String(config.journeyId ?? ''),
    webhookIds: channels.flatMap((c) => (c.type === 'webhook' ? [c.webhookId] : [])),
    userIds: channels.flatMap((c) => (c.type === 'email' ? c.userIds : [])),
  };
}

/** Settings → Alerts: threshold rules over the metric layer, their firing state and history. */
export default function AlertsPage() {
  useCrumbs([{ label: 'Alerts' }]);
  const { can } = useSession();
  const admin = can('workspace:admin');
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [historyRule, setHistoryRule] = useState<Rule | null>(null);

  const rules = useApi(() => api.call('alerts.list', {}), []);
  const endpoints = useApi(() => api.call('webhooks.list', {}), []);
  const members = useApi(() => api.call('members.list', {}), [], { skip: !admin });
  const journeys = useApi(() => api.call('artifacts.list', { type: 'journey' as never, limit: 200 }), []);
  const history = useApi(() => api.call('alerts.history', { limit: 50 }), [rules.data]);
  const ruleHistory = useApi(
    () => api.call('alerts.history', { ruleId: historyRule?.id, limit: 200 }),
    [historyRule?.id],
    { skip: !historyRule },
  );

  const journeyName = (id: string) => journeys.data?.artifacts.find((a) => a.id === id)?.name ?? id;
  const endpointName = (id: string) => endpoints.data?.endpoints.find((e) => e.id === id)?.name ?? id;
  const memberName = (id: string) => members.data?.members.find((m) => m.userId === id)?.email ?? id;

  const channelsText = (rule: Rule) => {
    const names = rule.channels.flatMap((channel) =>
      channel.type === 'webhook'
        ? [`Webhook ${endpointName(channel.webhookId)}`]
        : channel.userIds.map((id) => `E-mail ${memberName(id)}`),
    );
    return names.length ? names.join(' · ') : 'No channels';
  };

  const reload = () => {
    void rules.reload();
    void history.reload();
  };

  const remove = async (rule: Rule) => {
    const ok = await confirm({
      title: `Delete “${rule.name}”?`,
      body: 'The rule and its firing history are removed. Notifications already queued are still delivered.',
      confirmLabel: 'Delete rule',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.call('alerts.delete', { id: rule.id });
      toast.success(`Deleted “${rule.name}”.`);
      if (historyRule?.id === rule.id) setHistoryRule(null);
      reload();
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const test = async (rule: Rule) => {
    try {
      const result = await api.call('alerts.test', { id: rule.id });
      const failed = result.notifications.filter((n) => n.status === 'failed');
      if (failed.length) toast.info(`Test sent to ${result.notifications.length - failed.length} of ${result.notifications.length} channels.`);
      else toast.success(`Test notification sent to ${result.notifications.length} channel${result.notifications.length === 1 ? '' : 's'}.`);
      reload();
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const rows = rules.data?.rules ?? [];
  const valueText = (ruleId: string, value: number) => {
    const kind = rows.find((r) => r.id === ruleId)?.kind;
    return kind === 'deliverability' ? pct(value) : num(value);
  };

  return (
    <div className={pageWidth('default')}>
      {confirmDialog}
      <PageHeader
        title="Alerts"
        description="Tell a webhook or the team when deliverability, signups or journey errors move outside their expected range. Rules read the same metric layer as Analytics; the scheduler checks them every five minutes."
        actions={
          admin && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus size={15} /> New alert
            </Button>
          )
        }
      />

      {rules.loading ? (
        <LoadingBlock lines={4} label="Loading alert rules" />
      ) : rules.error ? (
        <Alert tone="bad" title="Couldn't load alert rules" onRetry={rules.reload}>
          {rules.error}
        </Alert>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState
            icon={<Bell size={20} />}
            title="No alert rules yet"
            action={
              admin && (
                <Button variant="primary" onClick={() => setEditing('new')}>
                  Create the first alert
                </Button>
              )
            }
          >
            A useful first rule watches bounce rate over a day, or tells you when confirmed signups drop by half from the day before.
          </EmptyState>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((rule) => (
            <Card
              key={rule.id}
              title={
                <span className="flex items-center gap-2">
                  {rule.name}
                  <Tag>{KIND_LABEL[rule.kind]}</Tag>
                  {!rule.enabled && <Tag>Paused</Tag>}
                </span>
              }
              description={ruleSummary(rule, rule.config.journeyId ? journeyName(String(rule.config.journeyId)) : undefined)}
              action={
                <StatusPill tone={rule.state === 'firing' ? 'bad' : 'good'} dot>
                  {rule.state === 'firing' ? `Firing since ${formatDateTime(rule.firingSince)}` : 'OK'}
                </StatusPill>
              }
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-2.5 text-[12px] text-muted">
                <span className="inline-flex items-center gap-1.5">
                  {rule.state === 'firing' ? <BellRing size={13} /> : <Bell size={13} />}
                  {channelsText(rule)}
                </span>
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setHistoryRule(rule)}>
                    History
                  </Button>
                  {admin && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => void test(rule)}>
                        <Send size={13} /> Send a test
                      </Button>
                      <Button size="sm" onClick={() => setEditing(rule)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void remove(rule)} aria-label={`Delete ${rule.name}`}>
                        <Trash2 size={13} />
                      </Button>
                    </>
                  )}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}

      <section aria-labelledby="alert-history" className="mt-6">
        <h2 id="alert-history" className="mb-2 text-[14px] font-semibold">
          Recent history
        </h2>
        {history.loading ? (
          <LoadingBlock lines={3} label="Loading alert history" />
        ) : history.error ? (
          <Alert tone="bad" title="Couldn't load alert history" onRetry={history.reload}>
            {history.error}
          </Alert>
        ) : (history.data?.events.length ?? 0) === 0 ? (
          <div className="rounded-lg border border-line bg-surface">
            <EmptyState title="Nothing has fired yet">When a rule starts firing and when it recovers, the episode is recorded here.</EmptyState>
          </div>
        ) : (
          <TableFrame>
            <Table label="Alert history">
              <THead>
                <Tr>
                  <Th>When</Th>
                  <Th>Rule</Th>
                  <Th>State</Th>
                  <Th align="right">Value</Th>
                  <Th align="right">Threshold</Th>
                  <Th>Window</Th>
                </Tr>
              </THead>
              <tbody>
                {history.data?.events.map((event: Event) => (
                  <Tr key={event.id}>
                    <Td>{formatDateTime(event.firedAt)}</Td>
                    <Td>{event.ruleName}</Td>
                    <Td>
                      <StatusPill tone={event.state === 'resolved' ? 'good' : 'bad'}>
                        {event.state === 'resolved' ? `Resolved ${formatDateTime(event.resolvedAt)}` : 'Firing'}
                      </StatusPill>
                    </Td>
                    <Td align="right">{valueText(event.ruleId, event.value)}</Td>
                    <Td align="right">{valueText(event.ruleId, event.threshold)}</Td>
                    <Td>{windowText(event.window)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableFrame>
        )}
      </section>

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' || editing === null ? 'New alert rule' : `Edit ${editing.name}`}
        meta="Rules are evaluated by the scheduler and notify only when a state changes."
        width="lg"
      >
        {editing !== null && (
          <AlertForm
            rule={editing === 'new' ? null : editing}
            endpoints={endpoints.data?.endpoints ?? []}
            members={members.data?.members ?? []}
            journeys={journeys.data?.artifacts ?? []}
            onSaved={() => {
              setEditing(null);
              reload();
            }}
            onCancel={() => setEditing(null)}
            onError={(message) => toast.error(message)}
          />
        )}
      </Drawer>

      <Drawer
        open={historyRule !== null}
        onClose={() => setHistoryRule(null)}
        title={historyRule ? `History · ${historyRule.name}` : 'History'}
        width="lg"
      >
        {ruleHistory.loading ? (
          <div className="p-5">
            <LoadingBlock lines={4} label="Loading history" />
          </div>
        ) : (ruleHistory.data?.events.length ?? 0) === 0 ? (
          <div className="p-5">
            <EmptyState title="No episodes yet">This rule has not fired since it was created.</EmptyState>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {ruleHistory.data?.events.map((event: Event) => (
              <div key={event.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <StatusPill tone={event.state === 'resolved' ? 'good' : 'bad'}>{event.state === 'resolved' ? 'Resolved' : 'Firing'}</StatusPill>
                  <span className="text-muted">
                    {formatDateTime(event.firedAt)}
                    {event.resolvedAt ? ` → ${formatDateTime(event.resolvedAt)}` : ''}
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-muted">
                  Value {historyRule?.kind === 'deliverability' ? pct(event.value) : num(event.value)} · threshold{' '}
                  {historyRule?.kind === 'deliverability' ? pct(event.threshold) : num(event.threshold)} · {windowText(event.window)}
                </p>
                <p className="mt-0.5 text-[12px] text-muted">
                  {event.notified.length
                    ? event.notified
                        .map((n) => `${String(n.channel)} ${String(n.target)}: ${String(n.status)}`)
                        .join(' · ')
                    : 'No notification recorded.'}
                </p>
              </div>
            ))}
          </div>
        )}
      </Drawer>
    </div>
  );
}

function AlertForm({
  rule,
  endpoints,
  members,
  journeys,
  onSaved,
  onCancel,
  onError,
}: {
  rule: Rule | null;
  endpoints: Out<'webhooks.list'>['endpoints'];
  members: Out<'members.list'>['members'];
  journeys: Out<'artifacts.list'>['artifacts'];
  onSaved: () => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState<FormState>(() => formFor(rule));
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(formFor(rule)), [rule]);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const toggle = (key: 'webhookIds' | 'userIds', id: string) =>
    setForm((f) => ({ ...f, [key]: f[key].includes(id) ? f[key].filter((x) => x !== id) : [...f[key], id] }));

  const kind = form.kind;
  const config =
    kind === 'deliverability'
      ? { metric: form.metric, window: form.deliverabilityWindow, threshold: Number(form.thresholdPercent) / 100, minSent: Number(form.minSent) }
      : kind === 'signup_drop'
        ? { window: form.signupWindow, dropPercent: Number(form.dropPercent), minPrevious: Number(form.minPrevious) }
        : {
            window: form.errorWindow,
            threshold: Number(form.errorThreshold),
            ...(form.journeyId ? { journeyId: form.journeyId } : {}),
          };

  const channels: Channel[] = [
    ...form.webhookIds.map((webhookId) => ({ type: 'webhook' as const, webhookId })),
    ...(form.userIds.length ? [{ type: 'email' as const, userIds: form.userIds }] : []),
  ];

  const save = async () => {
    if (!form.name.trim()) return onError('Give the rule a name.');
    if (!channels.length) return onError('Pick at least one webhook or person to notify.');
    setBusy(true);
    try {
      if (rule) await api.call('alerts.update', { id: rule.id, name: form.name.trim(), config, channels, enabled: form.enabled });
      else await api.call('alerts.create', { name: form.name.trim(), kind, config, channels, enabled: form.enabled });
      onSaved();
    } catch (e) {
      onError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5 px-5 py-4">
      <Field label="Name" hint="What people see in the notification and history.">
        <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Bounce rate is high" />
      </Field>

      <Field label="Kind" hint={kindExplanation(kind)}>
        <Select value={kind} onChange={(e) => set('kind', e.target.value as Kind)} disabled={!!rule}>
          <option value="deliverability">Deliverability</option>
          <option value="signup_drop">Signup drop</option>
          <option value="journey_errors">Journey errors</option>
        </Select>
      </Field>

      {kind === 'deliverability' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Measure">
            <Select value={form.metric} onChange={(e) => set('metric', e.target.value as 'bounce' | 'complaint')}>
              <option value="bounce">Bounce rate</option>
              <option value="complaint">Complaint rate</option>
            </Select>
          </Field>
          <Field label="Window">
            <Select value={form.deliverabilityWindow} onChange={(e) => set('deliverabilityWindow', e.target.value)}>
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {windowText(w)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Threshold" unit="%" hint="Fires above this rate. Default 5% bounce, 0.1% complaint.">
            <Input type="number" min="0.001" max="100" step="0.001" value={form.thresholdPercent} onChange={(e) => set('thresholdPercent', e.target.value)} />
          </Field>
          <Field label="Minimum sent" hint="Do not fire until at least this many people were sent in the window.">
            <Input type="number" min="1" step="1" value={form.minSent} onChange={(e) => set('minSent', e.target.value)} />
          </Field>
        </div>
      )}

      {kind === 'signup_drop' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Window">
            <Select value={form.signupWindow} onChange={(e) => set('signupWindow', e.target.value)}>
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {windowText(w)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Drop threshold" unit="%" hint="Fires when the new window is below this share of the previous one.">
            <Input type="number" min="1" max="100" step="1" value={form.dropPercent} onChange={(e) => set('dropPercent', e.target.value)} />
          </Field>
          <Field label="Minimum previous signups" hint="The previous window must have at least this many confirmed signups.">
            <Input type="number" min="1" step="1" value={form.minPrevious} onChange={(e) => set('minPrevious', e.target.value)} />
          </Field>
        </div>
      )}

      {kind === 'journey_errors' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Window">
            <Select value={form.errorWindow} onChange={(e) => set('errorWindow', e.target.value)}>
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {windowText(w)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Failures above" hint="Fires when more than this many steps fail in the window.">
            <Input type="number" min="1" step="1" value={form.errorThreshold} onChange={(e) => set('errorThreshold', e.target.value)} />
          </Field>
          <Field label="Journey" hint="Leave empty to watch every journey in the workspace." className="sm:col-span-2">
            <Select value={form.journeyId} onChange={(e) => set('journeyId', e.target.value)}>
              <option value="">All journeys</option>
              {journeys.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      <div className="rounded-md border border-line p-3">
        <div className="text-[13px] font-semibold">Notify</div>
        <p className="mb-1 text-[12px] text-muted">Webhooks use the existing signed delivery, retry and egress rules.</p>
        {endpoints.length ? (
          <div className="space-y-1.5">
            {endpoints.map((endpoint) => (
              <Checkbox
                key={endpoint.id}
                label={endpoint.name}
                hint={endpoint.url}
                checked={form.webhookIds.includes(endpoint.id)}
                onChange={() => toggle('webhookIds', endpoint.id)}
              />
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-muted">No webhook endpoints yet. Add one under Settings → Integrations.</p>
        )}
        <div className="mt-3 text-[13px] font-semibold">E-mail workspace members</div>
        <p className="mb-1 text-[12px] text-muted">A short transactional message with the metric and a link; aggregates only.</p>
        {members.length ? (
          <div className="space-y-1.5">
            {members.map((member) => (
              <Checkbox
                key={member.userId}
                label={member.name || member.email}
                hint={member.email}
                checked={form.userIds.includes(member.userId)}
                onChange={() => toggle('userIds', member.userId)}
              />
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-muted">Only workspace admins can pick members here.</p>
        )}
      </div>

      <Checkbox label="Enabled" hint="Paused rules keep their history but are not evaluated." checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          {rule ? 'Save changes' : 'Create rule'}
        </Button>
      </div>
    </div>
  );
}

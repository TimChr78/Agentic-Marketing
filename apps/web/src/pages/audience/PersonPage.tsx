import { Download, UserX } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api, errText } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { Link, navigate } from '../../app/router';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { ConsentHistoryTable } from '../../features/audience/consent';
import { personLabel, visibleEmail } from '../../features/audience/profile';
import {
  Alert,
  Button,
  EmptyState,
  Field,
  formatDateTime,
  Input,
  LoadingBlock,
  Meta,
  Mono,
  PageHeader,
  StatusPill,
  Table,
  TableFrame,
  Tabs,
  Tag,
  Td,
  THead,
  Th,
  Tr,
  timeAgo,
  useConfirm,
  useToast,
} from '../../ui';
import { pageWidth } from '../../ui/layout';

type Tab = 'overview' | 'consent' | 'events' | 'segments' | 'messages';

const messageTone = {
  queued: 'neutral',
  sending: 'neutral',
  sent: 'info',
  delivered: 'good',
  suppressed: 'warn',
  failed: 'bad',
  bounced: 'bad',
  complained: 'bad',
} as const;

function valueText(v: unknown): ReactNode {
  if (v === '[hidden]') return <span className="text-muted">Hidden</span>;
  if (v === null || v === undefined) return <span className="text-muted">—</span>;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** One person: traits, the append-only consent ledger, events, segments and messages. */
export default function PersonPage({ params }: { params: Record<string, string> }) {
  const id = params.id ?? '';
  const { can } = useSession();
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [tab, setTab] = useState<Tab>('overview');
  const [reason, setReason] = useState('Erasure request');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'export' | 'erase' | null>(null);

  const profile = useApi(() => api.call('profiles.get', { profileId: id }), [id]);
  const p = profile.data;
  const resolvedId = p?.id ?? id;
  const events = useApi(() => api.call('profiles.events', { profileId: resolvedId, limit: 100 }), [resolvedId]);
  const consent = useApi(() => api.call('consent.history', { profileId: resolvedId }), [resolvedId]);
  const topics = useApi(() => api.call('topics.preferences', { profileId: resolvedId }), [resolvedId]);
  const segments = useApi(() => api.call('segments.ofProfile', { profileId: resolvedId }), [resolvedId]);
  const messages = useApi(() => api.call('messages.list', { profileId: resolvedId, limit: 50 }), [resolvedId]);

  const email = visibleEmail(p);
  useCrumbs([{ label: 'People', to: '/audience/people' }, { label: personLabel(p, id) }]);

  const exportPerson = async () => {
    if (!p) return;
    setBusy('export');
    setActionError(null);
    try {
      const data = await api.call('profiles.export', { profileId: p.id });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `${p.id}.json` });
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported everything held about ${personLabel(p, p.id)}.`);
    } catch (e) {
      setActionError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const erasePerson = async () => {
    if (!p) return;
    const typed = visibleEmail(p) ?? p.id;
    const ok = await confirm({
      title: 'Erase this person?',
      body: (
        <>
          <p>
            This permanently removes <strong>{typed}</strong>, their merged profiles, identifiers, consent ledger and events. It cannot be
            undone.
          </p>
          <p className="mt-2">
            Hashes of their e-mail and phone stay on the suppression list so they are never contacted again. Their encryption key is
            destroyed, so copies in backups become unreadable.
          </p>
          <Field label="Reason" hint="Kept in the erasure record." required className="mt-3">
            <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </>
      ),
      confirmLabel: 'Erase person',
      destructive: true,
      typeToConfirm: typed,
    });
    if (!ok) return;
    setBusy('erase');
    setActionError(null);
    try {
      await api.call('profiles.erase', { profileId: p.id, reason: reason.trim() || 'Erasure request' });
      toast.success(`Erased ${personLabel(p, p.id)}. Their e-mail and phone stay suppressed.`);
      navigate('/audience/people', { replace: true });
    } catch (e) {
      setActionError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  if (profile.loading) return <LoadingBlock lines={8} label="Loading person" />;
  if (profile.error || !p) {
    return (
      <div className={pageWidth('default')}>
        <PageHeader title="Person" description="One person’s profile, consent and activity." />
        <Alert tone="bad" title="Couldn’t open this person" onRetry={profile.reload}>
          {profile.error}
        </Alert>
      </div>
    );
  }

  const consentRecords = consent.data?.records ?? [];
  const topicRows = topics.data?.topics ?? [];
  const eventRows = events.data?.events ?? [];
  const segmentRows = segments.data?.segments ?? [];
  const messageRows = messages.data?.messages ?? [];
  const personal = Object.entries(p.personal);
  const hidden = !can('profiles:pii') && personal.some(([, v]) => v === '[hidden]');

  const overviewMeta: [ReactNode, ReactNode][] = [
    [
      'Profile id',
      <Mono key="id" className="break-all">
        {p.id}
      </Mono>,
    ],
    ...personal.map(([k, v]): [ReactNode, ReactNode] => [
      <span key={`k-${k}`} className="flex items-center gap-1.5">
        {k}
        <Tag>Personal</Tag>
      </span>,
      <span key={`v-${k}`}>{valueText(v)}</span>,
    ]),
    ...Object.entries(p.traits).map(([k, v]): [ReactNode, ReactNode] => [k, valueText(v)]),
    [
      'First seen',
      <span key="first" title={formatDateTime(p.firstSeen)}>
        {formatDateTime(p.firstSeen)}
      </span>,
    ],
    [
      'Last seen',
      <span key="last" title={formatDateTime(p.lastSeen)}>
        {timeAgo(p.lastSeen)}
      </span>,
    ],
    [
      'Merged',
      p.mergedFrom.length ? (
        <span key="merged">
          {p.mergedFrom.length} earlier {p.mergedFrom.length === 1 ? 'profile' : 'profiles'} merged into this one
        </span>
      ) : (
        <span key="merged" className="text-muted">
          No merged profiles
        </span>
      ),
    ],
  ];

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title={personLabel(p, p.id)}
        description={email ? `Person ${p.id}` : 'Personal data is hidden for your role; you can still see traits and consent.'}
        actions={
          <>
            {can('profiles:pii') && (
              <Button icon={<Download size={15} />} loading={busy === 'export'} onClick={exportPerson}>
                Export data
              </Button>
            )}
            {can('profiles:erase') && (
              <Button variant="danger" icon={<UserX size={15} />} loading={busy === 'erase'} onClick={erasePerson}>
                Erase person
              </Button>
            )}
          </>
        }
      />

      {actionError && (
        <Alert tone="bad" className="mb-4">
          {actionError}
        </Alert>
      )}
      {hidden && (
        <Alert tone="info" className="mb-4">
          Personal data is hidden. Your role needs <Mono>profiles:pii</Mono> to see e-mail addresses and other personal traits, and to
          export them.
        </Alert>
      )}

      <Tabs
        label="Person sections"
        value={tab}
        onChange={setTab}
        items={[
          { key: 'overview', label: 'Overview' },
          { key: 'consent', label: 'Consent', count: consentRecords.length },
          { key: 'events', label: 'Events', count: eventRows.length },
          { key: 'segments', label: 'Segments', count: segmentRows.length },
          { key: 'messages', label: 'Messages', count: messageRows.length },
        ]}
      />

      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-line bg-surface p-4">
            <Meta items={overviewMeta} />
          </div>
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="mb-2 text-[14px] font-semibold">Identifiers</h2>
            {p.identifiers.length ? (
              <div className="flex flex-wrap gap-1.5">
                {p.identifiers.map((i) => (
                  <Tag key={`${i.type}:${i.value}`}>
                    {i.type}: <Mono className="ml-1 bg-transparent px-0">{i.value}</Mono>
                  </Tag>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-muted">No identifiers on this profile.</p>
            )}
          </div>
        </div>
      )}

      {tab === 'consent' && (
        <div className="space-y-4">
          {topicRows.length > 0 && (
            <div className="rounded-lg border border-line bg-surface p-4">
              <h2 className="mb-1 text-[14px] font-semibold">Topic preferences</h2>
              <p className="mb-3 text-[12px] text-muted">
                Finer choices within a purpose. A topic never replaces the purpose’s consent; when the person made no choice, the topic’s
                default applies.
              </p>
              <Table label="Topic preferences">
                <THead>
                  <tr>
                    <Th>Purpose</Th>
                    <Th>Topic</Th>
                    <Th>Choice</Th>
                    <Th>Since</Th>
                    <Th>Source</Th>
                  </tr>
                </THead>
                <tbody>
                  {topicRows.map((t) => (
                    <Tr key={`${t.purpose}:${t.topic}`}>
                      <Td className="font-medium text-fg">{t.purposeName}</Td>
                      <Td>
                        {t.name} <span className="text-muted">({t.topic})</span>
                      </Td>
                      <Td>
                        <StatusPill tone={t.status === 'subscribed' ? 'good' : 'warn'}>{t.status}</StatusPill>
                        {!t.source && <span className="ml-1.5 text-[12px] text-muted">default</span>}
                      </Td>
                      <Td className="whitespace-nowrap" title={t.updatedAt ? formatDateTime(t.updatedAt) : undefined}>
                        {t.updatedAt ? timeAgo(t.updatedAt) : <span className="text-muted">—</span>}
                      </Td>
                      <Td>{t.source ? t.source.replace(/_/g, ' ') : <span className="text-muted">Default</span>}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          <TableFrame
            loading={consent.loading}
            error={consent.error}
            onRetry={consent.reload}
            columns={5}
            isEmpty={consentRecords.length === 0}
            empty={<EmptyState compact title="No consent choices recorded" />}
          >
            <p className="border-b border-line px-4 py-2 text-[12px] text-muted">
              The consent ledger is append-only. Each row adds a record; the latest per purpose and channel is the current choice.
            </p>
            <ConsentHistoryTable records={consentRecords} />
          </TableFrame>
        </div>
      )}

      {tab === 'events' && (
        <TableFrame
          loading={events.loading}
          error={events.error}
          onRetry={events.reload}
          columns={4}
          isEmpty={eventRows.length === 0}
          empty={
            <EmptyState compact title="No events yet">
              Events arrive from your website, integrations and journeys.
            </EmptyState>
          }
        >
          <Table label="Events">
            <THead>
              <tr>
                <Th>When</Th>
                <Th>Event</Th>
                <Th className="hidden md:table-cell">Type</Th>
                <Th className="hidden lg:table-cell">Properties</Th>
              </tr>
            </THead>
            <tbody>
              {eventRows.map((e) => (
                <Tr key={e.eventId}>
                  <Td className="whitespace-nowrap" title={formatDateTime(e.timestamp)}>
                    {formatDateTime(e.timestamp)}
                  </Td>
                  <Td className="font-medium text-fg">{e.name}</Td>
                  <Td className="hidden md:table-cell">{e.type}</Td>
                  <Td className="hidden max-w-[420px] lg:table-cell">
                    <span className="line-clamp-2 font-mono text-[11px] text-muted">{JSON.stringify(e.properties)}</span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableFrame>
      )}

      {tab === 'segments' && (
        <TableFrame
          loading={segments.loading}
          error={segments.error}
          onRetry={segments.reload}
          columns={2}
          isEmpty={segmentRows.length === 0}
          empty={
            <EmptyState compact title="Not in any segment yet">
              Segments fill as the person matches their rules.
            </EmptyState>
          }
        >
          <Table label="Segments">
            <THead>
              <tr>
                <Th>Segment</Th>
                <Th>Member since</Th>
              </tr>
            </THead>
            <tbody>
              {segmentRows.map((s) => (
                <Tr key={s.id}>
                  <Td>
                    <Link to={`/build/segments/${s.id}`} className="font-medium text-fg hover:underline">
                      {s.name}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap" title={formatDateTime(s.since)}>
                    {timeAgo(s.since)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableFrame>
      )}

      {tab === 'messages' && (
        <TableFrame
          loading={messages.loading}
          error={messages.error}
          onRetry={messages.reload}
          columns={4}
          isEmpty={messageRows.length === 0}
          empty={
            <EmptyState compact title="No messages to this person">
              Sends from journeys and broadcasts appear here with what happened to them.
            </EmptyState>
          }
        >
          <Table label="Messages">
            <THead>
              <tr>
                <Th>Status</Th>
                <Th>Channel</Th>
                <Th className="hidden md:table-cell">Purpose</Th>
                <Th>What happened</Th>
                <Th>When</Th>
              </tr>
            </THead>
            <tbody>
              {messageRows.map((m) => {
                const last = m.events[m.events.length - 1];
                return (
                  <Tr key={m.id}>
                    <Td>
                      <StatusPill tone={messageTone[m.status] ?? 'neutral'}>{m.status}</StatusPill>
                    </Td>
                    <Td>{m.channel}</Td>
                    <Td className="hidden md:table-cell">{m.purpose.replace(/_/g, ' ')}</Td>
                    <Td className="max-w-[320px]">
                      {m.reason ? (
                        <span className="line-clamp-2">{m.reason}</span>
                      ) : last ? (
                        <span className="line-clamp-2">
                          {last.type}
                          {last.reason ? ` · ${last.reason}` : ''}
                        </span>
                      ) : (
                        <span className="text-muted">No delivery events yet</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap" title={formatDateTime(m.createdAt)}>
                      {timeAgo(m.createdAt)}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableFrame>
      )}

      {confirmDialog}
    </div>
  );
}

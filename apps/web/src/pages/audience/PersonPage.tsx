import { Download, RefreshCw, UserX } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api, errText } from '../../app/api';
import { ButtonLink } from '../../app/links';
import { useCrumbs } from '../../app/page';
import { Link, navigate } from '../../app/router';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { ConsentHistoryTable } from '../../features/audience/consent';
import { CopyPersonId } from '../../features/audience/phase26/CopyControl';
import { basisLabel, consentLabel, type PersonProfile, personIdentity, purposeRows } from '../../features/audience/phase26/model';
import { ProfileTimeline } from '../../features/audience/phase26/ProfileTimeline';
import { PurposeConsentList } from '../../features/audience/phase26/PurposeConsent';
import { usePerson, useProfileTimeline } from '../../features/audience/phase26/peopleData';
import { usePurposes } from '../../features/audience/phase26/usePurposes';
import {
  Alert,
  Button,
  Card,
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

type Tab = 'timeline' | 'overview' | 'consent' | 'topics' | 'segments';

function valueText(v: unknown): ReactNode {
  if (v === '[hidden]') return <span className="text-muted">Hidden</span>;
  if (v === null || v === undefined) return <span className="text-muted">—</span>;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function IdentityFacts({ profile, email, name }: { profile: PersonProfile; email: string; name: string | null }) {
  return (
    <Meta
      items={[
        [
          'Email',
          <span key="email" className="break-all">
            {email}
          </span>,
        ],
        [
          'Name',
          name ?? (
            <span key="name" className="text-muted">
              Name hidden
            </span>
          ),
        ],
        ['Person id', <CopyPersonId key="id" id={profile.id} />],
        [
          'First seen',
          <span key="first" title={formatDateTime(profile.firstSeen)}>
            {formatDateTime(profile.firstSeen)}
          </span>,
        ],
        [
          'Last seen',
          <span key="last" title={formatDateTime(profile.lastSeen)}>
            {timeAgo(profile.lastSeen)}
          </span>,
        ],
        [
          'Merged',
          profile.mergedFrom.length ? (
            <span key="merged">
              {profile.mergedFrom.length} earlier {profile.mergedFrom.length === 1 ? 'profile' : 'profiles'} merged into this one
            </span>
          ) : (
            <span key="merged" className="text-muted">
              No merged profiles
            </span>
          ),
        ],
      ]}
    />
  );
}

/** One person: identity, consent per purpose, and the loaded history across three sources. */
export default function PersonPage({ params }: { params: Record<string, string> }) {
  const id = params.id ?? '';
  const { can } = useSession();
  const toast = useToast();
  const [confirmDialog, confirm] = useConfirm();
  const [tab, setTab] = useState<Tab>('timeline');
  const [reason, setReason] = useState('Erasure request');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'export' | 'erase' | null>(null);
  const canRead = can('profiles:read');
  const canSeePii = can('profiles:pii');

  const profile = usePerson(id, canRead);
  const p = profile.data;
  const timeline = useProfileTimeline(canRead ? p?.id : undefined, canRead && Boolean(p));
  const purposes = usePurposes({ enabled: canRead && can('artifacts:read') && Boolean(p) });

  const resolvedId = p?.id ?? id;
  const topics = useApi(() => api.call('topics.preferences', { profileId: resolvedId }), [resolvedId], {
    skip: !canRead || tab !== 'topics',
  });
  const segments = useApi(() => api.call('segments.ofProfile', { profileId: resolvedId }), [resolvedId], {
    skip: !canRead || tab !== 'segments',
  });

  const identity = p ? personIdentity(p, canSeePii) : null;
  useCrumbs([{ label: 'People', to: '/audience/people' }, { label: identity?.name ?? identity?.email ?? 'Person' }]);

  if (!canRead) {
    return (
      <div className={pageWidth('default')}>
        <EmptyState title="Restricted by your role">No protected reads were made. Ask a workspace administrator for access.</EmptyState>
      </div>
    );
  }

  if (profile.loading)
    return (
      <div aria-busy="true">
        <LoadingBlock lines={8} label="Loading person" />
      </div>
    );

  if (profile.notFound) {
    return (
      <div className={pageWidth('default')}>
        <PageHeader title="Person" description="One person’s identity, consent and loaded history." />
        <Alert tone="info" title="This person is not available at this address">
          The profile may have been erased, merged into another person, or the link may be wrong.
        </Alert>
        <div className="mt-4">
          <ButtonLink to="/audience/people">Back to people</ButtonLink>
        </div>
      </div>
    );
  }

  if (profile.error || !p || !identity) {
    return (
      <div className={pageWidth('default')}>
        <PageHeader title="Person" description="One person’s identity, consent and loaded history." />
        <Alert tone="bad" title="Couldn’t open this person" onRetry={() => void profile.reload()}>
          {profile.error ?? 'The profile could not be loaded.'}
        </Alert>
      </div>
    );
  }

  const exportPerson = async () => {
    setBusy('export');
    setActionError(null);
    try {
      const data = await api.call('profiles.export', { profileId: p.id });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `${p.id}.json` });
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported everything held about ${identity.email}.`);
    } catch (e) {
      setActionError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const erasePerson = async () => {
    const typed = identity.hidden ? p.id : identity.email;
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
      toast.success('Erased this person. Their e-mail and phone stay suppressed.');
      navigate('/audience/people', { replace: true });
    } catch (e) {
      setActionError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const personal = Object.entries(p.personal);
  const hidden = !canSeePii && personal.some(([, v]) => v === '[hidden]');
  const currentConsent = purposeRows(p.consent, purposes.data?.purposes, { includeUnrecorded: true });
  const topicRows = topics.data?.topics ?? [];
  const segmentRows = segments.data?.segments ?? [];

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title={identity.email}
        meta={
          <>
            {identity.name && <span>{identity.name}</span>}
            <CopyPersonId id={p.id} />
          </>
        }
        description="One person’s identity, consent per purpose and loaded history."
        actions={
          <>
            <Button icon={<RefreshCw size={15} />} onClick={() => void profile.reload()}>
              Refresh
            </Button>
            {canSeePii && (
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

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <Tabs
            label="Person sections"
            value={tab}
            onChange={setTab}
            items={[
              { key: 'timeline', label: 'Timeline' },
              { key: 'overview', label: 'Overview' },
              { key: 'consent', label: 'Consent' },
              { key: 'topics', label: 'Topics' },
              { key: 'segments', label: 'Segments' },
            ]}
          />

          {tab === 'timeline' && (
            <div className="mt-4">
              <ProfileTimeline timeline={timeline} purposes={purposes.data?.purposes} />
            </div>
          )}

          {tab === 'overview' && (
            <div className="mt-4 space-y-4">
              <div className="rounded-lg border border-line bg-surface p-4">
                <h2 className="mb-2 text-[14px] font-semibold">Identity</h2>
                <IdentityFacts profile={p} email={identity.email} name={identity.name} />
              </div>
              <div className="rounded-lg border border-line bg-surface p-4">
                <h2 className="mb-2 text-[14px] font-semibold">Identifiers</h2>
                {p.identifiers.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {p.identifiers.map((i) => (
                      <Tag key={`${i.type}:${i.value}`}>
                        {i.type}: <Mono className="ml-1 bg-transparent px-0">{i.value === '[hidden]' ? 'Hidden' : i.value}</Mono>
                      </Tag>
                    ))}
                  </div>
                ) : (
                  <p className="text-[13px] text-muted">No identifiers on this profile.</p>
                )}
              </div>
              <div className="rounded-lg border border-line bg-surface p-4">
                <h2 className="mb-2 text-[14px] font-semibold">Traits</h2>
                <Meta
                  items={[
                    ...Object.entries(p.traits).map(([k, v]): [ReactNode, ReactNode] => [k, valueText(v)]),
                    ...personal
                      .filter(([k]) => !['email', 'name', 'firstName', 'lastName'].includes(k))
                      .map(([k, v]): [ReactNode, ReactNode] => [
                        <span key={`k-${k}`} className="flex items-center gap-1.5">
                          {k}
                          <Tag>Personal</Tag>
                        </span>,
                        <span key={`v-${k}`}>{valueText(v)}</span>,
                      ]),
                  ]}
                />
                {!Object.keys(p.traits).length && personal.length === 0 && <p className="text-[13px] text-muted">No traits recorded.</p>}
              </div>
            </div>
          )}

          {tab === 'consent' && (
            <div className="mt-4 space-y-4">
              <div className="rounded-lg border border-line bg-surface p-4">
                <h2 className="mb-2 text-[14px] font-semibold">Consent per purpose</h2>
                <PurposeConsentList rows={currentConsent} showContext label="Current consent per purpose" />
                <p className="mt-2 text-[12px] leading-[18px] text-muted">
                  A missing record is shown as “No recorded choice”, never as a refusal. Eligibility follows each purpose’s lawful basis.
                </p>
              </div>
              <TableFrame
                loading={timeline.loading}
                error={timeline.consentError}
                onRetry={timeline.retryConsent}
                columns={5}
                isEmpty={timeline.consent.length === 0}
                empty={<EmptyState compact title="No consent choices recorded" />}
              >
                <p className="border-b border-line px-4 py-2 text-[12px] text-muted">
                  The consent ledger is append-only and includes merged profiles. Each row adds a record; the latest per purpose and channel
                  is the current choice.
                </p>
                <ConsentHistoryTable records={timeline.consent} />
              </TableFrame>
            </div>
          )}

          {tab === 'topics' && (
            <div className="mt-4">
              <TableFrame
                loading={topics.loading}
                error={topics.error}
                onRetry={topics.reload}
                columns={5}
                isEmpty={topicRows.length === 0}
                empty={
                  <EmptyState compact title="No topic choices">
                    A topic is a finer choice within a purpose; it never replaces consent for the purpose.
                  </EmptyState>
                }
              >
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
                          <StatusPill tone={t.status === 'subscribed' ? 'good' : 'warn'}>{consentLabel(t.status)}</StatusPill>
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
              </TableFrame>
            </div>
          )}

          {tab === 'segments' && (
            <div className="mt-4">
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
                          <Link to={`/audience/segments/${s.id}`} className="font-medium text-fg hover:underline">
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
            </div>
          )}
        </div>

        <aside className="min-w-0 space-y-4" aria-label="Identity context">
          <Card title="Identity" padded>
            <IdentityFacts profile={p} email={identity.email} name={identity.name} />
          </Card>
          <Card title="Current consent" padded>
            <PurposeConsentList rows={currentConsent} showContext label="Current consent per purpose" />
            {currentConsent.some((row) => row.basis) && (
              <p className="mt-2 text-[12px] leading-[18px] text-muted">
                {currentConsent
                  .filter((row) => row.basis)
                  .map((row) => `${row.name ?? 'Purpose name unavailable'}: ${basisLabel(row.basis)}`)
                  .join(' · ')}
              </p>
            )}
          </Card>
        </aside>
      </div>

      {confirmDialog}
    </div>
  );
}

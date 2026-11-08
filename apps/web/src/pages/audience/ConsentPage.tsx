import { Pencil, Search } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errText } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { Link } from '../../app/router';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { usePageTab } from '../../app/useTab';
import { purposeLabel } from '../../lib/labels';
import { ConsentHistoryTable } from '../../features/audience/consent';
import { personLabel } from '../../features/audience/profile';
import {
  Alert,
  Button,
  Card,
  Drawer,
  EmptyState,
  Field,
  fieldErrors,
  Input,
  ListSkeleton,
  LoadingBlock,
  Meta,
  Mono,
  PageHeader,
  Select,
  Skeleton,
  StatusPill,
  Table,
  TableFrame,
  Tabs,
  Tag,
  Td,
  Textarea,
  THead,
  Th,
  Tr,
  useToast,
} from '../../ui';
import { pageWidth } from '../../ui/layout';
import TopicsPage from '../build/TopicsPage';
import PurposesPage from '../settings/PurposesPage';

type Status = 'granted' | 'denied' | 'withdrawn' | 'objected';
type Lookup = { id: string; from: string };

const PROFILE_ID = /^prf_[0-9a-f]{32}$/;
const PURPOSE = /^[a-z][a-z0-9_]{0,63}$/;

const BASIS_LABEL: Record<string, string> = {
  consent: 'Consent',
  legitimate_interest: 'Legitimate interest',
  contract: 'Contract',
  legal_obligation: 'Legal obligation',
};

const basisLabel = (basis: string) => BASIS_LABEL[basis] ?? basis.replace(/_/g, ' ');

const STATUS_LABEL: Record<Status, string> = {
  granted: 'Granted',
  denied: 'Denied',
  withdrawn: 'Withdrawn',
  objected: 'Objected',
};

const CHANNEL_LABEL: Record<string, string> = {
  email: 'E-mail',
  web: 'Web',
  sms: 'SMS',
  push: 'Push',
  webhook: 'Webhook',
};

const channelLabel = (channel: string) => CHANNEL_LABEL[channel] ?? channel.replace(/_/g, ' ');

const refused = (c: { denied: number; withdrawn: number; objected: number }) => c.denied + c.withdrawn + c.objected;

/** Purposes in force as the choices recorded against them, then the append-only ledger. */
export function ConsentLedger() {
  const { can } = useSession();
  const [value, setValue] = useState('');
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [person, setPerson] = useState<Lookup | null>(null);
  const [recording, setRecording] = useState(false);

  const purposes = useApi(() => api.call('purposes.list', {}), [], { skip: !can('artifacts:read') });
  const summary = useApi(() => api.call('consent.summary', {}), [], { skip: !can('profiles:read') });
  const counts = new Map((summary.data?.purposes ?? []).map((p) => [p.purpose, p]));
  const topicCounts = new Map<string, { topic: string; subscribed: number; unsubscribed: number }[]>();
  for (const t of summary.data?.topics ?? []) topicCounts.set(t.purpose, [...(topicCounts.get(t.purpose) ?? []), t]);
  const profile = useApi(() => api.call('profiles.get', { profileId: person!.id }), [person?.id], { skip: !person });
  const history = useApi(() => api.call('consent.history', { profileId: person!.id }), [person?.id], { skip: !person });

  const lookUp = async () => {
    const q = value.trim();
    setLookupError(null);
    setPerson(null);
    if (!q) {
      setLookupError('Enter an e-mail address or a profile id.');
      return;
    }
    if (PROFILE_ID.test(q)) {
      setPerson({ id: q, from: q });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) {
      setLookupError('Enter an e-mail address, or a profile id (prf_…).');
      return;
    }
    setLookingUp(true);
    try {
      const r = await api.call('profiles.find', { type: 'email', value: q });
      if (!r.profileId) {
        setLookupError('No one has that e-mail. Try their profile id instead.');
        return;
      }
      setPerson({ id: r.profileId, from: q });
    } catch (e) {
      setLookupError(errText(e));
    } finally {
      setLookingUp(false);
    }
  };

  const records = history.data?.records ?? [];
  const canRecord = can('profiles:write');

  return (
    <div className="space-y-5">
      <Alert tone="info">
        The consent ledger is append-only. A record is never edited or deleted; to correct a choice, record a new one. The latest record per
        purpose and channel is what the send gateway uses.
      </Alert>

      <section aria-labelledby="purposes-heading">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 id="purposes-heading" className="text-[16px] leading-6 font-semibold">
            Consent by purpose
          </h2>
          {purposes.data && <Tag>{purposes.data.source === 'published' ? 'Published purposes' : 'Defaults'}</Tag>}
        </div>
        {!can('artifacts:read') ? (
          <Alert tone="info">Your role cannot read the purposes. Ask a workspace admin to give you access to them.</Alert>
        ) : purposes.loading ? (
          <ListSkeleton label="Loading purposes" columns={5} />
        ) : purposes.error ? (
          <Alert tone="bad" title="Couldn't load the purposes" onRetry={purposes.reload}>
            {purposes.error}
          </Alert>
        ) : (
          <>
            <TableFrame>
              <Table label="Purposes">
                <THead>
                  <tr>
                    <Th className="max-md:hidden">Purpose</Th>
                    <Th className="max-md:hidden">Lawful basis</Th>
                    <Th className="max-md:hidden">Channels</Th>
                    <Th className="max-md:hidden">People</Th>
                    <Th className="max-md:hidden">Double opt-in</Th>
                  </tr>
                </THead>
                <tbody>
                  {(purposes.data?.purposes ?? []).map((p) => {
                    const c = counts.get(p.key);
                    return (
                      <Tr key={p.key} className="max-md:block max-md:border-t max-md:border-line">
                        <Td className="max-md:block max-md:border-0 max-md:pb-1">
                          <div className="font-medium text-fg">{p.name}</div>
                          {p.description && <p className="mt-1 max-w-[360px] text-[12px] leading-[18px] text-muted">{p.description}</p>}
                        </Td>
                        <Td className="whitespace-nowrap max-md:flex max-md:justify-between max-md:gap-4 max-md:border-0 max-md:py-1">
                          <span className="text-muted md:hidden">Lawful basis: </span>
                          {basisLabel(p.basis)}
                        </Td>
                        <Td className="max-md:flex max-md:flex-wrap max-md:items-baseline max-md:justify-between max-md:gap-4 max-md:border-0 max-md:py-1">
                          <span className="text-muted md:hidden">Channels: </span>
                          {p.channels.length ? (
                            <span className="flex flex-wrap gap-1">
                              {p.channels.map((ch) => (
                                <Tag key={ch}>{channelLabel(ch)}</Tag>
                              ))}
                            </span>
                          ) : (
                            <span className="text-muted">None</span>
                          )}
                        </Td>
                        <Td className="max-md:block max-md:border-0 max-md:py-1">
                          <span className="text-muted md:hidden">People: </span>
                          {summary.loading ? (
                            <span className="inline-flex items-center gap-2">
                              <Skeleton className="h-4 w-24" />
                              <span className="sr-only">Loading counts</span>
                            </span>
                          ) : c ? (
                            <div className="space-y-1">
                              <span className="flex flex-wrap gap-1">
                                <StatusPill tone="good">{c.granted} allowed</StatusPill>
                                {refused(c) > 0 && <StatusPill tone="warn">{refused(c)} refused</StatusPill>}
                              </span>
                              {c.channels.length > 0 && (
                                <div className="text-[12px] leading-[18px] text-muted">
                                  {c.channels.map((ch) => `${channelLabel(ch.channel)}: ${ch.granted} allowed, ${refused(ch)} refused`).join(' · ')}
                                </div>
                              )}
                              {(topicCounts.get(p.key) ?? []).length > 0 && (
                                <div className="text-[12px] leading-[18px] text-muted">
                                  {(topicCounts.get(p.key) ?? []).map((t) => `${t.topic}: ${t.subscribed} subscribed`).join(' · ')}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted">No recorded choices</span>
                          )}
                        </Td>
                        <Td className="max-md:flex max-md:justify-between max-md:gap-4 max-md:border-0 max-md:py-1">
                          <span className="text-muted md:hidden">Double opt-in: </span>
                          {p.requiresDoubleOptIn ? 'Yes' : <span className="text-muted">No</span>}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableFrame>
            <p className="mt-2 text-[12px] leading-[18px] text-muted">
              Counts show recorded choices for people who are still active. A person with no record is not counted as a refusal.
            </p>
          </>
        )}
      </section>

      <Card
        title="Look up a person"
        description="Search by e-mail without revealing personal data, or paste their profile id."
        padded
        className="mb-0"
      >
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void lookUp();
          }}
        >
          <Field label="E-mail or profile id" className="min-w-[240px] flex-1" error={lookupError}>
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" aria-hidden />
              <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="ada@example.com or prf_…" className="pl-8" />
            </div>
          </Field>
          <Button type="submit" loading={lookingUp} icon={<Search size={14} />}>
            Look up
          </Button>
        </form>
      </Card>

      {person && (
        <Card
          title="Consent ledger"
          description={person.from !== person.id ? `Found from ${person.from}` : undefined}
          action={
            canRecord && (
              <Button icon={<Pencil size={14} />} onClick={() => setRecording(true)}>
                Record consent
              </Button>
            )
          }
        >
          <div className="border-b border-line px-4 py-3">
            {profile.loading ? (
              <LoadingBlock lines={2} label="Loading person" />
            ) : profile.error ? (
              <Alert tone="bad" onRetry={profile.reload}>
                {profile.error}
              </Alert>
            ) : (
              profile.data && (
                <Meta
                  items={[
                    [
                      'Person',
                      <Link key="person" to={`/audience/people/${profile.data.id}`} className="font-medium text-accent hover:underline">
                        {personLabel(profile.data, profile.data.id)}
                      </Link>,
                    ],
                    [
                      'Profile id',
                      <Mono key="id" className="break-all">
                        {profile.data.id}
                      </Mono>,
                    ],
                  ]}
                />
              )
            )}
          </div>
          <TableFrame
            loading={history.loading}
            error={history.error}
            onRetry={history.reload}
            columns={5}
            loadingLabel="Loading consent history"
            isEmpty={records.length === 0}
            empty={
              <EmptyState compact title="No consent records yet">
                Record what the person agreed to, refused or withdrew, with the evidence you have. A missing choice is not a refusal.
              </EmptyState>
            }
          >
            <ConsentHistoryTable records={records} purposes={purposes.data?.purposes} />
          </TableFrame>
        </Card>
      )}

      {recording && person && (
        <RecordDrawer
          profileId={person.id}
          purposes={(purposes.data?.purposes ?? []).map((p) => ({ key: p.key, name: p.name }))}
          onClose={() => setRecording(false)}
          onRecorded={() => {
            setRecording(false);
            void history.reload();
            void profile.reload();
            void summary.reload();
          }}
        />
      )}
    </div>
  );
}

function RecordDrawer({
  profileId,
  purposes,
  onClose,
  onRecorded,
}: {
  profileId: string;
  purposes: { key: string; name: string }[];
  onClose: () => void;
  onRecorded: () => void;
}) {
  const toast = useToast();
  const [purpose, setPurpose] = useState(purposes[0]?.key ?? 'marketing_email');
  const [status, setStatus] = useState<Status>('granted');
  const [channel, setChannel] = useState('');
  const [source, setSource] = useState<'form' | 'import' | 'api' | 'unsubscribe'>('form');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const next: Record<string, string> = {};
    if (!PURPOSE.test(purpose)) next.purpose = 'Use the purpose key from the purposes in force, in lowercase.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.call('consent.record', {
        profileId,
        purpose,
        channel: channel as '' | 'email' | 'web' | 'sms' | 'push' | 'webhook',
        status,
        source,
        proof: note.trim() ? { note: note.trim() } : {},
      });
      const name = purposes.find((p) => p.key === purpose)?.name ?? purposeLabel(purpose);
      toast.success(
        r.allowed
          ? `Recorded “${name}” as ${STATUS_LABEL[status]}; it is allowed now.`
          : `Recorded “${name}” as ${STATUS_LABEL[status]}. It is not allowed under the current basis.`,
      );
      onRecorded();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_input') setErrors(fieldErrors(e.details));
      else setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title="Record consent"
      meta={<Mono className="bg-transparent px-0">{profileId}</Mono>}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" mutation loading={busy} onClick={submit}>
            Record consent
          </Button>
        </>
      }
    >
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Purpose" error={errors.purpose} required hint="What the choice is about. From the purposes in force.">
          {purposes.length ? (
            <Select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              {purposes.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              onBlur={() =>
                setErrors((x) => ({
                  ...x,
                  purpose: PURPOSE.test(purpose) ? '' : 'Use the purpose key from the purposes in force, in lowercase.',
                }))
              }
              autoComplete="off"
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Choice" required>
            <Select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
              <option value="granted">Granted</option>
              <option value="denied">Denied</option>
              <option value="withdrawn">Withdrawn</option>
              <option value="objected">Objected</option>
            </Select>
          </Field>
          <Field label="Channel" hint="Any channel, or the one this choice is for.">
            <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">Any channel</option>
              <option value="email">E-mail</option>
              <option value="web">Web</option>
              <option value="sms">SMS</option>
              <option value="push">Push</option>
              <option value="webhook">Webhook</option>
            </Select>
          </Field>
        </div>
        <Field label="Where it came from" hint="Kept as the record's source.">
          <Select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            <option value="form">A form</option>
            <option value="import">An import</option>
            <option value="api">An API or agent</option>
            <option value="unsubscribe">An unsubscribe</option>
          </Select>
        </Field>
        <Field label="Proof note" hint="What they saw or signed, and when. For example “Homepage newsletter checkbox v3, 2026-10-20”.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} />
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <p className="text-[12px] text-muted">This adds a row to the ledger. Earlier records stay as they were.</p>
        <button type="submit" hidden />
      </form>
    </Drawer>
  );
}

const CONSENT_TABS = ['consent', 'purposes', 'topics'] as const;
type ConsentTab = (typeof CONSENT_TABS)[number];

const CONSENT_TAB_ITEMS: { key: ConsentTab; label: string }[] = [
  { key: 'consent', label: 'Consent' },
  { key: 'purposes', label: 'Purposes' },
  { key: 'topics', label: 'Editorial topics' },
];

/**
 * Consent (#446): the append-only consent ledger plus the existing purposes editor and editorial
 * queue as named tabs. The page owns the one h1; each tab is a section inside it. The route admits
 * either permission and each tab keeps its own gate, so an artifacts-only role can use Purposes and
 * Editorial topics without seeing the consent summary.
 */
export default function ConsentPage() {
  const { can } = useSession();
  const { active, forbidden, invalid, select } = usePageTab({
    keys: CONSENT_TABS,
    fallback: 'consent',
    allowed: (tab) => (tab === 'consent' ? can('profiles:read') : can('artifacts:read')),
  });
  useCrumbs([{ label: active === 'consent' ? 'Consent' : active === 'purposes' ? 'Purposes' : 'Editorial topics' }]);

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title="Consent"
        description="The purposes this workspace relies on, every choice people have recorded, and the editorial topics backlog. The consent ledger is append-only."
      />
      {invalid && (
        <Alert tone="info" className="mb-4">
          This tab is unavailable.
        </Alert>
      )}
      <Tabs items={CONSENT_TAB_ITEMS} value={active} onChange={select} label="Consent">
        {forbidden ? (
          <EmptyState title="Your role can't open this tab">
            {forbidden === 'consent'
              ? 'The consent ledger needs permission to read profiles. Ask a workspace admin for access.'
              : 'Purposes and editorial topics need permission to read artifacts. Ask a workspace admin for access.'}
          </EmptyState>
        ) : active === 'purposes' ? (
          <PurposesPage />
        ) : active === 'topics' ? (
          <TopicsPage />
        ) : (
          <ConsentLedger />
        )}
      </Tabs>
    </div>
  );
}

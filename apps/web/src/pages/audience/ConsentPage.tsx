import { Pencil, Search } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errText } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { Link } from '../../app/router';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
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
  LoadingBlock,
  Meta,
  Mono,
  PageHeader,
  Select,
  StatusPill,
  TableFrame,
  Tag,
  Textarea,
  useToast,
} from '../../ui';

type Status = 'granted' | 'denied' | 'withdrawn' | 'objected';
type Lookup = { id: string; from: string };

const PROFILE_ID = /^prf_[0-9a-f]{32}$/;
const PURPOSE = /^[a-z][a-z0-9_]{0,63}$/;

const refused = (c: { denied: number; withdrawn: number; objected: number }) => c.denied + c.withdrawn + c.objected;

/** Purposes in force and the append-only ledger they are recorded in. */
export default function ConsentPage() {
  useCrumbs([{ label: 'Consent' }]);
  const { can } = useSession();
  const [value, setValue] = useState('');
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [person, setPerson] = useState<Lookup | null>(null);
  const [recording, setRecording] = useState(false);

  const purposes = useApi(() => api.call('purposes.list', {}), [], { skip: !can('artifacts:read') });
  const summary = useApi(() => api.call('consent.summary', {}), [], { skip: !can('profiles:read') });
  const counts = new Map((summary.data?.purposes ?? []).map((p) => [p.purpose, p]));
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
    <div>
      <PageHeader
        title="Consent"
        description="The purposes this workspace relies on, and the ledger of every choice a person has made. Look someone up to see or add records."
      />

      <Alert tone="info" className="mb-5">
        The consent ledger is append-only. A record is never edited or deleted; to correct a choice, record a new one. The latest record per purpose and
        channel is what the send gateway uses.
      </Alert>

      <section className="mb-6" aria-labelledby="purposes-heading">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 id="purposes-heading" className="text-[14px] font-semibold">
            Purposes in force
          </h2>
          {purposes.data && <Tag>{purposes.data.source === 'published' ? 'Published purposes' : 'Defaults'}</Tag>}
        </div>
        {!can('artifacts:read') ? (
          <Alert tone="info">
            Your role cannot read the purposes artifact. Ask a workspace admin for <Mono>artifacts:read</Mono> to see the full list here.
          </Alert>
        ) : purposes.loading ? (
          <LoadingBlock lines={3} label="Loading purposes" />
        ) : purposes.error ? (
          <Alert tone="bad" title="Couldn't load the purposes" onRetry={purposes.reload}>
            {purposes.error}
          </Alert>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {(purposes.data?.purposes ?? []).map((p) => {
              const c = counts.get(p.key);
              return (
                <Card key={p.key} padded>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-[14px] font-semibold text-fg">{p.name}</h3>
                      <Mono className="mt-0.5 inline-block bg-transparent px-0 text-muted">{p.key}</Mono>
                    </div>
                    <Tag>{p.basis.replace(/_/g, ' ')}</Tag>
                  </div>
                  <p className="mt-2 text-[13px] text-fg-2">{p.description}</p>
                  {p.channels.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {p.channels.map((ch) => (
                        <Tag key={ch}>{ch}</Tag>
                      ))}
                    </div>
                  )}
                  {c && (
                    <div className="mt-2 border-t border-line pt-2 text-[12px] text-muted">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <StatusPill tone="good">{c.granted} allowed</StatusPill>
                        {refused(c) > 0 && <StatusPill tone="warn">{refused(c)} refused</StatusPill>}
                      </span>
                      {c.channels.length > 0 && (
                        <p className="mt-1">
                          {c.channels.map((ch) => `${ch.channel}: ${ch.granted} allowed, ${refused(ch)} refused`).join(' · ')}
                        </p>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <Card
        title="Look up a person"
        description="Search by e-mail without revealing personal data, or paste their profile id."
        padded
        className="mb-5"
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
                    ['Profile id', <Mono key="id" className="break-all">{profile.data.id}</Mono>],
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
            isEmpty={records.length === 0}
            empty={
              <EmptyState compact title="No consent records yet">
                Record what the person agreed to, refused or withdrew, with the evidence you have.
              </EmptyState>
            }
          >
            <ConsentHistoryTable records={records} />
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
    if (!PURPOSE.test(purpose)) next.purpose = 'Use a lowercase key such as marketing_email.';
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
      toast.success(
        r.allowed
          ? `Recorded “${purpose}” as ${status}; it is allowed now.`
          : `Recorded “${purpose}” as ${status}. It is not allowed under the current basis.`,
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
          <Button variant="primary" loading={busy} onClick={submit}>
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
                  {p.name} ({p.key})
                </option>
              ))}
            </Select>
          ) : (
            <Input
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              onBlur={() => setErrors((x) => ({ ...x, purpose: PURPOSE.test(purpose) ? '' : 'Use a lowercase key such as marketing_email.' }))}
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
        <Field
          label="Proof note"
          hint="What they saw or signed, and when. For example “Homepage newsletter checkbox v3, 2026-10-20”."
        >
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} />
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <p className="text-[12px] text-muted">This adds a row to the ledger. Earlier records stay as they were.</p>
        <button type="submit" hidden />
      </form>
    </Drawer>
  );
}

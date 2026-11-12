import { Search } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import { ButtonLink } from '../../app/links';
import { useCrumbs } from '../../app/page';
import { Link } from '../../app/router';
import { useSession } from '../../app/session';
import { useKeyedApi } from '../../app/useApi';
import { StatCard, StatGrid, StatGridSkeleton } from '../../features/insights/Stats';
import { purposeLabel } from '../../lib/labels';
import {
  Alert,
  Button,
  EmptyState,
  Field,
  formatDateTime,
  Input,
  Mono,
  PageHeader,
  Select,
  StatusPill,
  Table,
  TableFrame,
  Td,
  THead,
  Th,
  Tr,
  timeAgo,
} from '../../ui';
import { pageWidth } from '../../ui/layout';

type Message = Out<'messages.list'>['messages'][number];
type MessageStatus = Message['status'];

const PROFILE_ID = /^prf_[0-9a-f]{32}$/;
const CHANNELS = ['email', 'sms', 'push'];
const STATUSES: MessageStatus[] = ['queued', 'sending', 'sent', 'suppressed', 'failed', 'delivered', 'bounced', 'complained'];

const tone = {
  queued: 'neutral',
  sending: 'neutral',
  sent: 'info',
  delivered: 'good',
  suppressed: 'warn',
  failed: 'bad',
  bounced: 'bad',
  complained: 'bad',
} as const;

/** Messages and what happened to them, with the period's performance at the top. */
export default function MessagesPage() {
  useCrumbs([{ label: 'Messages' }]);
  const { can } = useSession();
  const [days, setDays] = useState(30);
  const [person, setPerson] = useState('');
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');
  const [more, setMore] = useState<{ key: string; rows: Message[]; cursor: string | null; loaded: boolean }>({
    key: '',
    rows: [],
    cursor: null,
    loaded: false,
  });
  const [loadingMoreByKey, setLoadingMoreByKey] = useState<{ key: string; value: boolean }>({ key: '', value: false });
  const [moreError, setMoreError] = useState<{ key: string; message: string | null }>({ key: '', message: null });

  const profileId = PROFILE_ID.test(person.trim()) ? person.trim() : '';
  const filterKey = `${profileId}|${channel}|${status}`;
  const filters = {
    ...(profileId ? { profileId } : {}),
    ...(channel ? { channel } : {}),
    ...(status ? { status: status as MessageStatus } : {}),
  };

  // A filter or period is the identity of the read, not a refresh of the previous one (#619).
  const list = useKeyedApi(filterKey, () => api.call('messages.list', { limit: 50, ...filters }));
  const stats = useKeyedApi(String(days), () => api.call('messages.stats', { days }), { skip: !can('artifacts:read') });

  // Extra pages carry the filter key they were loaded for, so the first render after a change can
  // never mix two filters, and a response for the old filter is dropped.
  const currentMore = more.key === filterKey ? more : { key: filterKey, rows: [], cursor: null, loaded: false };
  const loadingMore = loadingMoreByKey.key === filterKey && loadingMoreByKey.value;
  const moreErrorNow = moreError.key === filterKey ? moreError.message : null;
  const keyRef = useRef(filterKey);
  keyRef.current = filterKey;

  const all = [...(list.data?.messages ?? []), ...currentMore.rows];
  const cursor = currentMore.loaded ? currentMore.cursor : (list.data?.nextCursor ?? null);
  const filtered = !!person.trim() || !!channel || !!status;

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const requestKey = filterKey;
    setLoadingMoreByKey({ key: requestKey, value: true });
    setMoreError({ key: requestKey, message: null });
    try {
      const r = await api.call('messages.list', { limit: 50, cursor, ...filters });
      if (keyRef.current !== requestKey) return;
      setMore((current) =>
        current.key === requestKey
          ? { key: requestKey, rows: [...current.rows, ...r.messages], cursor: r.nextCursor, loaded: true }
          : { key: requestKey, rows: r.messages, cursor: r.nextCursor, loaded: true },
      );
    } catch (e) {
      if (keyRef.current === requestKey) setMoreError({ key: requestKey, message: errText(e) });
    } finally {
      setLoadingMoreByKey((current) => (current.key === requestKey ? { key: requestKey, value: false } : current));
    }
  };

  const count = (key: string) => stats.data?.counts[key] ?? 0;
  const hasOpens = stats.data?.counts.opened !== undefined;

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title="Messages"
        description="Every e-mail and SMS the gateway handled, newest first, with attempts, when a retry is due and the reason when one was not sent. Filters and paging run on the server."
        actions={
          can('artifacts:read') && (
            <Field label="Period" className="w-[150px]">
              <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
              </Select>
            </Field>
          )
        }
      />

      {!can('artifacts:read') ? (
        <Alert tone="info" className="mb-5">
          Message performance needs <Mono>artifacts:read</Mono>. The message list below is still available.
        </Alert>
      ) : stats.error ? (
        <Alert tone="bad" title="Couldn't load message performance" onRetry={stats.reload} className="mb-5">
          {stats.error}
        </Alert>
      ) : stats.loading ? (
        <div className="mb-5">
          <StatGridSkeleton labels={['Sent', 'Delivered', 'Opened', 'Clicked', 'Bounced', 'Complained']} />
          <p className="mt-2 text-[12px] text-muted">Last {days} days. Loading the period’s counts.</p>
        </div>
      ) : (
        <div className="mb-5">
          <StatGrid>
            <StatCard label="Sent" value={count('sent').toLocaleString()} />
            <StatCard label="Delivered" value={count('delivered').toLocaleString()} />
            <StatCard label="Opened" value={count('opened').toLocaleString()} />
            <StatCard label="Clicked" value={count('clicked').toLocaleString()} />
            <StatCard label="Bounced" value={count('bounced').toLocaleString()} tone={count('bounced') > 0 ? 'bad' : undefined} />
            <StatCard label="Complained" value={count('complained').toLocaleString()} tone={count('complained') > 0 ? 'bad' : undefined} />
          </StatGrid>
          <p className="mt-2 text-[12px] text-muted">
            Last {days} days{stats.data ? ` · ${stats.data.counts.decided?.toLocaleString() ?? '0'} decided` : ''}.{' '}
            {hasOpens ? '' : 'Opens are not tracked: the platform sends no tracking pixels.'}
          </p>
        </div>
      )}

      <TableFrame
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        columns={7}
        isEmpty={all.length === 0}
        toolbar={
          <>
            <div className="relative w-full max-w-[240px]">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" aria-hidden />
              <Input
                compact
                aria-label="Filter by profile id"
                placeholder="Profile id (prf_…)"
                value={person}
                onChange={(e) => setPerson(e.target.value)}
                className="pl-8"
              />
            </div>
            <Select compact aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)} className="w-auto">
              <option value="">All channels</option>
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
            <Select compact aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            {person.trim() && !profileId && <span className="text-[12px] text-warn">Enter the full profile id, prf_…</span>}
            <span className="ml-auto text-[12px] text-muted">
              {all.length.toLocaleString()} message{all.length === 1 ? '' : 's'}
              {cursor ? ' · more available' : ''}
            </span>
          </>
        }
        empty={
          filtered ? (
            <EmptyState compact title="Nothing matches">
              Clear the person, channel or status filter.
            </EmptyState>
          ) : (
            <EmptyState
              title="No messages yet"
              action={
                can('artifacts:read') && (
                  <>
                    <ButtonLink to="/marketing/broadcasts" variant="primary">
                      Go to broadcasts
                    </ButtonLink>
                    <ButtonLink to="/marketing/journeys">Go to journeys</ButtonLink>
                  </>
                )
              }
            >
              Sends from broadcasts, journeys and the messages API appear here with their status and delivery events.
            </EmptyState>
          )
        }
      >
        <Table label="Messages">
          <THead>
            <tr>
              <Th>Status</Th>
              <Th className="hidden sm:table-cell">Channel</Th>
              <Th>Person</Th>
              <Th className="hidden lg:table-cell">Purpose</Th>
              <Th className="hidden md:table-cell">Attempts</Th>
              <Th>What happened</Th>
              <Th>When</Th>
            </tr>
          </THead>
          <tbody>
            {all.map((m) => (
              <Tr key={m.id}>
                <Td>
                  <StatusPill tone={tone[m.status] ?? 'neutral'}>{m.status}</StatusPill>
                </Td>
                <Td className="hidden sm:table-cell">{m.channel}</Td>
                <Td>
                  {m.profileId ? (
                    <Link to={`/audience/people/${m.profileId}`} className="font-medium text-accent hover:underline">
                      <Mono className="bg-transparent px-0">{m.profileId.slice(0, 14)}…</Mono>
                    </Link>
                  ) : (
                    <span className="text-muted">No person</span>
                  )}
                </Td>
                <Td className="hidden lg:table-cell">
                  {purposeLabel(m.purpose)}
                  {m.test && <span className="ml-1 text-muted">· test</span>}
                </Td>
                <Td className="hidden md:table-cell">{m.attempts > 0 ? m.attempts : <span className="text-muted">—</span>}</Td>
                <Td className="max-w-[360px]">
                  {m.status === 'queued' && m.nextAttemptAt ? (
                    <span className="line-clamp-2">
                      Retrying at {formatDateTime(m.nextAttemptAt)}
                      {m.lastError ? ` · ${m.lastError}` : ''}
                    </span>
                  ) : m.reason ? (
                    <span className="line-clamp-2">{m.reason}</span>
                  ) : m.events.length ? (
                    <span className="line-clamp-2">
                      {m.events
                        .slice(-2)
                        .map((e) => `${e.type}${e.reason ? ` (${e.reason})` : ''}`)
                        .join(' · ')}
                    </span>
                  ) : (
                    <span className="text-muted">
                      {m.notBefore ? `Held until ${formatDateTime(m.notBefore)}` : 'No delivery events yet'}
                    </span>
                  )}
                </Td>
                <Td className="whitespace-nowrap" title={formatDateTime(m.createdAt)}>
                  {timeAgo(m.createdAt)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>
      {moreErrorNow && (
        <Alert tone="bad" className="mt-3">
          {moreErrorNow}
        </Alert>
      )}
      {cursor && (
        <div className="mt-3 flex justify-center">
          <Button onClick={() => void loadMore()} loading={loadingMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

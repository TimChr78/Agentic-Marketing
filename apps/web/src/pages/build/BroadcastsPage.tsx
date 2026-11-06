import { Plus, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../app/api';
import { artifactPath } from '../../app/artifactRoutes';
import { useCrumbs } from '../../app/page';
import { Link, navigate, setSearchParam, useLocation } from '../../app/router';
import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { BroadcastStatePill } from '../../features/artifacts/BroadcastState';
import { CreateBroadcastDialog } from '../../features/broadcasts/CreateBroadcastDialog';
import {
  BROADCAST_STATUS_FILTERS,
  type BroadcastListRow,
  broadcastAudienceOf,
  broadcastCountLabel,
  broadcastResultOf,
  broadcastScheduleOf,
  broadcastStateOf,
  broadcastSubtitleOf,
  filterForParam,
} from '../../features/broadcasts/listView';
import { invalidateArtifactNames, useArtifactNames } from '../../features/broadcasts/names';
import { Button, formatDateTime, Select, Skeleton } from '../../ui';
import { Identifier } from '../../ui/Identifier';
import { ListPage, type PageNotice, type PageReadState } from '../../ui/ListPage';

const PAGE_SIZE = 25;

interface Paging {
  param: string | null;
  stack: (string | undefined)[];
  index: number;
}

const firstPage = (param: string | null): Paging => ({ param, stack: [undefined], index: 0 });

/**
 * Broadcasts on the v2 list template (#448): one `broadcasts.list` read per page, the operational
 * state from `stateOfBroadcast`, and the segment names resolved from one shared artifacts.list
 * cache. There is no name search (the read has none) and no per-row `broadcasts.status` fan-out.
 */
export default function BroadcastsPage() {
  useCrumbs([{ label: 'Broadcasts' }]);
  const { can } = useWorkspace();
  const { search } = useLocation();
  const canRead = can('artifacts:read');
  const canWrite = can('artifacts:write');
  const { filter, unknown } = filterForParam(search.get('status'));
  const [paging, setPaging] = useState<Paging>(() => firstPage(filter.param));
  const activePaging = paging.param === filter.param ? paging : firstPage(filter.param);
  const cursor = activePaging.stack[activePaging.index];
  const [creating, setCreating] = useState(false);

  const list = useApi(
    async () => {
      const response = await api.call('broadcasts.list', {
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
        ...(filter.statuses ? { statuses: filter.statuses } : {}),
      });
      // Tag the response with the page it answers: a stale response must never advance the cursor
      // for the page on screen (a second Next before a request completes).
      return { ...response, cursor, param: filter.param };
    },
    [cursor, filter.param],
    { skip: !canRead },
  );
  const segments = useArtifactNames('segment', { skip: !canRead });

  // `?create=broadcast` is S's create intent; it opens this same create form once, then clears the
  // parameter so closing the dialog does not immediately reopen it.
  const createParam = search.get('create');
  useEffect(() => {
    if (createParam !== 'broadcast' || !canRead || !canWrite) return;
    setCreating(true);
    setSearchParam('create', null);
  }, [createParam, canRead, canWrite]);

  const data = list.data;
  // The page currently on screen is the one whose response carries this cursor and filter. While a
  // page or filter transition is in flight, `useApi` still holds the previous response, so nothing
  // may read its `nextCursor` or rows as if they belonged to the requested page.
  const currentPage = data !== undefined && data.cursor === cursor && data.param === filter.param ? data : undefined;
  const loadedPage = currentPage !== undefined;
  const rows = currentPage?.broadcasts ?? [];
  const state: PageReadState = !canRead
    ? 'restricted'
    : !loadedPage
      ? list.error
        ? 'error'
        : 'loading'
      : rows.length === 0
        ? 'empty'
        : 'ready';
  const segmentName = (row: BroadcastListRow) => segments.data?.get(row.segmentId)?.name;
  const asOf = currentPage ? formatDateTime(currentPage.asOf, { zone: true }) : null;
  // Busy only while a request is in flight: after a failed page or filter change the filter and
  // Previous work again, and Next still needs the displayed page's own cursor (#442 re-review).
  const pageBusy = list.refreshing;

  const changeFilter = (key: string) => {
    const next = BROADCAST_STATUS_FILTERS.find((f) => f.key === key);
    if (!next) return;
    setSearchParam('status', next.param);
    setPaging(firstPage(next.param));
  };

  const clearFilter = () => changeFilter('all');

  const refresh = () => {
    // Reference names outlive a list response by design; Refresh retries them too (#459).
    invalidateArtifactNames();
    void segments.reload();
    if (activePaging.index === 0) void list.reload();
    else setPaging(firstPage(filter.param));
  };

  const previous = () => {
    if (pageBusy || activePaging.index === 0) return;
    setPaging({ ...activePaging, index: activePaging.index - 1 });
  };

  const next = () => {
    const nextCursor = currentPage?.nextCursor ?? null;
    if (pageBusy || !loadedPage || !nextCursor) return;
    setPaging({
      param: filter.param,
      stack: [...activePaging.stack.slice(0, activePaging.index + 1), nextCursor],
      index: activePaging.index + 1,
    });
  };

  let notice: PageNotice | undefined;
  if (state === 'restricted') {
    notice = {
      title: 'Broadcasts are restricted',
      body: 'Reading broadcasts needs the artifacts:read permission. Ask a workspace admin to give you access.',
    };
  } else if (state === 'error') {
    notice = {
      title: 'Couldn’t load broadcasts',
      body: list.error ?? 'Broadcast data is unavailable.',
      action: (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void list.reload()}>Retry</Button>
          {activePaging.index > 0 && (
            <Button variant="secondary" disabled={pageBusy} onClick={previous}>
              Previous page
            </Button>
          )}
        </div>
      ),
    };
  } else if (state === 'empty') {
    const hasPrevious = activePaging.index > 0;
    if (hasPrevious) {
      notice = {
        title: 'This page is empty',
        body: 'This page is empty. Go back to the previous page.',
        action: (
          <Button variant="secondary" onClick={previous}>
            Previous
          </Button>
        ),
      };
    } else if (filter.param) {
      notice = {
        title: 'No broadcasts match this status',
        body: `There are no broadcasts with the ${filter.label.toLowerCase()} status.`,
        action: (
          <Button variant="secondary" onClick={clearFilter}>
            Clear filter
          </Button>
        ),
      };
    } else {
      notice = {
        title: 'No broadcasts yet',
        body: canWrite
          ? 'Create an e-mail send to a segment. Agents can draft broadcasts too.'
          : 'A builder can create your first broadcast.',
        action: canWrite ? (
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
            New broadcast
          </Button>
        ) : undefined,
      };
    }
  } else if (state === 'ready' && list.error) {
    notice = {
      title: 'Couldn’t refresh broadcasts',
      body: `${list.error} Showing the last loaded page.`,
    };
  }
  if (unknown && state !== 'error' && state !== 'restricted' && state !== 'loading') {
    notice = {
      title: 'That status filter is not recognised',
      body: 'Showing all broadcasts instead.',
    };
  }

  const countLabel =
    state === 'restricted' || (state === 'error' && !loadedPage)
      ? undefined
      : loadedPage && currentPage
        ? broadcastCountLabel(currentPage.total)
        : undefined;
  const start = activePaging.index * PAGE_SIZE + 1;
  const end = start + rows.length - 1;

  return (
    <>
      <ListPage
        title="Broadcasts"
        description="One-off e-mails to a segment, reviewed before they go out."
        primaryAction={
          canWrite &&
          canRead && (
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
              New broadcast
            </Button>
          )
        }
        filters={
          <>
            <Select
              compact
              aria-label="Broadcast status"
              value={filter.key}
              onChange={(e) => changeFilter(e.target.value)}
              disabled={pageBusy}
              className="w-auto"
            >
              {BROADCAST_STATUS_FILTERS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} loading={list.refreshing} onClick={refresh}>
              Refresh
            </Button>
          </>
        }
        countLabel={countLabel}
        state={state}
        notice={notice}
        loadingContent={
          <div>
            {Array.from({ length: 5 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: loading placeholders are generated, never reordered, and have no identity
              <div key={i} className="flex gap-4 border-b border-line px-4 py-4 last:border-0 md:py-3">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-4 w-1/6" />
                <Skeleton className="h-4 w-1/6" />
                <Skeleton className="h-4 w-1/6" />
              </div>
            ))}
          </div>
        }
        desktopTable={
          <table className="w-full border-collapse text-left text-[13px] leading-5">
            <caption className="px-4 py-3 text-left text-[12px] leading-[18px] text-muted">
              Broadcasts{asOf ? ` · as of ${asOf}` : ''}
            </caption>
            <colgroup className="hidden lg:table-column-group">
              <col className="w-[35%]" />
              <col className="w-[13%]" />
              <col className="w-[16%]" />
              <col className="w-[20%]" />
              <col className="w-[16%]" />
            </colgroup>
            <thead className="bg-surface-2 text-muted">
              <tr>
                <th scope="col" className="h-9 px-4 text-left font-medium">
                  Broadcast
                </th>
                <th scope="col" className="h-9 px-4 text-left font-medium">
                  State
                </th>
                <th scope="col" className="hidden h-9 px-4 text-left font-medium lg:table-cell">
                  Audience
                </th>
                <th scope="col" className="h-9 px-4 text-left font-medium">
                  Schedule
                </th>
                <th scope="col" className="hidden h-9 px-4 text-left font-medium lg:table-cell">
                  Result
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <BroadcastRow key={row.artifactId} row={row} segmentName={segmentName(row)} />
              ))}
            </tbody>
          </table>
        }
        mobileList={
          <div>
            <p className="border-b border-line px-4 py-3 text-[12px] leading-[18px] text-muted">
              Broadcasts{asOf ? ` · as of ${asOf}` : ''}
            </p>
            <ul className="divide-y divide-line" aria-label="Broadcasts">
              {rows.map((row) => (
                <BroadcastMobileRow key={row.artifactId} row={row} segmentName={segmentName(row)} />
              ))}
            </ul>
          </div>
        }
        pagination={
          <div className="flex flex-wrap items-center gap-2 text-[12px] leading-[18px] text-muted">
            <span className="mr-auto tabular-nums" aria-live="polite">
              {start}–{end} of {data?.total.toLocaleString('en-US')} {data?.total === 1 ? 'broadcast' : 'broadcasts'}
            </span>
            <Button size="sm" variant="secondary" disabled={pageBusy || activePaging.index === 0} onClick={previous}>
              Previous
            </Button>
            <Button size="sm" variant="secondary" disabled={pageBusy || !loadedPage || !currentPage?.nextCursor} onClick={next}>
              Next
            </Button>
          </div>
        }
      />
      {creating && <CreateBroadcastDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function NameCell({ row, segmentName }: { row: BroadcastListRow; segmentName: string | null | undefined }) {
  const audience = broadcastAudienceOf(row, segmentName);
  const to = artifactPath('broadcast', row.artifactId);
  return (
    <td className="px-4 py-3 align-top">
      <Link to={to} className="font-medium text-fg hover:underline">
        {row.name}
      </Link>
      <div className="mt-0.5 text-[12px] leading-[18px] text-muted">{broadcastSubtitleOf(row)}</div>
      <div className="mt-1 hidden text-[12px] leading-[18px] text-muted md:block lg:hidden">
        {audience.name}
        {audience.detail ? ` · ${audience.detail}` : ''}
      </div>
    </td>
  );
}

function ScheduleCell({ row, includeResult }: { row: BroadcastListRow; includeResult: boolean }) {
  const schedule = broadcastScheduleOf(row);
  const result = broadcastResultOf(row);
  return (
    <td className="px-4 py-3 align-top text-fg-2">
      <div>{schedule.lines[0]}</div>
      {schedule.lines.slice(1).map((line) => (
        <div key={line} className="mt-0.5 text-[12px] leading-[18px] text-muted">
          {line}
        </div>
      ))}
      {includeResult && (
        <div
          className={
            result.tone === 'warn'
              ? 'mt-1 hidden text-[12px] leading-[18px] text-warn md:block lg:hidden'
              : 'mt-1 hidden text-[12px] leading-[18px] text-muted md:block lg:hidden'
          }
        >
          {result.lines.join(' · ')}
        </div>
      )}
    </td>
  );
}

function ResultCell({ row }: { row: BroadcastListRow }) {
  const result = broadcastResultOf(row);
  return (
    <>
      {result.lines.map((line) => (
        <div key={line} className="tabular-nums">
          {line}
        </div>
      ))}
    </>
  );
}

function BroadcastRow({ row, segmentName }: { row: BroadcastListRow; segmentName: string | null | undefined }) {
  const to = artifactPath('broadcast', row.artifactId);
  const state = broadcastStateOf(row);
  const audience = broadcastAudienceOf(row, segmentName);
  return (
    <tr
      className="cursor-pointer border-t border-line hover:bg-surface-2"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a,button')) return;
        navigate(to);
      }}
    >
      <NameCell row={row} segmentName={segmentName} />
      <td className="px-4 py-3 align-top">
        <BroadcastStatePill state={state} />
      </td>
      <td className="hidden px-4 py-3 align-top text-fg-2 lg:table-cell">
        <div>{audience.name}</div>
        {audience.detail && <div className="mt-0.5 text-[12px] leading-[18px] text-muted">{audience.detail}</div>}
        {!segmentName && <Identifier value={row.segmentId} label="Segment ID" className="mt-1" />}
      </td>
      <ScheduleCell row={row} includeResult />
      <td className="hidden px-4 py-3 align-top lg:table-cell">
        <ResultCell row={row} />
      </td>
    </tr>
  );
}

function BroadcastMobileRow({ row, segmentName }: { row: BroadcastListRow; segmentName: string | null | undefined }) {
  const to = artifactPath('broadcast', row.artifactId);
  const state = broadcastStateOf(row);
  const audience = broadcastAudienceOf(row, segmentName);
  const schedule = broadcastScheduleOf(row);
  const result = broadcastResultOf(row);
  return (
    <li className="min-h-[72px] px-4 py-4">
      <div className="flex min-h-8 items-start gap-3">
        <div className="min-w-0 grow">
          <Link to={to} className="font-medium text-fg hover:underline">
            {row.name}
          </Link>
          <div className="mt-1 text-[12px] leading-[18px] text-muted">{broadcastSubtitleOf(row)}</div>
        </div>
        <BroadcastStatePill state={state} />
      </div>
      <div className="mt-2 text-[13px] leading-5 text-fg-2">
        {audience.name} · {schedule.lines[0]}
      </div>
      <Link
        to={to}
        className={
          result.tone === 'warn' ? 'mt-1 block text-[12px] leading-[18px] text-warn' : 'mt-1 block text-[12px] leading-[18px] text-muted'
        }
      >
        {result.lines.join(' · ')}
      </Link>
    </li>
  );
}

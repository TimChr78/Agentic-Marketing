import { RefreshCw, Upload } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import { ButtonLink } from '../../app/links';
import { useCrumbs } from '../../app/page';
import { Link, navigate } from '../../app/router';
import { useSession } from '../../app/session';
import { usePageTab } from '../../app/useTab';
import { CopyPersonId } from '../../features/audience/phase26/CopyControl';
import { availabilityLabel, listIdentity, purposeRows, shownLabel } from '../../features/audience/phase26/model';
import { PurposeConsentList } from '../../features/audience/phase26/PurposeConsent';
import { usePurposes } from '../../features/audience/phase26/usePurposes';
import {
  Alert,
  Button,
  DetailSkeleton,
  EmptyState,
  IconButton,
  Input,
  ListSkeleton,
  Table,
  Tabs,
  Td,
  THead,
  Th,
  Tr,
  timeAgo,
} from '../../ui';
import { ListPage } from '../../ui/ListPage';
import { pageWidth } from '../../ui/layout';

// The Imports tab is its own screen; load it only when opened so the People list stays light.
const ImportsPage = lazy(() => import('./ImportsPage'));

const PAGE_SIZE = 50;
const PROFILE_ID = /^prf_[0-9a-f]{32}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type ProfilePage = Out<'profiles.list'>;

function PersonCell({ row, canSeePii }: { row: ProfilePage['profiles'][number]; canSeePii: boolean }) {
  const identity = listIdentity(row, canSeePii);
  return (
    <div className="min-w-0">
      <Link
        to={`/audience/people/${row.id}`}
        onClick={(e) => e.stopPropagation()}
        className="font-medium break-all text-fg hover:underline"
        data-volatile
      >
        {identity.email}
      </Link>
      {identity.name && (
        <div className="mt-0.5 text-[12px] leading-[18px] text-muted" data-volatile>
          {identity.name}
        </div>
      )}
      <div className="mt-0.5">
        <CopyPersonId id={row.id} />
      </div>
    </div>
  );
}

function ConsentCell({ row, purposes }: { row: ProfilePage['profiles'][number]; purposes: Parameters<typeof purposeRows>[1] }) {
  return <PurposeConsentList rows={purposeRows(row.consent, purposes)} />;
}

function PeopleSkeleton() {
  // The ready table has three columns; the shared list geometry keeps the header and row heights.
  return <ListSkeleton label="Loading people" columns={3} />;
}

/** People known to the workspace: one loaded page at a time, with consent beside every purpose. */
export function PeopleList() {
  useCrumbs([{ label: 'People' }]);
  const { can } = useSession();
  const canRead = can('profiles:read');
  const canSeePii = can('profiles:pii');
  const canWrite = can('profiles:write');
  const canReadPurposes = can('artifacts:read');

  const [pages, setPages] = useState<ProfilePage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(canRead);
  const [error, setError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const listHeading = useRef<HTMLHeadingElement>(null);
  const generation = useRef(0);
  const pageIndexRef = useRef(0);
  const pagination = useRef(0);

  const loadFirst = useCallback(async () => {
    if (!canRead) return;
    const gen = ++generation.current;
    // A refresh cancels any page request that is still in flight.
    pagination.current += 1;
    setLoadingPage(false);
    // A refresh clears the loaded pages: old rows are never presented as the current page.
    setPages([]);
    pageIndexRef.current = 0;
    setPageIndex(0);
    setLoading(true);
    setError(null);
    setPageError(null);
    try {
      const page = await api.call('profiles.list', { limit: PAGE_SIZE });
      if (gen !== generation.current) return;
      setPages([page]);
    } catch (e) {
      if (gen !== generation.current) return;
      setError(errText(e));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [canRead]);

  // Load the first page before purposes, so a mount with both permissions is exactly two reads.
  useEffect(() => {
    void loadFirst();
    return () => {
      generation.current += 1;
    };
  }, [loadFirst]);

  const purposes = usePurposes({ enabled: canRead && canReadPurposes, always: true });

  if (!canRead) {
    return (
      <div className={pageWidth('default')}>
        <EmptyState title="Restricted by your role">
          Restricted by your role. No protected reads were made. Ask a workspace administrator for access.
        </EmptyState>
      </div>
    );
  }

  const current = pages[pageIndex];
  const rows = current?.profiles ?? [];
  const hasNext = Boolean(current?.nextCursor);
  const emptyFirst = rows.length === 0 && pageIndex === 0 && !loading && !error;

  const moveTo = (index: number) => {
    // Moving within the loaded stack cancels any page request still in flight.
    pagination.current += 1;
    setLoadingPage(false);
    pageIndexRef.current = index;
    setPageIndex(index);
    const count = pages[index]?.profiles.length ?? 0;
    setAnnouncement(`${count} shown, page ${index + 1}`);
    // Pagination moves focus to the list heading after a successful page change.
    queueMicrotask(() => listHeading.current?.focus());
  };

  const back = () => {
    if (pageIndex === 0) return;
    setPageError(null);
    moveTo(pageIndex - 1);
  };

  const retryFirst = async () => {
    await loadFirst();
    // Retry keeps the person oriented: focus returns to the list heading after the reread.
    queueMicrotask(() => listHeading.current?.focus());
  };

  const next = async () => {
    if (!current?.nextCursor || loadingPage) return;
    if (pageIndex + 1 < pages.length) {
      setPageError(null);
      moveTo(pageIndex + 1);
      return;
    }
    setPageError(null);
    const gen = generation.current;
    const origin = pageIndex;
    const token = ++pagination.current;
    setLoadingPage(true);
    try {
      const page = await api.call('profiles.list', {
        limit: PAGE_SIZE,
        before: current.nextCursor.lastSeen,
        beforeId: current.nextCursor.id,
      });
      // A refresh, a page move or a newer page request owns the stack now; this response is stale.
      if (gen !== generation.current || pageIndexRef.current !== origin || token !== pagination.current) return;
      const target = origin + 1;
      setPages((loaded) => [...loaded, page]);
      pageIndexRef.current = target;
      setPageIndex(target);
      setAnnouncement(`${page.profiles.length} shown, page ${target + 1}`);
      queueMicrotask(() => listHeading.current?.focus());
    } catch (e) {
      if (gen !== generation.current || pageIndexRef.current !== origin || token !== pagination.current) return;
      setPageError(errText(e));
    } finally {
      if (token === pagination.current) setLoadingPage(false);
    }
  };

  const find = async () => {
    const value = query.trim();
    if (!value) return;
    setSearchError(null);
    if (PROFILE_ID.test(value)) {
      navigate(`/audience/people/${value}`);
      return;
    }
    if (!EMAIL.test(value)) {
      setSearchError('Enter an e-mail address, or paste a profile id (prf_…).');
      return;
    }
    setSearching(true);
    try {
      const result = await api.call('profiles.find', { type: 'email', value });
      if (!result.profileId) {
        setSearchError('No one has that e-mail. Check the address, or paste their profile id.');
        return;
      }
      navigate(`/audience/people/${result.profileId}`);
    } catch (e) {
      setSearchError(errText(e));
    } finally {
      setSearching(false);
    }
  };

  const state = loading ? 'loading' : error ? 'error' : rows.length === 0 ? 'empty' : 'ready';
  const count = rows.length;
  const notice = error
    ? {
        title: 'Couldn’t load people',
        body: `${error} No old values are shown as current.`,
        action: (
          <Button variant="secondary" onClick={() => void retryFirst()}>
            Retry
          </Button>
        ),
      }
    : emptyFirst
      ? {
          title: 'No people yet',
          body: 'People appear when your site, a form or an integration identifies them. Import an existing subscriber list, or add a signup form so new people arrive with their consent.',
          action: canWrite && (
            <ButtonLink to="/audience/people?tab=imports" variant="primary" icon={<Upload size={15} />}>
              Import people
            </ButtonLink>
          ),
        }
      : {
          title: 'List changed',
          body: 'This page is empty because the list changed. Return to the first page to see the current rows.',
          action: (
            <Button variant="secondary" onClick={() => moveTo(0)}>
              Return to first page
            </Button>
          ),
        };

  return (
    <ListPage
      title="People"
      description="Everyone this workspace has seen, most recent activity first, with their consent for each purpose."
      primaryAction={
        canWrite && (
          <ButtonLink to="/audience/people?tab=imports" variant="primary" icon={<Upload size={15} />}>
            Import people
          </ButtonLink>
        )
      }
      filters={
        <>
          <h2 ref={listHeading} tabIndex={-1} className="sr-only">
            People list
          </h2>
          <span role="status" aria-live="polite" className="sr-only">
            {announcement}
          </span>
          <form
            className="flex min-w-0 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void find();
            }}
          >
            <label htmlFor="people-find-email" className="sr-only">
              E-mail or profile ID
            </label>
            <Input
              id="people-find-email"
              type="text"
              compact
              placeholder="E-mail or profile ID"
              className="w-[260px] min-w-[200px] max-w-full"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button size="sm" type="submit" loading={searching}>
              Find person
            </Button>
          </form>
          <IconButton label="Refresh people" icon={<RefreshCw size={14} />} onClick={() => void loadFirst()} />
          {searchError && (
            <span role="alert" className="basis-full text-[12px] leading-[18px] text-bad">
              {searchError}
            </span>
          )}
          {canReadPurposes && purposes.error && (
            <span role="status" className="basis-full text-[12px] leading-[18px] text-muted">
              Purpose names could not load; consent is shown without names.{' '}
              <button type="button" className="underline" onClick={() => void purposes.reload()}>
                Retry purpose names
              </button>
            </span>
          )}
        </>
      }
      countLabel={state === 'ready' ? shownLabel(count, pageIndex + 1) : undefined}
      state={state}
      notice={state === 'ready' ? undefined : notice}
      loadingContent={<PeopleSkeleton />}
      pagination={
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={back} disabled={pageIndex === 0}>
            Previous
          </Button>
          <Button onClick={() => void next()} loading={loadingPage} disabled={!hasNext}>
            Next
          </Button>
          <span className="text-[12px] leading-[18px] text-muted">{availabilityLabel(hasNext)}</span>
          {pageError && (
            <span role="alert" className="text-[12px] leading-[18px] text-bad">
              {pageError}
            </span>
          )}
        </div>
      }
      desktopTable={
        <Table label="People">
          <THead>
            <tr>
              <Th>Person</Th>
              <Th>Consent per purpose</Th>
              <Th>Last seen</Th>
            </tr>
          </THead>
          <tbody>
            {rows.map((row) => (
              <Tr key={row.id} href={`/audience/people/${row.id}`} onClick={() => navigate(`/audience/people/${row.id}`)}>
                <Td>
                  <PersonCell row={row} canSeePii={canSeePii} />
                </Td>
                <Td>
                  <ConsentCell row={row} purposes={purposes.data?.purposes} />
                </Td>
                <Td className="whitespace-nowrap" title={row.lastSeen}>
                  <span data-volatile>{timeAgo(row.lastSeen)}</span>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      }
      mobileList={
        <ul aria-label="People">
          {rows.map((row) => (
            <li key={row.id} className="border-b border-line p-4 last:border-0">
              <PersonCell row={row} canSeePii={canSeePii} />
              <div className="mt-2">
                <ConsentCell row={row} purposes={purposes.data?.purposes} />
              </div>
              <div className="mt-2 text-[12px] leading-[18px] text-muted">
                Last seen{' '}
                <span title={row.lastSeen} data-volatile>
                  {timeAgo(row.lastSeen)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      }
    />
  );
}

const PEOPLE_TABS = ['people', 'imports'] as const;
type PeopleTab = (typeof PEOPLE_TABS)[number];

const PEOPLE_TAB_ITEMS: { key: PeopleTab; label: string }[] = [
  { key: 'people', label: 'People' },
  { key: 'imports', label: 'Imports' },
];

/**
 * People (#446, #510): profiles browsing and the existing import flow as one page with named tabs.
 * Imports still needs profiles:write; a write-only role may open the explicit tab without being
 * able to browse people. A forbidden tab renders a restricted state and does not fetch its data.
 */
export default function PeoplePage() {
  const { can } = useSession();
  const { active, forbidden, invalid, select } = usePageTab({
    keys: PEOPLE_TABS,
    fallback: 'people',
    allowed: (tab) => (tab === 'people' ? can('profiles:read') : can('profiles:write')),
  });
  useCrumbs([{ label: active === 'imports' ? 'Imports' : 'People' }]);

  return (
    <div className={pageWidth('default')}>
      {invalid && (
        <Alert tone="info" className="mb-4">
          This tab is unavailable.
        </Alert>
      )}
      <Tabs items={PEOPLE_TAB_ITEMS} value={active} onChange={select} label="People">
        {forbidden ? (
          <EmptyState title="Your role can't open this tab">
            {forbidden === 'imports'
              ? 'Your role cannot open this tab. Ask a workspace admin to give you permission to import people.'
              : 'Your role cannot open this tab. Ask a workspace admin to give you permission to browse people.'}
          </EmptyState>
        ) : active === 'imports' ? (
          <Suspense fallback={<DetailSkeleton label="Loading imports" />}>
            <ImportsPage />
          </Suspense>
        ) : (
          <PeopleList />
        )}
      </Tabs>
    </div>
  );
}

import { Plus, Search } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { api, errText } from '../../../app/api';
import { artifactPath } from '../../../app/artifactRoutes';
import { parseCreateIntent } from '../../../app/createIntent';
import { useCrumbs } from '../../../app/page';
import { Link, navigate, setSearchParam, useLocation } from '../../../app/router';
import { useSession } from '../../../app/session';
import { useApi } from '../../../app/useApi';
import { publicationLabel, stateOfArtifact } from '../../../lib/state';
import { Alert, Button, Field, Input, ListSkeleton, Modal, Select, Table, Td, THead, Th, Tr, timeAgo, useToast } from '../../../ui';
import { ListPage, type PageReadState } from '../../../ui/ListPage';
import { OperationalPill } from '../../../ui/state';
import { notifyArtifactsChanged } from '../../artifactCache';
import { type ArtifactRow, fetchAllArtifacts } from '../../artifacts/artifactList';
import { GallerySkeleton, PhoneListSkeleton } from '../../phase28/content/GallerySkeleton';

export interface ContentCreateSpec {
  label: string;
  /** Extra fields shown in the create dialog, e.g. a block category. */
  fields?: (state: Record<string, string>, set: (state: Record<string, string>) => void, errors: Record<string, string>) => ReactNode;
  initial?: Record<string, string>;
  /** The draft content to create. */
  content: (name: string, state: Record<string, string>) => unknown;
}

/**
 * The Content family's list surface (Phase 27, #526). Templates and Assets are thumbnail-led;
 * Blocks use a comparison table. One primary action, a name search and a publication filter; no
 * table/gallery switch. Reads every page of one artifact type once and never fetches a detail row.
 */
export function ContentList({
  type,
  title,
  description,
  noun,
  layout,
  crumb,
  emptyTitle,
  emptyText,
  create,
}: {
  type: string;
  title: string;
  description: ReactNode;
  /** Plural noun for the count, e.g. "templates". */
  noun: string;
  layout: 'gallery' | 'table';
  crumb?: string;
  emptyTitle: string;
  emptyText: ReactNode;
  create: ContentCreateSpec;
}) {
  useCrumbs([{ label: crumb ?? title }]);
  const { can } = useSession();
  const canRead = can('artifacts:read');
  const list = useApi(() => fetchAllArtifacts(type), [type], { skip: !canRead });
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [creating, setCreating] = useState(false);
  const rows = useMemo(
    () =>
      (list.data?.artifacts ?? []).filter(
        (a) =>
          (!q || a.name.toLowerCase().includes(q.toLowerCase())) &&
          (!state || (state === 'live' ? a.publishedVersion !== null : a.latestState === state)),
      ),
    [list.data, q, state],
  );
  const total = list.data?.total ?? 0;
  const loaded = list.data?.artifacts.length ?? 0;
  const canCreate = can('artifacts:write');
  const { search } = useLocation();
  const intent = parseCreateIntent(search);

  // The New menu and palette only navigate; this page opens its existing dialog once and consumes
  // `create` with replace, so a reload never reopens it or duplicates a draft.
  useEffect(() => {
    if (!canCreate || intent !== type) return;
    setCreating(true);
    setSearchParam('create', null);
  }, [canCreate, intent, type]);

  const filtered = !!q || !!state;
  const pageState: PageReadState = !canRead
    ? 'restricted'
    : list.loading
      ? 'loading'
      : list.error
        ? 'error'
        : rows.length === 0
          ? 'empty'
          : 'ready';
  const countLabel =
    list.data && rows.length > 0
      ? list.data.complete
        ? filtered
          ? `${rows.length} of ${total} ${noun}`
          : `${total} ${noun}`
        : `${loaded} of ${total} loaded`
      : undefined;

  const emptyNotice = filtered
    ? {
        title: 'Nothing matches',
        body: 'Clear the search or choose another publication state.',
        action: (
          <Button
            onClick={() => {
              setQ('');
              setState('');
            }}
          >
            Clear filters
          </Button>
        ),
      }
    : {
        title: emptyTitle,
        body: emptyText,
        action: canCreate ? (
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
            {create.label}
          </Button>
        ) : undefined,
      };

  return (
    <>
      <ListPage
        title={title}
        description={description}
        primaryAction={
          canCreate && (
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
              {create.label}
            </Button>
          )
        }
        filters={
          <>
            <div className="relative w-full max-w-[280px]">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" aria-hidden />
              <Input
                compact
                aria-label={`Search ${noun}`}
                placeholder="Search by name"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-8"
              />
            </div>
            <Select compact aria-label="Publication state" value={state} onChange={(e) => setState(e.target.value)} className="w-auto">
              <option value="">All publications</option>
              <option value="live">Published</option>
              <option value="draft">Draft</option>
              <option value="in_review">In review</option>
              <option value="rejected">Rejected</option>
            </Select>
          </>
        }
        countLabel={countLabel}
        state={pageState}
        notice={
          pageState === 'error'
            ? { title: `Couldn’t load ${noun}`, body: list.error, action: <Button onClick={() => void list.reload()}>Retry</Button> }
            : pageState === 'restricted'
              ? { title: 'Restricted access', body: 'Your role can’t open Content. Ask a workspace admin for artifacts:read.' }
              : pageState === 'empty'
                ? emptyNotice
                : undefined
        }
        loadingContent={<ContentSkeleton layout={layout} noun={noun} />}
        desktopTable={layout === 'gallery' ? <Gallery rows={rows} title={title} /> : <BlockTable rows={rows} title={title} total={total} />}
        mobileList={<PhoneList rows={rows} title={title} />}
      />
      {creating && <CreateDialog type={type} spec={create} onClose={() => setCreating(false)} />}
    </>
  );
}

function Gallery({ rows, title }: { rows: ArtifactRow[]; title: string }) {
  return (
    <ul aria-label={`${title} gallery`} className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-3 md:p-4">
      {rows.map((a) => (
        <li key={a.id}>
          <Link
            to={artifactPath(a.type, a.id)}
            className="flex h-full flex-col overflow-hidden rounded-lg border border-line bg-surface text-left transition-colors hover:border-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {/* A neutral local thumbnail with the name, never a render of every template. */}
            <span className="flex h-[116px] items-center justify-center bg-surface-2 px-4 text-center text-[12px] leading-[18px] text-muted">
              {a.name}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1.5 px-3 py-2.5">
              <span className="truncate text-[13px] font-medium text-fg" title={a.name}>
                {a.name}
              </span>
              <span className="text-[12px] leading-[18px] text-muted">
                {publicationLabel({ latestVersion: a.latestVersion, publishedVersion: a.publishedVersion })}
              </span>
              <span className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                <OperationalPill
                  state={stateOfArtifact({
                    type: a.type,
                    latestState: a.latestState,
                    latestVersion: a.latestVersion,
                    publishedVersion: a.publishedVersion,
                  })}
                />
                <span className="text-[11px] text-muted">{timeAgo(a.updatedAt)}</span>
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function BlockTable({ rows, title, total }: { rows: ArtifactRow[]; title: string; total: number }) {
  return (
    <Table label={title}>
      <caption className="px-4 pt-3 pb-2 text-left text-[12px] text-muted">
        {rows.length === total ? `${total} total` : `${rows.length} of ${total} shown`}
      </caption>
      <THead>
        <tr>
          <Th>Name</Th>
          <Th>Publication</Th>
          <Th>Operational state</Th>
          <Th>Updated</Th>
        </tr>
      </THead>
      <tbody>
        {rows.map((a) => (
          <Tr key={a.id} onClick={() => navigate(artifactPath(a.type, a.id))}>
            <Td>
              <Link to={artifactPath(a.type, a.id)} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
                {a.name}
              </Link>
            </Td>
            <Td className="whitespace-nowrap">
              {publicationLabel({ latestVersion: a.latestVersion, publishedVersion: a.publishedVersion })}
            </Td>
            <Td>
              <OperationalPill
                state={stateOfArtifact({
                  type: a.type,
                  latestState: a.latestState,
                  latestVersion: a.latestVersion,
                  publishedVersion: a.publishedVersion,
                })}
              />
            </Td>
            <Td className="whitespace-nowrap">{timeAgo(a.updatedAt)}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

function PhoneList({ rows, title }: { rows: ArtifactRow[]; title: string }) {
  return (
    <ul aria-label={`${title} list`} className="divide-y divide-line">
      {rows.map((a) => (
        <li key={a.id}>
          <Link to={artifactPath(a.type, a.id)} className="block min-h-[72px] px-4 py-3">
            <span className="flex items-start justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-fg">{a.name}</span>
              <OperationalPill
                state={stateOfArtifact({
                  type: a.type,
                  latestState: a.latestState,
                  latestVersion: a.latestVersion,
                  publishedVersion: a.publishedVersion,
                })}
              />
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-[18px] text-muted">
              <span>{publicationLabel({ latestVersion: a.latestVersion, publishedVersion: a.publishedVersion })}</span>
              <span>{timeAgo(a.updatedAt)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ContentSkeleton({ layout, noun }: { layout: 'gallery' | 'table'; noun: string }) {
  // The shared primitives reserve the ready template's geometry; the label names the object
  // instead of a generic "Loading" (Phase 28, #559). Below 768 px the ready list is the compact
  // 72 px summary list for both layouts, so the phone placeholder reserves that geometry rather
  // than the six 170 px gallery tiles (#555 review).
  return (
    <>
      <PhoneListSkeleton label={`Loading ${noun}`} />
      <div className="hidden md:block">
        {layout === 'table' ? <ListSkeleton label={`Loading ${noun}`} columns={4} /> : <GallerySkeleton label={`Loading ${noun}`} />}
      </div>
    </>
  );
}

function CreateDialog({ type, spec, onClose }: { type: string; spec: ContentCreateSpec; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, string>>(spec.initial ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setErrors({});
    if (!name.trim()) setNameError('Give it a name people will recognise.');
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.call('artifacts.create', { type: type as never, name: name.trim(), content: spec.content(name.trim(), state) });
      notifyArtifactsChanged();
      toast.success(`Created “${name.trim()}” as a draft.`);
      onClose();
      navigate(artifactPath(type, r.artifactId));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={spec.label}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" mutation loading={busy} onClick={submit}>
            Create draft
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" error={nameError} hint="Shown to reviewers and agents." required>
          <Input
            value={name}
            data-autofocus
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            onBlur={() => !name.trim() && setNameError('Give it a name people will recognise.')}
            maxLength={120}
          />
        </Field>
        {spec.fields?.(state, setState, errors)}
        {error && <Alert tone="bad">{error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

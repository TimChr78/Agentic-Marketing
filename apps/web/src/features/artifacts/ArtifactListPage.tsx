import { Plus, Search } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { api, errText } from '../../app/api';
import { artifactPath } from '../../app/artifactRoutes';
import { parseCreateIntent } from '../../app/createIntent';
import { useCrumbs } from '../../app/page';
import { Link, navigate, setSearchParam, useLocation } from '../../app/router';
import { useSession } from '../../app/session';
import { publicationLabel, stateOfArtifact } from '../../lib/state';
import {
  Alert,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Table,
  TableFrame,
  Td,
  THead,
  Th,
  Tr,
  timeAgo,
  useToast,
} from '../../ui';
import { pageWidth } from '../../ui/layout';
import { OperationalPill } from '../../ui/state';
import { type ArtifactRow, useAllArtifacts } from './artifactList';

export type { ArtifactRow } from './artifactList';

export interface CreateSpec<S> {
  /** Label of the primary action, e.g. "New journey". */
  label: string;
  /** Extra fields beyond the name (e.g. template and segment of a broadcast). */
  initial?: S;
  fields?: (state: S, set: (s: S) => void, errors: Record<string, string>) => ReactNode;
  /** Field errors before submitting; empty when valid. */
  validate?: (state: S) => Record<string, string>;
  /** The draft content to create. */
  content: (name: string, state: S) => unknown;
  /** Create differently, e.g. a command that also copies members; defaults to artifacts.create with `content`. */
  create?: (name: string, state: S) => Promise<{ artifactId: string }>;
  defaultName?: string;
}

/**
 * A list of one artifact type (DESIGN.md → Layout): title and primary action, a search and state
 * filter, then the table with loading, error and empty states.
 */
export function ArtifactListPage<S = Record<string, never>>({
  type,
  title,
  description,
  crumb,
  create,
  emptyTitle,
  emptyText,
  columns,
  rowState,
  rowHref,
}: {
  type: string;
  title: string;
  description: ReactNode;
  crumb?: string;
  create?: CreateSpec<S>;
  emptyTitle: string;
  emptyText: ReactNode;
  /** Extra columns after the name. */
  columns?: { header: string; cell: (a: ArtifactRow) => ReactNode; className?: string }[];
  /** A family-specific operational pill (a broadcast reads its run); defaults to the artifact state. */
  rowState?: (a: ArtifactRow) => ReactNode;
  /** A family-specific destination (the journey reports view selects the Report tab). */
  rowHref?: (a: ArtifactRow) => string;
}) {
  useCrumbs([{ label: crumb ?? title }]);
  const { can } = useSession();
  const list = useAllArtifacts(type);
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
  const canCreate = !!create && can('artifacts:write');
  const href = (a: ArtifactRow) => rowHref?.(a) ?? artifactPath(a.type, a.id);
  const { search } = useLocation();
  const intent = parseCreateIntent(search);

  // The New menu and palette only navigate; this page opens its existing dialog once and consumes
  // `create` with replace, so a reload never reopens it or duplicates a draft.
  useEffect(() => {
    if (!create || !canCreate || intent !== type) return;
    setCreating(true);
    setSearchParam('create', null);
  }, [create, canCreate, intent, type]);

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title={title}
        description={description}
        actions={
          canCreate && (
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
              {create!.label}
            </Button>
          )
        }
      />
      <TableFrame
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        isEmpty={rows.length === 0}
        toolbar={
          total > 0 && (
            <>
              <div className="relative w-full max-w-[280px]">
                <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" aria-hidden />
                <Input
                  compact
                  aria-label={`Search ${title.toLowerCase()}`}
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
              <span className="ml-auto text-[12px] text-muted">
                {list.data && !list.data.complete
                  ? `${loaded} of ${total} loaded`
                  : rows.length === total
                    ? `${total} total`
                    : `${rows.length} of ${total}`}
              </span>
            </>
          )
        }
        empty={
          total === 0 ? (
            <EmptyState
              title={emptyTitle}
              action={
                canCreate && (
                  <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
                    {create!.label}
                  </Button>
                )
              }
            >
              {emptyText}
            </EmptyState>
          ) : (
            <EmptyState compact title="Nothing matches">
              Clear the search or choose another state.
            </EmptyState>
          )
        }
      >
        <Table label={title}>
          <THead>
            <tr>
              <Th>Name</Th>
              {columns?.map((c) => (
                <Th key={c.header} className={c.className}>
                  {c.header}
                </Th>
              ))}
              <Th>Operational state</Th>
              <Th>Updated</Th>
            </tr>
          </THead>
          <tbody>
            {rows.map((a) => (
              <Tr key={a.id} onClick={() => navigate(href(a))}>
                <Td>
                  <Link to={href(a)} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
                    {a.name}
                  </Link>
                  <div className="mt-0.5 text-[12px] leading-[18px] text-muted">
                    {publicationLabel({ latestVersion: a.latestVersion, publishedVersion: a.publishedVersion })}
                  </div>
                </Td>
                {columns?.map((c) => (
                  <Td key={c.header} className={c.className}>
                    {c.cell(a)}
                  </Td>
                ))}
                <Td>
                  {rowState ? (
                    rowState(a)
                  ) : (
                    <OperationalPill
                      state={stateOfArtifact({
                        type: a.type,
                        latestState: a.latestState,
                        latestVersion: a.latestVersion,
                        publishedVersion: a.publishedVersion,
                      })}
                    />
                  )}
                </Td>
                <Td className="whitespace-nowrap">{timeAgo(a.updatedAt)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>
      {create && creating && <CreateDialog type={type} spec={create} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateDialog<S>({ type, spec, onClose }: { type: string; spec: CreateSpec<S>; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(spec.defaultName ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [state, setState] = useState<S>(spec.initial ?? ({} as S));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const e = spec.validate?.(state) ?? {};
    setErrors(e);
    if (!name.trim()) setNameError('Give it a name people will recognise.');
    if (!name.trim() || Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const r = spec.create
        ? await spec.create(name.trim(), state)
        : await api.call('artifacts.create', { type: type as never, name: name.trim(), content: spec.content(name.trim(), state) });
      toast.success(`Created “${name.trim()}” as a draft.`);
      onClose();
      navigate(artifactPath(type, r.artifactId));
    } catch (err) {
      setError(errText(err));
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
          <Button variant="primary" loading={busy} onClick={submit}>
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
